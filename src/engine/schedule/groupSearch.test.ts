// @vitest-environment node
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bestTeamSplit,
  chooseGroup,
  evaluateGroup,
  FAIR_ALTERNATIVE_TOLERANCE_POINTS,
  fairAlternatives,
  topByPriority,
} from "./groupSearch";
import { snapshotAtNow, type ScoredPlayer } from "./priority";
import {
  TEST_SLOT_MS,
  makePlayer,
  testPlayerId as id,
} from "./testing/scheduleFixtures";
import type { SchedulePlayer } from "./types";
import { DEFAULT_SCORING_WEIGHTS } from "./weights";

/** A scored player with a chosen priority (the terms don't matter to the group search). */
function scored(
  number: number,
  priority: number,
  overrides: Partial<SchedulePlayer> = {},
): ScoredPlayer {
  return {
    snapshot: snapshotAtNow(makePlayer(number, overrides), TEST_SLOT_MS, 1),
    measurements: {} as ScoredPlayer["measurements"],
    terms: {} as ScoredPlayer["terms"],
    priority,
  };
}

/** Fixed so property failures reproduce. */
const PROPERTY_SEED = 20261108;

const idsOf = (players: ScoredPlayer[]) =>
  players.map((player) => player.snapshot.player.participantId);

describe("bestTeamSplit", () => {
  it("chooses the split with the fewest repeat partners", () => {
    const players = [
      scored(1, 0, { partnerCounts: { [id(3)]: 3 } }),
      scored(2, 0),
      scored(3, 0, { partnerCounts: { [id(1)]: 3 } }),
      scored(4, 0),
    ];
    const split = bestTeamSplit(players, DEFAULT_SCORING_WEIGHTS);
    expect(split.repeatPartners).toBe(0);
    expect(idsOf(split.teamA)).not.toEqual(
      expect.arrayContaining([id(1), id(3)]),
    );
  });

  it("counts opponents only across teams, and singles has no partners", () => {
    const players = [
      scored(1, 0, { opponentCounts: { [id(2)]: 1 } }),
      scored(2, 0, { opponentCounts: { [id(1)]: 1 } }),
    ];
    const split = bestTeamSplit(players, DEFAULT_SCORING_WEIGHTS);
    expect(split.repeatPartners).toBe(0);
    expect(split.repeatOpponents).toBeGreaterThan(0);
  });

  it("rejects a group that is neither singles nor doubles", () => {
    expect(() =>
      bestTeamSplit(
        [scored(1, 0), scored(2, 0), scored(3, 0)],
        DEFAULT_SCORING_WEIGHTS,
      ),
    ).toThrow(/2 or 4 players/);
  });
});

describe("chooseGroup", () => {
  it("starts from the top scorers and returns null when there are not enough players", () => {
    const shortlist = [
      scored(1, 5),
      scored(2, 4),
      scored(3, 3),
      scored(4, 2),
      scored(5, 1),
    ];
    const choice = chooseGroup(4, [], shortlist, DEFAULT_SCORING_WEIGHTS);
    expect(new Set(idsOf(choice!.members))).toEqual(
      new Set([id(1), id(2), id(3), id(4)]),
    );
    expect(
      chooseGroup(4, [], shortlist.slice(0, 3), DEFAULT_SCORING_WEIGHTS),
    ).toBeNull();
  });

  it("always seats forced (locked) players", () => {
    const forced = [scored(9, -50)];
    const shortlist = [scored(1, 5), scored(2, 4), scored(3, 3), scored(4, 2)];
    const choice = chooseGroup(4, forced, shortlist, DEFAULT_SCORING_WEIGHTS);
    expect(idsOf(choice!.members)).toContain(id(9));
  });

  it("swaps out a player whose repeat pairings cost more than the priority gap", () => {
    // 1, 2 and 3 have all partnered and faced each other a lot: one of them is swapped for 5.
    const heavy = { [id(1)]: 5, [id(2)]: 5, [id(3)]: 5 };
    const shortlist = [
      scored(1, 3.0, { partnerCounts: heavy, opponentCounts: heavy }),
      scored(2, 2.9, { partnerCounts: heavy, opponentCounts: heavy }),
      scored(3, 2.8, { partnerCounts: heavy, opponentCounts: heavy }),
      scored(4, 2.7),
      scored(5, 2.6),
    ];
    const choice = chooseGroup(4, [], shortlist, DEFAULT_SCORING_WEIGHTS);
    expect(idsOf(choice!.members)).toContain(id(5));
  });

  it("returns a group no single swap with the short list can improve, never worse than greedy", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            priority: fc.double({ min: -3, max: 3, noNaN: true }),
            partners: fc.array(fc.integer({ min: 0, max: 3 }), {
              minLength: 10,
              maxLength: 10,
            }),
            skill: fc.constantFrom(
              "beginner",
              "intermediate",
              "advanced",
              null,
            ),
          }),
          { minLength: 4, maxLength: 10 },
        ),
        (rows) => {
          const players = rows
            .map((row, index) =>
              scored(index + 1, row.priority, {
                skill: row.skill,
                partnerCounts: Object.fromEntries(
                  row.partners.map((count, other) => [id(other + 1), count]),
                ),
                opponentCounts: Object.fromEntries(
                  row.partners.map((count, other) => [id(other + 1), count]),
                ),
              }),
            )
            .sort((left, right) => right.priority - left.priority);
          const choice = chooseGroup(4, [], players, DEFAULT_SCORING_WEIGHTS)!;
          const greedy = evaluateGroup(
            players.slice(0, 4),
            DEFAULT_SCORING_WEIGHTS,
          );
          expect(choice.groupValue).toBeGreaterThanOrEqual(
            greedy.groupValue - 1e-9,
          );
          const outsiders = players.filter(
            (player) => !choice.members.includes(player),
          );
          for (let index = 0; index < 4; index += 1) {
            for (const outsider of outsiders) {
              const swapped = [...choice.members];
              swapped[index] = outsider;
              expect(
                evaluateGroup(swapped, DEFAULT_SCORING_WEIGHTS).groupValue,
              ).toBeLessThanOrEqual(choice.groupValue + 1e-6);
            }
          }
        },
      ),
    );
  });
});

describe("fairAlternatives", () => {
  it("offers exactly the single swaps within tolerance, never a lower-scoring group outside it", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            priority: fc.double({ min: -1, max: 1, noNaN: true }),
            partners: fc.array(fc.integer({ min: 0, max: 2 }), {
              minLength: 10,
              maxLength: 10,
            }),
            skill: fc.constantFrom(
              "beginner",
              "intermediate",
              "advanced",
              null,
            ),
          }),
          { minLength: 4, maxLength: 10 },
        ),
        fc.integer({ min: 0, max: 2 }),
        (rows, forcedCount) => {
          const players = rows
            .map((row, index) =>
              scored(index + 1, row.priority, {
                skill: row.skill,
                partnerCounts: Object.fromEntries(
                  row.partners.map((count, other) => [id(other + 1), count]),
                ),
              }),
            )
            .sort((left, right) => right.priority - left.priority);
          const forced = players.slice(0, forcedCount);
          const shortlist = players.slice(forcedCount);
          const best = chooseGroup(
            4,
            forced,
            shortlist,
            DEFAULT_SCORING_WEIGHTS,
          );
          if (best === null) return;
          // chooseGroup puts the locked players first in best.members, which fairAlternatives relies on.
          const alternatives = fairAlternatives(
            best,
            forcedCount,
            shortlist,
            DEFAULT_SCORING_WEIGHTS,
          );
          const floor = best.groupValue - FAIR_ALTERNATIVE_TOLERANCE_POINTS;
          for (const alternative of alternatives) {
            expect(alternative.groupValue).toBeGreaterThanOrEqual(floor);
            // Locked players are never swapped out.
            for (const lockedPlayer of forced) {
              expect(alternative.members).toContain(lockedPlayer);
            }
          }
          // Every within-tolerance single swap is offered (none is missed by pruning).
          let expectedCount = 0;
          const outsiders = shortlist.filter(
            (player) => !best.members.includes(player),
          );
          for (let index = forcedCount; index < 4; index += 1) {
            for (const outsider of outsiders) {
              const swapped = [...best.members];
              swapped[index] = outsider;
              if (
                evaluateGroup(swapped, DEFAULT_SCORING_WEIGHTS).groupValue >=
                floor
              ) {
                expectedCount += 1;
              }
            }
          }
          expect(alternatives).toHaveLength(expectedCount);
        },
      ),
      { seed: PROPERTY_SEED },
    );
  });
});

describe("topByPriority", () => {
  it("matches a full sort", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -100, max: 100, noNaN: true }), {
          maxLength: 60,
        }),
        fc.integer({ min: 0, max: 15 }),
        (priorities, count) => {
          const players = priorities.map((priority, index) =>
            scored(index + 1, priority),
          );
          const expected = [...players]
            .sort((left, right) => right.priority - left.priority)
            .slice(0, count)
            .map((player) => player.priority);
          expect(
            topByPriority(players, count).map((player) => player.priority),
          ).toEqual(expected);
        },
      ),
    );
  });
});
