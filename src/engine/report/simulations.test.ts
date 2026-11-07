// @vitest-environment node
// Whole-session simulations (plan §6): hard invariants under random sessions,
// the quality targets, and behaviour tests showing the scheduler balances
// rather than follows rules. Seeds are fixed so every run is reproducible.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PLAYERS_PER_MATCH,
  matchRecords,
  replay,
  type CourtFormat,
  type RotationObjective,
  type RotationPreferences,
  type SessionState,
} from "../session";
import {
  scoreWaitingPlayers,
  type PriorityTermName,
} from "../schedule/priority";
import {
  simulateSession,
  type RecommendationObservation,
  type SessionSimulationOptions,
} from "../schedule/simulation/simulateSession";
import {
  preferencesWithFirst,
  preferencesWithLast,
} from "../schedule/testing/scheduleFixtures";
import { resolveScoringWeights } from "../schedule/weights";
import {
  measureSessionQuality,
  simulateAndMeasure,
  type SessionQuality,
} from "./simulationQuality";

/** Checks one recommendation the simulator acted on. */
function expectValidRecommendation({
  input,
  recommendation,
}: RecommendationObservation) {
  const playersById = new Map(
    input.players.map((player) => [player.participantId, player]),
  );
  const freeCourtIds = input.courts
    .filter((court) => court.currentMatchElapsedMs === null)
    .map((court) => court.courtId);
  const expectedFreeInMsByCourtId = new Map(
    input.courts
      .filter((court) => court.currentMatchElapsedMs !== null)
      .map((court) => [
        court.courtId,
        Math.max(0, input.expectedMatchMs - court.currentMatchElapsedMs!),
      ]),
  );

  // Ready now: valid groups of distinct waiting players on free courts.
  const seatedNow = new Set<string>();
  for (const suggestion of recommendation.readyNow) {
    expect(freeCourtIds).toContain(suggestion.courtId);
    const members = [...suggestion.teamA, ...suggestion.teamB];
    expect(members).toHaveLength(PLAYERS_PER_MATCH[suggestion.format]);
    for (const participantId of members) {
      expect(playersById.get(participantId)?.status).toBe("waiting");
      expect(seatedNow.has(participantId)).toBe(false);
      seatedNow.add(participantId);
    }
    // A player locked to this court is seated whenever the court is filled.
    for (const player of input.players) {
      if (
        player.status === "waiting" &&
        player.lockedCourtId === suggestion.courtId
      ) {
        expect(members).toContain(player.participantId);
      }
    }
  }

  // Every free court is either filled or reported unfilled, and left empty
  // only when too few players are eligible.
  const unfilledReadyNow = recommendation.unfilledCourts.filter(
    (court) => court.isReadyNow,
  );
  expect(
    [
      ...recommendation.readyNow.map((suggestion) => suggestion.courtId),
      ...unfilledReadyNow.map((court) => court.courtId),
    ].sort(),
  ).toEqual([...freeCourtIds].sort());
  for (const court of unfilledReadyNow) {
    expect(court.availablePlayerCount).toBeLessThan(court.playersNeeded);
  }

  // Up next: no one twice, no one from a Ready now group, and every member is
  // waiting or on a court expected to free no later than the suggestion's ETA.
  const seatedInForecast = new Set<string>();
  for (const suggestion of recommendation.upNext) {
    for (const participantId of [...suggestion.teamA, ...suggestion.teamB]) {
      expect(seatedNow.has(participantId)).toBe(false);
      expect(seatedInForecast.has(participantId)).toBe(false);
      seatedInForecast.add(participantId);
      const player = playersById.get(participantId)!;
      if (player.status === "playing") {
        const freeInMs = expectedFreeInMsByCourtId.get(player.currentCourtId!);
        expect(freeInMs).toBeLessThanOrEqual(suggestion.expectedFreeInMs);
      } else {
        expect(player.status).toBe("waiting");
      }
    }
  }
}

/** Nobody is ever on two courts at once: a player's play segments never overlap. */
function expectNoOverlappingPlay(state: SessionState) {
  const end = state.endedAt!;
  const segmentsByPlayer = new Map<string, Array<[number, number]>>();
  for (const record of matchRecords(state, end)) {
    for (const segment of record.segments) {
      const spans = segmentsByPlayer.get(segment.participantId) ?? [];
      spans.push([segment.from, segment.to ?? end]);
      segmentsByPlayer.set(segment.participantId, spans);
    }
  }
  for (const spans of segmentsByPlayer.values()) {
    spans.sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index][0]).toBeGreaterThanOrEqual(spans[index - 1][1]);
    }
  }
}

const formatsArbitrary = (courtCount: { min: number; max: number }) =>
  fc.integer(courtCount).chain((count) =>
    fc.array(fc.constantFrom<CourtFormat>("doubles", "doubles", "singles"), {
      minLength: count,
      maxLength: count,
    }),
  );

function sessionArbitrary(
  attendance: { min: number; max: number },
  courtCount: { min: number; max: number },
) {
  return fc.record({
    seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
    courtFormats: formatsArbitrary(courtCount),
    initialPlayerCount: fc.integer(attendance),
    lateArrivalShare: fc.double({ min: 0, max: 0.4, noNaN: true }),
    departureShare: fc.double({ min: 0, max: 0.3, noNaN: true }),
    rejoinProbability: fc.double({ min: 0, max: 1, noNaN: true }),
    pauseCount: fc.integer({ min: 0, max: 2 }),
    targetMatchMinutes: fc.integer({ min: 8, max: 25 }),
    changeoverMinutes: fc.integer({ min: 0, max: 4 }),
    durationMinutes: fc.integer({ min: 30, max: 240 }),
    matchLengthVariation: fc.double({ min: 0, max: 0.5, noNaN: true }),
  });
}

type RandomSession =
  ReturnType<typeof sessionArbitrary> extends fc.Arbitrary<infer TValues>
    ? TValues
    : never;

let undoChecksRun = 0;

function runInvariantChecks(
  values: RandomSession,
  undoCheckProbability: number,
) {
  const options: SessionSimulationOptions = {
    ...values,
    lateArrivalCount: Math.round(
      values.initialPlayerCount * values.lateArrivalShare,
    ),
    departureCount: Math.round(
      values.initialPlayerCount * values.departureShare,
    ),
    undoCheckProbability,
    hostActionProbability: 0.3,
    onRecommendation: expectValidRecommendation,
  };
  // Every suggested match goes through applyEvent, which rejects (and the
  // simulator throws on) any invalid match or double-booked player.
  const result = simulateSession(options);
  expectNoOverlappingPlay(result.state);

  const end = result.state.endedAt!;
  const quality = measureSessionQuality(result, options);
  const records = matchRecords(result.state, end);
  const creditedGames = records
    .filter((record) => record.status === "completed")
    .reduce((total, record) => total + record.creditedParticipantIds.length, 0);
  const reportGames = quality.finalReport.players.reduce(
    (total, player) => total + player.gamesCompleted,
    0,
  );
  expect(reportGames).toBe(creditedGames);

  undoChecksRun += result.undoChecks.length;
  for (const check of result.undoChecks) {
    expect(check.afterUndo, `undo of ${check.undoneType}`).toEqual(
      check.before,
    );
  }

  const replayed = replay(result.events);
  expect(replayed.ok).toBe(true);
  if (replayed.ok) expect(replayed.state).toEqual(result.state);
}

describe("simulation invariants (fast-check)", () => {
  it("hold for random small and mid-size sessions, including undo checks", () => {
    fc.assert(
      fc.property(
        sessionArbitrary({ min: 0, max: 60 }, { min: 1, max: 8 }),
        (values) => runInvariantChecks(values, 0.05),
      ),
      { numRuns: 40, seed: 20261107 },
    );
    expect(undoChecksRun).toBeGreaterThan(20);
  }, 120_000);

  it("hold for random large sessions (up to 500 attendees, 50 courts)", () => {
    fc.assert(
      fc.property(
        sessionArbitrary({ min: 150, max: 500 }, { min: 15, max: 50 }),
        (values) => runInvariantChecks(values, 0),
      ),
      { numRuns: 4, seed: 20261108 },
    );
  }, 120_000);
});

/** Steady state: fixed attendance, players ≥ seats, natural variation in match length. */
const STEADY_STATE_CONFIGURATIONS: Array<[number, CourtFormat[]]> = [
  [8, ["doubles", "doubles"]],
  [10, ["doubles", "doubles"]],
  [12, ["doubles", "doubles"]],
  [14, ["doubles", "doubles", "doubles"]],
  [17, ["doubles", "doubles", "doubles"]],
  [22, Array(4).fill("doubles")],
  [30, Array(4).fill("doubles")],
  [45, Array(6).fill("doubles")],
  [60, Array(8).fill("doubles")],
  [7, ["doubles"]],
  [9, ["doubles", "singles"]],
  [13, ["doubles", "doubles", "singles"]],
];
const SEEDS_PER_CONFIGURATION = 10;

describe("quality targets (measured; the scheduler does not enforce them)", () => {
  const runs = STEADY_STATE_CONFIGURATIONS.flatMap(([players, courts]) =>
    Array.from({ length: SEEDS_PER_CONFIGURATION }, (_, index) =>
      simulateAndMeasure({
        seed: 1000 * players + index,
        courtFormats: courts,
        initialPlayerCount: players,
      }),
    ),
  );

  it("keeps the game spread ≤ 1 in at least 95% of steady-state runs", () => {
    const withinOne = runs.filter((run) => run.gameSpread <= 1).length;
    expect(withinOne / runs.length).toBeGreaterThanOrEqual(0.95);
  });

  it("keeps Jain's games index ≥ 95", () => {
    for (const run of runs)
      expect(run.jainGamesIndex).toBeGreaterThanOrEqual(95);
  });

  it("uses ≈ 100% of court time whenever players ≥ seats", () => {
    for (const run of runs) {
      expect(run.utilisationToPlannedEnd).toBeGreaterThanOrEqual(0.99);
    }
  });

  it("meets the targets at big-club sizes too (120/12 and 500/50, one seed each)", () => {
    for (const [players, courts] of [
      [120, 12],
      [500, 50],
    ]) {
      const run = simulateAndMeasure({
        seed: players,
        courtFormats: Array<CourtFormat>(courts).fill("doubles"),
        initialPlayerCount: players,
        includeUpNext: false,
      });
      expect(run.gameSpread).toBeLessThanOrEqual(1);
      expect(run.jainGamesIndex).toBeGreaterThanOrEqual(95);
      expect(run.utilisationToPlannedEnd).toBeGreaterThanOrEqual(0.99);
      // 300 of 500 players sit out each round, so waits approach 2 slots.
      expect(run.maxWaitSlots).toBeLessThanOrEqual(2);
    }
  }, 60_000);

  it("bounds the longest single wait", () => {
    for (const run of runs) expect(run.maxWaitSlots).toBeLessThanOrEqual(2);
  });
});

/** Sessions with churn: late arrivals, departures and rejoins, uneven match lengths. */
const DYNAMIC_CONFIGURATIONS: Array<[number, CourtFormat[]]> = [
  [7, ["doubles"]],
  [10, ["doubles", "doubles"]],
  [13, ["doubles", "doubles"]],
  [19, ["doubles", "doubles", "doubles"]],
];

function dynamicRuns(
  seedsPerConfiguration: number,
  overrides: Partial<SessionSimulationOptions> = {},
) {
  return DYNAMIC_CONFIGURATIONS.flatMap(([players, courts]) =>
    Array.from({ length: seedsPerConfiguration }, (_, index) =>
      simulateAndMeasure({
        seed: 7 * index + players,
        courtFormats: courts,
        initialPlayerCount: players,
        lateArrivalCount: Math.round(players * 0.25),
        departureCount: Math.round(players * 0.15),
        rejoinProbability: 0.5,
        matchLengthVariation: 0.35,
        ...overrides,
      }),
    ),
  );
}

const mean = (values: number[]) =>
  values.reduce((total, value) => total + value, 0) / values.length;

const worstFairShareGap = (run: SessionQuality) =>
  Math.max(
    ...run.finalReport.players.map((player) =>
      Math.abs(player.gamesBehindFairShare),
    ),
  );

describe("behaviour: balances rather than follows rules", () => {
  /** Mean of `measureRun` with `objective` ranked first vs last, over `configurations` × 30 seeds. */
  function compareFirstAndLast(
    objective: RotationObjective,
    configurations: Array<[number, CourtFormat[]]>,
    measureRun: (run: SessionQuality) => number,
    overrides: Partial<SessionSimulationOptions> = {},
  ) {
    const meanFor = (preferences: RotationPreferences) =>
      mean(
        configurations.flatMap(([players, courts]) =>
          Array.from({ length: 30 }, (_, index) =>
            measureRun(
              simulateAndMeasure({
                seed: 13 * index + players,
                courtFormats: courts,
                initialPlayerCount: players,
                preferences,
                includeUpNext: false,
                ...overrides,
              }),
            ),
          ),
        ),
      );
    return {
      first: meanFor(preferencesWithFirst(objective)),
      last: meanFor(preferencesWithLast(objective)),
    };
  }
  const churn = {
    lateArrivalCount: 4,
    departureCount: 2,
    rejoinProbability: 0.5,
    matchLengthVariation: 0.35,
  };

  it("ranking Mix partners first cuts repeat partners by at least 30%", () => {
    const { first, last } = compareFirstAndLast(
      "mixPartners",
      [
        [10, ["doubles", "doubles"]],
        [19, ["doubles", "doubles", "doubles"]],
      ],
      (run) => run.repeatPartnerRate,
      churn,
    );
    expect(first).toBeLessThanOrEqual(last * 0.7);
  }, 60_000);

  it("avoids back-to-back games whenever enough rested players exist", () => {
    // With at least two players per seat nobody ever has to play twice in a
    // row. (Where it is forced, ranking can't change it; the decisive
    // ranking effect is shown in recommend.test.ts.)
    const rates = (
      [
        [8, ["doubles"]],
        [16, ["doubles", "doubles"]],
      ] as Array<[number, CourtFormat[]]>
    ).flatMap(([players, courts]) =>
      Array.from(
        { length: 30 },
        (_, index) =>
          simulateAndMeasure({
            seed: 13 * index + players,
            courtFormats: courts,
            initialPlayerCount: players,
            matchLengthVariation: 0.35,
            includeUpNext: false,
          }).backToBackRate,
      ),
    );
    expect(mean(rates)).toBeLessThanOrEqual(0.01);
  }, 60_000);

  it("ranking Shortest waits first lowers the longest wait (small: waits are bounded by courts and players)", () => {
    const { first, last } = compareFirstAndLast(
      "shortestWaits",
      [
        [13, ["doubles", "doubles"]],
        [30, Array(4).fill("doubles")],
      ],
      (run) => run.maxWaitSlots,
      churn,
    );
    expect(first).toBeLessThanOrEqual(last * 0.99);
  }, 60_000);

  it("ends late arrivals within about one game of their fair share", () => {
    const runs = dynamicRuns(15);
    const gaps = runs.flatMap((run) => {
      const lateIds = new Set(run.result.lateArrivalIds);
      return run.finalReport.players
        .filter((player) => lateIds.has(player.participantId))
        .map((player) => Math.abs(player.gamesBehindFairShare));
    });
    expect(gaps.length).toBeGreaterThan(50);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1.25);
    expect(mean(gaps)).toBeLessThan(0.5);
  }, 60_000);

  it("keeps the repeat-partner rate well below random grouping", () => {
    const engine = mean(dynamicRuns(10).map((run) => run.repeatPartnerRate));
    const random = mean(
      dynamicRuns(10, { policy: "random" }).map((run) => run.repeatPartnerRate),
    );
    expect(engine).toBeLessThan(random * 0.5);
  }, 60_000);

  it("lets no single score term decide more than 15% of picks", () => {
    // A term "decides" a pick when the lowest-priority chosen player beats the
    // best excluded player only because of that term.
    const decidedBy = new Map<PriorityTermName, number>();
    let decisions = 0;
    dynamicRuns(10, {
      onRecommendation: ({ input, recommendation }) => {
        const scored = scoreWaitingPlayers(
          input,
          resolveScoringWeights(input.preferences),
        );
        const chosenIds = new Set(
          recommendation.readyNow.flatMap((suggestion) => [
            ...suggestion.teamA,
            ...suggestion.teamB,
          ]),
        );
        const chosen = scored.filter((entry) =>
          chosenIds.has(entry.snapshot.player.participantId),
        );
        const excluded = scored.filter(
          (entry) => !chosenIds.has(entry.snapshot.player.participantId),
        );
        if (chosen.length === 0 || excluded.length === 0) return;
        const weakestChosen = chosen[chosen.length - 1];
        const strongestExcluded = excluded[0];
        const margin = weakestChosen.priority - strongestExcluded.priority;
        decisions += 1;
        for (const term of Object.keys(
          weakestChosen.terms,
        ) as PriorityTermName[]) {
          if (term === "tieBreak" || term === "hostOverride") continue;
          const difference =
            weakestChosen.terms[term] - strongestExcluded.terms[term];
          if (margin > 0 && margin - difference < 0) {
            decidedBy.set(term, (decidedBy.get(term) ?? 0) + 1);
          }
        }
      },
    });
    expect(decisions).toBeGreaterThan(300);
    for (const count of decidedBy.values()) {
      expect(count / decisions).toBeLessThanOrEqual(0.15);
    }
  }, 60_000);

  it("keeps time-present fairness while a session grows from 3 to 40 players", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const run = simulateAndMeasure({
        seed,
        courtFormats: Array(4).fill("doubles"),
        initialPlayerCount: 3,
        lateArrivalCount: 37,
      });
      expect(run.finalReport.playerCount).toBe(40);
      expect(worstFairShareGap(run)).toBeLessThanOrEqual(1.25);
      expect(run.jainGamesIndex).toBeGreaterThanOrEqual(95);
    }
  }, 60_000);
});
