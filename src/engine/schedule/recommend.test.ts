// @vitest-environment node
import { describe, expect, it } from "vitest";
import { scoreWaitingPlayers } from "./priority";
import { recommend } from "./recommend";
import { DEFAULT_SIMULATION_PREFERENCES } from "./simulation/simulateSession";
import { resolveScoringWeights } from "./weights";
import {
  TEST_MINUTE_MS,
  TEST_SLOT_MS,
  makeCourt,
  makeInput,
  makePlayer,
  readyNowIds,
  testCourtId,
  testPlayerId as id,
} from "./testing/scheduleFixtures";
import type { Recommendation, SchedulePlayer } from "./types";

function players(count: number, overrides: Partial<SchedulePlayer> = {}) {
  return Array.from({ length: count }, (_, index) =>
    makePlayer(index + 1, overrides),
  );
}

/** Every Ready now group is valid: right size, distinct, eligible players, no one twice. */
function expectValidReadyNow(
  recommendation: Recommendation,
  eligibleIds: string[],
) {
  const seated = readyNowIds(recommendation);
  expect(new Set(seated).size).toBe(seated.length);
  for (const participantId of seated) {
    expect(eligibleIds).toContain(participantId);
  }
  for (const suggestion of recommendation.readyNow) {
    const size = suggestion.format === "doubles" ? 2 : 1;
    expect(suggestion.teamA).toHaveLength(size);
    expect(suggestion.teamB).toHaveLength(size);
    expect(suggestion.reasons.length).toBeGreaterThan(0);
    expect(suggestion.isReadyNow).toBe(true);
    expect(suggestion.expectedFreeInMs).toBe(0);
  }
}

describe("court filling", () => {
  it("lists every court as unfilled when there are fewer players than a court needs", () => {
    const result = recommend(
      makeInput(players(3), [makeCourt(1), makeCourt(2)]),
    );
    expect(result.readyNow).toEqual([]);
    expect(result.unfilledCourts).toHaveLength(2);
    expect(result.unfilledCourts[0]).toMatchObject({
      isReadyNow: true,
      availablePlayerCount: 3,
      playersNeeded: 4,
    });
  });

  it("seats everyone when players exactly fill the courts", () => {
    const roster = players(8);
    const result = recommend(makeInput(roster, [makeCourt(1), makeCourt(2)]));
    expect(result.readyNow).toHaveLength(2);
    expect(new Set(readyNowIds(result))).toEqual(
      new Set(roster.map((player) => player.participantId)),
    );
    expect(result.unfilledCourts).toEqual([]);
  });

  it("fills every court when players overflow, leaving the rest waiting", () => {
    const roster = players(10);
    const result = recommend(makeInput(roster, [makeCourt(1), makeCourt(2)]));
    expectValidReadyNow(
      result,
      roster.map((player) => player.participantId),
    );
    expect(readyNowIds(result)).toHaveLength(8);
    expect(result.waitingQueue).toHaveLength(10);
  });

  it("fills what it can when players are not divisible by k", () => {
    const nine = recommend(makeInput(players(9), [makeCourt(1), makeCourt(2)]));
    expect(readyNowIds(nine)).toHaveLength(8);

    const six = recommend(makeInput(players(6), [makeCourt(1), makeCourt(2)]));
    expect(six.readyNow).toHaveLength(1);
    expect(six.unfilledCourts).toEqual([
      expect.objectContaining({ availablePlayerCount: 2, playersNeeded: 4 }),
    ]);
  });

  it("mixes singles and doubles, filling the larger court first when players are scarce", () => {
    const courts = [makeCourt(1, "singles"), makeCourt(2, "doubles")];
    const six = recommend(makeInput(players(6), courts));
    expect(six.readyNow.map((suggestion) => suggestion.format).sort()).toEqual([
      "doubles",
      "singles",
    ]);
    expectValidReadyNow(
      six,
      players(6).map((player) => player.participantId),
    );

    const five = recommend(makeInput(players(5), courts));
    expect(five.readyNow.map((suggestion) => suggestion.format)).toEqual([
      "doubles",
    ]);
    expect(five.unfilledCourts).toEqual([
      expect.objectContaining({ courtId: testCourtId(1), playersNeeded: 2 }),
    ]);
  });

  it("handles a large club (500 players, 50 courts) with valid, disjoint groups", () => {
    const roster = Array.from({ length: 500 }, (_, index) =>
      makePlayer(index + 1, {
        gamesCompleted: index % 4,
        presentMs: 60 * TEST_MINUTE_MS,
        currentWaitMs: (index % 9) * TEST_MINUTE_MS,
        restMs: (index % 9) * TEST_MINUTE_MS,
      }),
    );
    const courts = Array.from({ length: 50 }, (_, index) =>
      makeCourt(index + 1),
    );
    const result = recommend(makeInput(roster, courts));
    expect(result.readyNow).toHaveLength(50);
    expectValidReadyNow(
      result,
      roster.map((player) => player.participantId),
    );
  });

  it("never seats playing or skipped players (insufficient eligible players)", () => {
    const roster = [
      ...players(3),
      makePlayer(4, { status: "skipped" }),
      makePlayer(5, { status: "playing", currentCourtId: testCourtId(9) }),
    ];
    const result = recommend(makeInput(roster, [makeCourt(1)]));
    expect(result.readyNow).toEqual([]);
    expect(result.unfilledCourts[0].availablePlayerCount).toBe(3);
    expect(result.waitingQueue.map((entry) => entry.participantId)).toEqual(
      expect.arrayContaining([id(1), id(2), id(3)]),
    );
    expect(result.waitingQueue).toHaveLength(3);
  });

  it("returns nothing for a session with no open courts", () => {
    const result = recommend(makeInput(players(8), []));
    expect(result).toMatchObject({
      readyNow: [],
      upNext: [],
      unfilledCourts: [],
    });
  });
});

describe("balancing, not rules", () => {
  /** 8 players who have played 2 games and waited a little, all present an hour. */
  function settledPlayers(): SchedulePlayer[] {
    return Array.from({ length: 8 }, (_, index) =>
      makePlayer(index + 1, {
        gamesCompleted: 2,
        presentMs: 4 * TEST_SLOT_MS,
        playMs: 2 * TEST_SLOT_MS,
        totalWaitMs: 2 * TEST_SLOT_MS,
        currentWaitMs: 0.6 * TEST_SLOT_MS,
        restMs: 0.6 * TEST_SLOT_MS,
        completedGameAgesMs: [0.6 * TEST_SLOT_MS, 2 * TEST_SLOT_MS],
      }),
    );
  }

  /** The one candidate (player 9) against 8 settled players for one court. */
  function decide(
    candidate: SchedulePlayer,
    preferences = makeInput([], []).preferences,
  ) {
    const input = makeInput([...settledPlayers(), candidate], [makeCourt(1)], {
      preferences,
    });
    const measurements = scoreWaitingPlayers(
      input,
      resolveScoringWeights(preferences),
    ).find(
      (entry) => entry.snapshot.player.participantId === id(9),
    )!.measurements;
    return {
      picked: readyNowIds(recommend(input)).includes(id(9)),
      measurements,
    };
  }

  /** Waiting `waitSlots` (deep in the urgency zone at ≥ 1.5), with `games` played. */
  function longWaiter(games: number, waitSlots: number) {
    return makePlayer(9, {
      gamesCompleted: games,
      presentMs: 4 * TEST_SLOT_MS,
      playMs: Math.min(games, 3.9 - waitSlots) * TEST_SLOT_MS,
      totalWaitMs: (4 - Math.min(games, 3.9 - waitSlots)) * TEST_SLOT_MS,
      currentWaitMs: waitSlots * TEST_SLOT_MS,
      restMs: waitSlots * TEST_SLOT_MS,
      completedGameAgesMs: [
        waitSlots * TEST_SLOT_MS,
        (waitSlots + 1) * TEST_SLOT_MS,
      ],
    });
  }

  /** One game played, present `presentSlots`, `restSlots` since it ended. */
  function oneGamePlayer(presentSlots: number, restSlots: number) {
    return makePlayer(9, {
      gamesCompleted: 1,
      presentMs: presentSlots * TEST_SLOT_MS,
      playMs: TEST_SLOT_MS,
      totalWaitMs: (presentSlots - 1) * TEST_SLOT_MS,
      currentWaitMs: restSlots * TEST_SLOT_MS,
      restMs: restSlots * TEST_SLOT_MS,
      completedGameAgesMs: [restSlots * TEST_SLOT_MS],
    });
  }

  it("does not automatically pick the longest-waiting player when a game ahead", () => {
    const ahead = decide(longWaiter(3, 1.6));
    expect(ahead.measurements.currentWaitSlots).toBeGreaterThanOrEqual(1.5);
    expect(ahead.measurements.gameDeficit).toBeLessThan(-0.8);
    expect(ahead.picked).toBe(false);
    // Control: the same wait without the games lead is picked.
    expect(decide(longWaiter(2, 1.6)).picked).toBe(true);
  });

  it("does not automatically pick the fewest-games player right after they came off", () => {
    // Fewest raw games (1 vs 2), but about at fair share: arrived later.
    const justOff = decide(oneGamePlayer(2.5, 0));
    expect(justOff.measurements.gamesBehindMean).toBeGreaterThan(0.8);
    expect(justOff.measurements.justCameOff).toBe(true);
    expect(justOff.picked).toBe(false);
    // Control: the same player, rested, is picked.
    expect(decide(oneGamePlayer(2.5, 0.6)).picked).toBe(true);
  });

  it("picks a just-off player about a game behind fair share, unless No back-to-back outranks Equal games", () => {
    const behind = decide(oneGamePlayer(4, 0));
    expect(behind.measurements.gameDeficit).toBeGreaterThan(0.8);
    expect(behind.picked).toBe(true);
    const backToBackFirst = decide(oneGamePlayer(4, 0), {
      ...DEFAULT_SIMULATION_PREFERENCES,
      objectiveOrder: [
        "noBackToBack",
        "shortestWaits",
        "playingTime",
        "fullCourts",
        "mixPartners",
        "equalGames",
      ],
    });
    expect(backToBackFirst.picked).toBe(false);
  });

  it("picks the long waiter a game ahead once Shortest waits outranks Equal games", () => {
    const waitsFirst = decide(longWaiter(3, 1.6), {
      ...DEFAULT_SIMULATION_PREFERENCES,
      objectiveOrder: [
        "shortestWaits",
        "playingTime",
        "fullCourts",
        "noBackToBack",
        "mixPartners",
        "equalGames",
      ],
    });
    expect(waitsFirst.picked).toBe(true);
  });

  it("picks a player who came off when they are far behind (weighed, not blocked)", () => {
    const farBehind = decide(
      makePlayer(9, {
        gamesCompleted: 0,
        presentMs: 4 * TEST_SLOT_MS,
        playMs: 0.3 * TEST_SLOT_MS,
        totalWaitMs: 3.7 * TEST_SLOT_MS,
        currentWaitMs: 0,
        restMs: 0,
      }),
    );
    expect(farBehind.measurements.gameDeficit).toBeGreaterThan(1.5);
    expect(farBehind.picked).toBe(true);
  });

  it("prefers rested players over those who just came off (consecutive avoidance)", () => {
    const rested = players(4, {
      gamesCompleted: 1,
      presentMs: 2 * TEST_SLOT_MS,
      playMs: TEST_SLOT_MS,
      totalWaitMs: TEST_SLOT_MS,
      currentWaitMs: 0.8 * TEST_SLOT_MS,
      restMs: 0.8 * TEST_SLOT_MS,
      completedGameAgesMs: [0.8 * TEST_SLOT_MS],
    });
    const justOff = [5, 6, 7, 8].map((number) =>
      makePlayer(number, {
        gamesCompleted: 1,
        presentMs: 2 * TEST_SLOT_MS,
        playMs: TEST_SLOT_MS,
        totalWaitMs: TEST_SLOT_MS,
        currentWaitMs: 0,
        restMs: 0,
        completedGameAgesMs: [0],
      }),
    );
    const result = recommend(
      makeInput([...justOff, ...rested], [makeCourt(1)]),
    );
    expect(new Set(readyNowIds(result))).toEqual(
      new Set([id(1), id(2), id(3), id(4)]),
    );
    expect(result.readyNow[0].reasons[0]).toMatch(/^Waiting \d+ min$/);
  });

  it("picks without favouring ids or join order when everyone is equal (unbiased across seeds)", () => {
    const roster = players(12);
    const selectedCount = new Map<string, number>();
    const seedCount = 600;
    for (let seed = 0; seed < seedCount; seed += 1) {
      const result = recommend(
        makeInput(roster, [makeCourt(1), makeCourt(2)], { seed }),
      );
      for (const participantId of readyNowIds(result)) {
        selectedCount.set(
          participantId,
          (selectedCount.get(participantId) ?? 0) + 1,
        );
      }
    }
    // Each player should be picked about 8/12 of the time.
    for (const player of roster) {
      const share = (selectedCount.get(player.participantId) ?? 0) / seedCount;
      expect(share).toBeGreaterThan(0.58);
      expect(share).toBeLessThan(0.75);
    }
  });

  it("gives the same groups whatever order the players are listed in", () => {
    const roster = Array.from({ length: 14 }, (_, index) =>
      makePlayer(index + 1, {
        gamesCompleted: index % 3,
        presentMs: 3 * TEST_SLOT_MS,
        currentWaitMs: (index % 5) * TEST_MINUTE_MS,
      }),
    );
    const courts = [makeCourt(1), makeCourt(2), makeCourt(3, "doubles", 0)];
    const forward = recommend(makeInput(roster, courts));
    const reversed = recommend(makeInput([...roster].reverse(), courts));
    const groups = (result: Recommendation) =>
      [...result.readyNow, ...result.upNext].map((suggestion) => ({
        courtId: suggestion.courtId,
        players: [...suggestion.teamA, ...suggestion.teamB].sort(),
      }));
    expect(groups(reversed)).toEqual(groups(forward));
  });

  it("is deterministic for a seed, and a new seed can reshuffle near-equal players", () => {
    const input = makeInput(players(12), [makeCourt(1)]);
    expect(recommend(input)).toEqual(recommend(input));
    const groupsBySeed = new Set(
      [1, 2, 3, 4, 5].map((seed) =>
        readyNowIds(recommend({ ...input, seed }))
          .sort()
          .join(","),
      ),
    );
    expect(groupsBySeed.size).toBeGreaterThan(1);
  });
});

describe("teams", () => {
  it("splits teams to avoid repeat partners", () => {
    const roster = [
      makePlayer(1, { partnerCounts: { [id(2)]: 2 } }),
      makePlayer(2, { partnerCounts: { [id(1)]: 2 } }),
      makePlayer(3, { partnerCounts: { [id(4)]: 1 } }),
      makePlayer(4, { partnerCounts: { [id(3)]: 1 } }),
    ];
    const [suggestion] = recommend(makeInput(roster, [makeCourt(1)])).readyNow;
    const teamA = new Set(suggestion.teamA);
    expect(teamA.has(id(1)) && teamA.has(id(2))).toBe(false);
    expect(teamA.has(id(3)) && teamA.has(id(4))).toBe(false);
  });

  it("balances skill across the two teams", () => {
    const roster = [
      makePlayer(1, { skill: "advanced" }),
      makePlayer(2, { skill: "advanced" }),
      makePlayer(3, { skill: "beginner" }),
      makePlayer(4, { skill: "beginner" }),
    ];
    const [suggestion] = recommend(makeInput(roster, [makeCourt(1)])).readyNow;
    const teamAIds = new Set(suggestion.teamA);
    expect(teamAIds.has(id(1))).not.toBe(teamAIds.has(id(2)));
    expect(suggestion.reasons).toContain("Balanced teams");
  });

  it("spreads repeat pairs across courts when several are free at once", () => {
    // 1-2 and 3-4 have partnered twice; with two courts they should be split up.
    const history = (partner: number) => ({ [id(partner)]: 2 });
    const roster = [
      makePlayer(1, { partnerCounts: history(2), opponentCounts: history(2) }),
      makePlayer(2, { partnerCounts: history(1), opponentCounts: history(1) }),
      makePlayer(3, { partnerCounts: history(4), opponentCounts: history(4) }),
      makePlayer(4, { partnerCounts: history(3), opponentCounts: history(3) }),
      ...[5, 6, 7, 8].map((number) => makePlayer(number)),
    ];
    const result = recommend(makeInput(roster, [makeCourt(1), makeCourt(2)]));
    for (const suggestion of result.readyNow) {
      const members = new Set([...suggestion.teamA, ...suggestion.teamB]);
      expect(members.has(id(1)) && members.has(id(2))).toBe(false);
      expect(members.has(id(3)) && members.has(id(4))).toBe(false);
    }
  });
});

describe("host locks and manual order", () => {
  const behind = { gamesCompleted: 0, presentMs: 2 * TEST_SLOT_MS };
  const ahead = {
    gamesCompleted: 3,
    presentMs: 2 * TEST_SLOT_MS,
    restMs: 0,
    completedGameAgesMs: [0],
  };

  it("seats a player locked to a free court even with a low priority", () => {
    const roster = [
      ...players(6, behind),
      makePlayer(7, {
        ...ahead,
        isLocked: true,
        lockedCourtId: testCourtId(2),
      }),
    ];
    const result = recommend(makeInput(roster, [makeCourt(1), makeCourt(2)]));
    const courtTwo = result.readyNow.find(
      (suggestion) => suggestion.courtId === testCourtId(2),
    );
    expect([...courtTwo!.teamA, ...courtTwo!.teamB]).toContain(id(7));
    expect(courtTwo!.reasons[0]).toBe("1 locked by host");
  });

  it("seats an any-court lock in the first group", () => {
    const roster = [
      ...players(6, behind),
      makePlayer(7, { ...ahead, isLocked: true, lockedCourtId: null }),
    ];
    const result = recommend(makeInput(roster, [makeCourt(1)]));
    expect(readyNowIds(result)).toContain(id(7));
  });

  it("keeps a player locked to a busy court for that court's next match", () => {
    const roster = [
      ...players(8, behind),
      makePlayer(9, {
        ...behind,
        gamesCompleted: 0,
        isLocked: true,
        lockedCourtId: testCourtId(2),
      }),
      ...[10, 11, 12, 13].map((number) =>
        makePlayer(number, {
          status: "playing",
          currentCourtId: testCourtId(2),
          pendingGameCredit: 1,
        }),
      ),
    ];
    const result = recommend(
      makeInput(roster, [
        makeCourt(1),
        makeCourt(2, "doubles", 10 * TEST_MINUTE_MS),
      ]),
    );
    expect(readyNowIds(result)).not.toContain(id(9));
    const courtTwoNext = result.upNext.find(
      (suggestion) => suggestion.courtId === testCourtId(2),
    );
    expect([...courtTwoNext!.teamA, ...courtTwoNext!.teamB]).toContain(id(9));
  });

  it("follows the host's manual order over the score", () => {
    // Players 5-8 are well ahead, but the host moved them to the top.
    const roster = [
      ...players(4, behind),
      ...[5, 6, 7, 8].map((number) =>
        makePlayer(number, { ...ahead, manualQueueRank: number - 5 }),
      ),
    ];
    const result = recommend(makeInput(roster, [makeCourt(1)]));
    expect(new Set(readyNowIds(result))).toEqual(
      new Set([id(5), id(6), id(7), id(8)]),
    );
    expect(
      result.waitingQueue.slice(0, 4).map((entry) => entry.participantId),
    ).toEqual([id(5), id(6), id(7), id(8)]);
    expect(result.readyNow[0].reasons[0]).toBe("4 moved up by host");
  });
});

describe("up next forecasts", () => {
  it("never forecasts a player still on a court that frees later, even a minute apart", () => {
    // Court 1 frees in ~3.1 min, Court 2 in ~4.9 min. Court 2's players are far
    // behind, so they would win Court 1 if they were (wrongly) counted as free.
    const roster = [
      ...players(2, {
        presentMs: 2 * TEST_SLOT_MS,
        currentWaitMs: 0.5 * TEST_SLOT_MS,
      }),
      ...[3, 4, 5, 6].map((number) =>
        makePlayer(number, {
          status: "playing",
          currentCourtId: testCourtId(1),
          pendingGameCredit: 1,
          gamesCompleted: 3,
          presentMs: 4 * TEST_SLOT_MS,
          playMs: 3.5 * TEST_SLOT_MS,
        }),
      ),
      ...[7, 8, 9, 10].map((number) =>
        makePlayer(number, {
          status: "playing",
          currentCourtId: testCourtId(2),
          pendingGameCredit: 1,
          presentMs: 4 * TEST_SLOT_MS,
          playMs: 0.5 * TEST_SLOT_MS,
          totalWaitMs: 3.5 * TEST_SLOT_MS,
        }),
      ),
    ];
    const result = recommend(
      makeInput(roster, [
        makeCourt(1, "doubles", 11.9 * TEST_MINUTE_MS),
        makeCourt(2, "doubles", 10.1 * TEST_MINUTE_MS),
      ]),
    );
    const courtOne = result.upNext.find(
      (suggestion) => suggestion.courtId === testCourtId(1),
    )!;
    expect(courtOne.expectedFreeInMs).toBeCloseTo(3.1 * TEST_MINUTE_MS);
    for (const participantId of [...courtOne.teamA, ...courtOne.teamB]) {
      expect([id(7), id(8), id(9), id(10)]).not.toContain(participantId);
    }
    expect(courtOne.reasons.join(" ")).toMatch(/~/);
  });

  it("forecasts busy courts soonest first, from waiting players and those coming off", () => {
    const roster = [
      ...players(2, { presentMs: TEST_SLOT_MS, currentWaitMs: TEST_SLOT_MS }),
      ...[3, 4, 5, 6].map((number) =>
        makePlayer(number, {
          status: "playing",
          currentCourtId: testCourtId(1),
          pendingGameCredit: 1,
          presentMs: TEST_SLOT_MS,
          playMs: TEST_SLOT_MS,
        }),
      ),
      ...[7, 8, 9, 10].map((number) =>
        makePlayer(number, {
          status: "playing",
          currentCourtId: testCourtId(2),
          pendingGameCredit: 1,
          presentMs: TEST_SLOT_MS,
          playMs: 0.3 * TEST_SLOT_MS,
        }),
      ),
    ];
    const result = recommend(
      makeInput(roster, [
        makeCourt(1, "doubles", 12 * TEST_MINUTE_MS),
        makeCourt(2, "doubles", 5 * TEST_MINUTE_MS),
      ]),
    );
    expect(result.readyNow).toEqual([]);
    expect(result.upNext.map((suggestion) => suggestion.courtId)).toEqual([
      testCourtId(1),
      testCourtId(2),
    ]);
    expect(result.upNext[0].expectedFreeInMs).toBe(3 * TEST_MINUTE_MS);
    expect(result.upNext[0].isReadyNow).toBe(false);
    // Court 1's forecast uses the two waiting players plus two of its own finishers.
    const courtOne = [...result.upNext[0].teamA, ...result.upNext[0].teamB];
    expect(courtOne).toEqual(expect.arrayContaining([id(1), id(2)]));
    // Court 2's forecast can only use whoever is left from Court 1 plus its own players.
    const courtTwo = [...result.upNext[1].teamA, ...result.upNext[1].teamB];
    expect(
      courtTwo.filter((participantId) => courtOne.includes(participantId)),
    ).toEqual([]);
  });

  it("treats an overdue court as freeing now and never reuses Ready now players", () => {
    const roster = [
      ...players(8),
      ...[9, 10, 11, 12].map((number) =>
        makePlayer(number, {
          status: "playing",
          currentCourtId: testCourtId(2),
          pendingGameCredit: 1,
        }),
      ),
    ];
    const result = recommend(
      makeInput(roster, [
        makeCourt(1),
        makeCourt(2, "doubles", 25 * TEST_MINUTE_MS),
      ]),
    );
    expect(result.upNext[0].expectedFreeInMs).toBe(0);
    const forecastIds = [...result.upNext[0].teamA, ...result.upNext[0].teamB];
    for (const participantId of readyNowIds(result)) {
      expect(forecastIds).not.toContain(participantId);
    }
  });

  it("marks a forecast court unfilled when too few players will be free", () => {
    const roster = [
      makePlayer(1),
      ...[2, 3].map((number) =>
        makePlayer(number, {
          status: "playing",
          currentCourtId: testCourtId(1),
          pendingGameCredit: 1,
        }),
      ),
    ];
    const result = recommend(
      makeInput(roster, [makeCourt(1, "singles", TEST_MINUTE_MS)]),
    );
    expect(result.upNext).toHaveLength(1);

    const tooFew = recommend(
      makeInput([makePlayer(1)], [makeCourt(1, "doubles", TEST_MINUTE_MS)]),
    );
    expect(tooFew.upNext).toEqual([]);
    expect(tooFew.unfilledCourts).toEqual([
      expect.objectContaining({ isReadyNow: false, playersNeeded: 4 }),
    ]);
  });
});

describe("shuffle", () => {
  it("picks among equally fair groups by seed and says how many there are", () => {
    const input = makeInput(players(10), [makeCourt(1)]);
    const first = recommend(input).readyNow[0];
    expect(first.otherFairGroupCount).toBeGreaterThan(0);
    const groups = new Set(
      [1, 2, 3, 4, 5, 6].map((seed) =>
        readyNowIds(recommend({ ...input, seed }))
          .sort()
          .join(","),
      ),
    );
    expect(groups.size).toBeGreaterThan(1);
  });

  it("reports no other fair option when one group is clearly best", () => {
    const clearlyBest = [
      ...players(4, {
        gamesCompleted: 0,
        presentMs: 3 * TEST_SLOT_MS,
        totalWaitMs: 3 * TEST_SLOT_MS,
        currentWaitMs: 1.5 * TEST_SLOT_MS,
      }),
      ...[5, 6, 7, 8].map((number) =>
        makePlayer(number, {
          gamesCompleted: 3,
          presentMs: 3 * TEST_SLOT_MS,
          playMs: 3 * TEST_SLOT_MS,
          restMs: 0,
          completedGameAgesMs: [0],
        }),
      ),
    ];
    for (const seed of [1, 2, 3]) {
      const [suggestion] = recommend(
        makeInput(clearlyBest, [makeCourt(1)], { seed }),
      ).readyNow;
      expect(suggestion.otherFairGroupCount).toBe(0);
      expect(new Set([...suggestion.teamA, ...suggestion.teamB])).toEqual(
        new Set([id(1), id(2), id(3), id(4)]),
      );
    }
  });
});

describe("input validation", () => {
  it("fails fast on a non-positive slot or duplicate players", () => {
    expect(() =>
      recommend(makeInput(players(4), [makeCourt(1)], { slotMs: 0 })),
    ).toThrow(/positive slotMs/);
    expect(() =>
      recommend(makeInput([makePlayer(1), makePlayer(1)], [makeCourt(1)])),
    ).toThrow(/twice/);
  });
});
