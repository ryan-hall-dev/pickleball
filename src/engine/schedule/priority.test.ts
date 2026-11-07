// @vitest-environment node
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  projectedSessionRates,
  projectSnapshot,
  saturate,
  scoreSnapshot,
  scoreWaitingPlayers,
  sessionRates,
  sharedPriorityDrift,
  waitingPriorityUpperBound,
  snapshotAtNow,
  type ScoringContext,
} from "./priority";
import {
  TEST_SLOT_MS,
  makeInput,
  makePlayer,
  preferencesWithFirst,
  testCourtId,
  testPlayerId as id,
} from "./testing/scheduleFixtures";
import type { SchedulePlayer } from "./types";
import {
  DEFAULT_SCORING_WEIGHTS,
  HOST_OVERRIDE_POINTS_PER_POSITION,
  REST_CAP_SLOTS,
  resolveScoringWeights,
} from "./weights";
import { DEFAULT_SIMULATION_PREFERENCES } from "./simulation/simulateSession";

const DEFAULT_WEIGHTS = resolveScoringWeights(DEFAULT_SIMULATION_PREFERENCES);

describe("saturate", () => {
  it("is odd, bounded by ±cap, and close to linear near zero", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: 0.1, max: 10, noNaN: true }),
        (value, cap) => {
          const saturated = saturate(value, cap);
          expect(Math.abs(saturated)).toBeLessThanOrEqual(cap);
          expect(saturate(-value, cap)).toBeCloseTo(-saturated, 9);
        },
      ),
    );
    expect(saturate(0.01, 2)).toBeCloseTo(0.01, 5);
  });
});

describe("measurements", () => {
  it("takes every rate as 0 at the very first instant", () => {
    const [scored] = scoreWaitingPlayers(
      makeInput([makePlayer(1), makePlayer(2)], []),
      DEFAULT_WEIGHTS,
    );
    const { measurements } = scored;
    for (const value of [
      measurements.gameDeficit,
      measurements.gamesBehindMean,
      measurements.playDeficit,
      measurements.waitExcess,
    ]) {
      expect(value).toBeCloseTo(0, 12);
    }
    expect(measurements.restSlots).toBe(REST_CAP_SLOTS);
    expect(measurements.justCameOff).toBe(false);
  });

  it("gives a late arrival a small fair-share expectation (m3 scales with time present)", () => {
    const regular = makePlayer(1, {
      gamesCompleted: 4,
      presentMs: 6 * TEST_SLOT_MS,
      playMs: 4 * TEST_SLOT_MS,
      totalWaitMs: 2 * TEST_SLOT_MS,
    });
    const lateArrival = makePlayer(2, {
      presentMs: 0.5 * TEST_SLOT_MS,
      totalWaitMs: 0.5 * TEST_SLOT_MS,
      currentWaitMs: 0.5 * TEST_SLOT_MS,
    });
    const scored = scoreWaitingPlayers(
      makeInput([regular, lateArrival], []),
      DEFAULT_WEIGHTS,
    );
    const late = scored.find(
      (entry) => entry.snapshot.player.participantId === id(2),
    )!;
    const rate = 4 / 6.5;
    expect(late.measurements.gameDeficit).toBeCloseTo(rate * 0.5, 9);
    // Behind on raw games by 2, but only ~0.3 behind fair share.
    expect(late.measurements.gamesBehindMean).toBe(2);
    expect(late.measurements.gameDeficit).toBeLessThan(0.5);
  });

  it("decays recent participation with a two-slot half-life", () => {
    const snapshot = snapshotAtNow(
      makePlayer(1, { completedGameAgesMs: [0, 2 * TEST_SLOT_MS] }),
      TEST_SLOT_MS,
      1,
    );
    expect(snapshot.recentGames).toBeCloseTo(1.5, 9);
  });

  it("flags a player who just came off and penalises them", () => {
    const [scored] = scoreWaitingPlayers(
      makeInput([makePlayer(1, { restMs: 0.2 * TEST_SLOT_MS })], []),
      DEFAULT_WEIGHTS,
    );
    expect(scored.measurements.justCameOff).toBe(true);
    expect(scored.terms.consecutive).toBe(-DEFAULT_WEIGHTS.consecutive);
  });
});

describe("priority bounds", () => {
  const playerArbitrary = (number: number) =>
    fc
      .record({
        gamesCompleted: fc.integer({ min: 0, max: 30 }),
        // Whole minutes, as real presence is: no denormal durations.
        presentSlots: fc
          .integer({ min: 0, max: 340 })
          .map((minutes) => minutes / 17),
        playShare: fc.double({ min: 0, max: 1, noNaN: true }),
        currentWaitSlots: fc.double({ min: 0, max: 20, noNaN: true }),
        restSlots: fc.option(fc.double({ min: 0, max: 20, noNaN: true })),
      })
      .map((values): SchedulePlayer =>
        makePlayer(number, {
          gamesCompleted: values.gamesCompleted,
          presentMs: values.presentSlots * TEST_SLOT_MS,
          playMs: values.presentSlots * values.playShare * TEST_SLOT_MS,
          totalWaitMs:
            values.presentSlots * (1 - values.playShare) * TEST_SLOT_MS,
          currentWaitMs: values.currentWaitSlots * TEST_SLOT_MS,
          restMs:
            values.restSlots === null ? null : values.restSlots * TEST_SLOT_MS,
          completedGameAgesMs: Array.from(
            { length: Math.min(values.gamesCompleted, 10) },
            (_, index) => index * TEST_SLOT_MS,
          ),
        }),
      );

  it("keeps every score far inside one host-override position, even with every objective ranked first", () => {
    const strongest = resolveScoringWeights(preferencesWithFirst("equalGames"));
    const maximumMultiplier = 2;
    const boostedWeights = {
      ...strongest,
      currentWait: DEFAULT_SCORING_WEIGHTS.currentWait * maximumMultiplier,
      playingTime: DEFAULT_SCORING_WEIGHTS.playingTime * maximumMultiplier,
      rest: DEFAULT_SCORING_WEIGHTS.rest * maximumMultiplier,
    };
    fc.assert(
      fc.property(
        fc
          .array(fc.integer({ min: 1, max: 1000 }), {
            minLength: 2,
            maxLength: 12,
          })
          .chain((numbers) =>
            fc.tuple(...[...new Set(numbers)].map(playerArbitrary)),
          ),
        (players) => {
          const scored = scoreWaitingPlayers(
            makeInput(players, []),
            boostedWeights,
          );
          const priorities = scored.map((entry) => entry.priority);
          const spread = Math.max(...priorities) - Math.min(...priorities);
          expect(spread).toBeLessThan(HOST_OVERRIDE_POINTS_PER_POSITION / 4);
        },
      ),
    );
  });
});

describe("forecast projection", () => {
  it("projectedSessionRates agrees with projecting every snapshot", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            status: fc.constantFrom("waiting", "playing", "skipped" as const),
            gamesCompleted: fc.integer({ min: 0, max: 10 }),
            presentSlots: fc
              .integer({ min: 0, max: 170 })
              .map((minutes) => minutes / 17),
            playShare: fc.double({ min: 0, max: 1, noNaN: true }),
            freesAtSlots: fc.double({ min: 0, max: 2, noNaN: true }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        fc.double({ min: 0, max: 2, noNaN: true }),
        (rows, offsetSlots) => {
          const snapshots = rows.map((row, index) =>
            snapshotAtNow(
              makePlayer(index + 1, {
                status: row.status,
                gamesCompleted: row.gamesCompleted,
                pendingGameCredit: row.status === "playing" ? 1 : 0,
                presentMs: row.presentSlots * TEST_SLOT_MS,
                playMs: row.presentSlots * row.playShare * TEST_SLOT_MS,
                totalWaitMs:
                  row.presentSlots * (1 - row.playShare) * TEST_SLOT_MS,
                currentCourtId:
                  row.status === "playing" ? testCourtId(1) : null,
              }),
              TEST_SLOT_MS,
              1,
            ),
          );
          const freesAt = rows.map((row) =>
            row.status === "playing" ? row.freesAtSlots : null,
          );
          const expected = sessionRates(
            snapshots.map((snapshot, index) =>
              projectSnapshot(snapshot, offsetSlots, freesAt[index]),
            ),
          );
          const actual = projectedSessionRates(snapshots, offsetSlots, freesAt);
          for (const key of Object.keys(expected) as Array<
            keyof typeof expected
          >) {
            expect(actual[key]).toBeCloseTo(expected[key], 9);
          }
        },
      ),
    );
  });

  it("brings a player back from court with their game credited and no rest", () => {
    const snapshot = snapshotAtNow(
      makePlayer(1, {
        status: "playing",
        gamesCompleted: 2,
        pendingGameCredit: 1,
        presentMs: 3 * TEST_SLOT_MS,
        playMs: 2 * TEST_SLOT_MS,
        totalWaitMs: TEST_SLOT_MS,
      }),
      TEST_SLOT_MS,
      1,
    );
    const back = projectSnapshot(snapshot, 0.5, 0.5);
    expect(back).toMatchObject({
      gamesCompleted: 3,
      presentSlots: 3.5,
      playSlots: 2.5,
      currentWaitSlots: 0,
      restSlots: 0,
    });
    const context: ScoringContext = {
      weights: DEFAULT_WEIGHTS,
      rates: sessionRates([back]),
      manualRankCount: 0,
    };
    expect(scoreSnapshot(back, context).measurements.justCameOff).toBe(true);
  });
});

describe("forecast pruning bound", () => {
  it("never underestimates a waiting player's projected priority", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            status: fc.constantFrom("waiting", "waiting", "playing" as const),
            gamesCompleted: fc.integer({ min: 0, max: 8 }),
            presentMinutes: fc.integer({ min: 0, max: 200 }),
            playShare: fc.double({ min: 0, max: 1, noNaN: true }),
            waitMinutes: fc.integer({ min: 0, max: 60 }),
            restMinutes: fc.option(fc.integer({ min: 0, max: 60 })),
            freesAtSlots: fc.double({ min: 0, max: 1.5, noNaN: true }),
          }),
          { minLength: 2, maxLength: 15 },
        ),
        fc.double({ min: 0, max: 1.5, noNaN: true }),
        fc.constantFrom("equalGames", "shortestWaits", "noBackToBack" as const),
        (rows, offsetSlots, firstObjective) => {
          const weights = resolveScoringWeights(
            preferencesWithFirst(firstObjective),
          );
          const minute = TEST_SLOT_MS / 17;
          const players = rows.map((row, index) =>
            makePlayer(index + 1, {
              status: row.status,
              gamesCompleted: row.gamesCompleted,
              pendingGameCredit: row.status === "playing" ? 1 : 0,
              presentMs: row.presentMinutes * minute,
              playMs: row.presentMinutes * row.playShare * minute,
              totalWaitMs: row.presentMinutes * (1 - row.playShare) * minute,
              currentWaitMs:
                row.status === "waiting" ? row.waitMinutes * minute : 0,
              restMs:
                row.restMinutes === null ? null : row.restMinutes * minute,
              completedGameAgesMs:
                row.restMinutes === null ? [] : [row.restMinutes * minute],
              currentCourtId: row.status === "playing" ? testCourtId(1) : null,
            }),
          );
          const snapshots = players.map((player) =>
            snapshotAtNow(player, TEST_SLOT_MS, 1),
          );
          const ratesNow = sessionRates(snapshots);
          const freesAt = rows.map((row) =>
            row.status === "playing" ? row.freesAtSlots : null,
          );
          const ratesThen = projectedSessionRates(
            snapshots,
            offsetSlots,
            freesAt,
          );
          const waitingNow = snapshots.filter(
            (snapshot) => snapshot.player.status === "waiting",
          );
          const maximumPresent = Math.max(
            0,
            ...waitingNow.map((snapshot) => snapshot.presentSlots),
          );
          const drift = sharedPriorityDrift(
            ratesNow,
            ratesThen,
            offsetSlots,
            maximumPresent,
            weights,
          );
          const contextNow: ScoringContext = {
            weights,
            rates: ratesNow,
            manualRankCount: 0,
          };
          const contextThen: ScoringContext = {
            weights,
            rates: ratesThen,
            manualRankCount: 0,
          };
          for (const snapshot of waitingNow) {
            const bound = waitingPriorityUpperBound(
              scoreSnapshot(snapshot, contextNow),
              offsetSlots,
              drift,
              weights,
            );
            const exact = scoreSnapshot(
              projectSnapshot(snapshot, offsetSlots, null),
              contextThen,
            ).priority;
            expect(exact).toBeLessThanOrEqual(bound + 1e-9);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("host priority order", () => {
  it("scales each objective's weights by its rank and the toggles switch terms off", () => {
    const waitsFirst = resolveScoringWeights(
      preferencesWithFirst("shortestWaits"),
    );
    expect(waitsFirst.currentWait).toBeCloseTo(
      DEFAULT_SCORING_WEIGHTS.currentWait * 2,
    );
    expect(waitsFirst.fairShare).toBeCloseTo(
      DEFAULT_SCORING_WEIGHTS.fairShare * 1.5,
    );

    const noRules = resolveScoringWeights({
      ...DEFAULT_SIMULATION_PREFERENCES,
      rules: {
        preventConsecutive: false,
        fewerGamesFirst: false,
        longestWaitFirst: false,
        mixPartners: false,
        minimiseRepeatOpponents: false,
        allowManualAssignments: true,
      },
    });
    expect(noRules).toMatchObject({
      consecutive: 0,
      fairShare: 0,
      rawGames: 0,
      currentWait: 0,
      accumulatedWait: 0,
      repeatPartner: 0,
      repeatOpponent: 0,
    });
    expect(noRules.playingTime).toBeGreaterThan(0);
  });
});
