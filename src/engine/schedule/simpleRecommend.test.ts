// @vitest-environment node
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { simpleRecommend } from "./simpleRecommend";
import {
  TestSession,
  makeParticipants,
  fixtureCourtId,
  fixtureParticipantId,
} from "../session/testing/fixtures";
import { validateSimpleTeams } from "../session/simplePolicy";

function sessionFor(genders: string, courts = 2) {
  const participants = makeParticipants(genders.length).map(
    (participant, index) => ({
      ...participant,
      gender:
        genders[index] === "M"
          ? ("male" as const)
          : genders[index] === "F"
            ? ("female" as const)
            : undefined,
    }),
  );
  const session = TestSession.start({ participants, courts });
  session.config.policyVersion = "simple-social-v1";
  return session;
}
const ids = (numbers: number[]) => numbers.map(fixtureParticipantId);
const selectedIds = (session: TestSession, courts = [1, 2]) =>
  simpleRecommend(
    session.state,
    session.now,
    courts.map(fixtureCourtId),
  ).flatMap((group) => [...group.teamA, ...group.teamB]);

describe("simpleRecommend", () => {
  it("rejects 3:1 but selects the oldest feasible four rather than an invalid first four", () => {
    expect(selectedIds(sessionFor("MMMF"))).toEqual([]);
    expect(new Set(selectedIds(sessionFor("MMMFF")))).toEqual(
      new Set(ids([1, 2, 4, 5])),
    );
  });
  it.each(["MMMMMMMM", "FFFFFFFF", "MMFFMMFF"])(
    "fills valid courts for %s",
    (genders) => {
      const session = sessionFor(genders);
      const suggestions = simpleRecommend(session.state, session.now, [
        fixtureCourtId(2),
        fixtureCourtId(1),
      ]);
      expect(suggestions.map((group) => group.courtId)).toEqual([
        fixtureCourtId(2),
        fixtureCourtId(1),
      ]);
      expect(
        new Set(
          suggestions.flatMap((group) => [...group.teamA, ...group.teamB]),
        ).size,
      ).toBe(8);
      for (const group of suggestions)
        expect(
          validateSimpleTeams(
            group.teamA,
            group.teamB,
            session.state.participants,
          ),
        ).toBeNull();
    },
  );
  it("ranks actual current waits before UUID and ignores unknown gender", () => {
    const session = sessionFor("MMMMM?");
    session.state.participants[fixtureParticipantId(1)].presence[0].from +=
      30_000;
    session.advanceMinutes(2);
    expect(new Set(selectedIds(session))).toEqual(new Set(ids([2, 3, 4, 5])));
    expect(selectedIds(sessionFor("?MMMM"))).toEqual(ids([2, 3, 4, 5]));
  });
  it("maximises games before choosing the oldest feasible set", () => {
    const session = sessionFor("MMMMMMMFFF");
    expect(selectedIds(session)).toHaveLength(8);
    expect(new Set(selectedIds(session))).toEqual(
      new Set(ids([1, 2, 3, 4, 5, 6, 8, 9])),
    );
  });
  it("excludes rest until its exact expiry and excludes absent players", () => {
    const session = sessionFor("MMMMM");
    const participant = session.state.participants[fixtureParticipantId(1)];
    participant.skips.push({
      from: session.now,
      to: null,
      returnsAt: session.now + 600_000,
      skippedBySeq: 2,
    });
    expect(selectedIds(session)).toEqual(ids([2, 3, 4, 5]));
    session.advanceMinutes(10);
    session.state.participants[fixtureParticipantId(5)].presence[0].to =
      session.now;
    expect(selectedIds(session)).toHaveLength(4);
    expect(selectedIds(session)).toContain(fixtureParticipantId(1));
    participant.presence[0].to = session.now;
    expect(selectedIds(session)).not.toContain(fixtureParticipantId(1));
  });
  it("returns no suggestions without policy, after end or at the real deadline", () => {
    const session = sessionFor("MMMM");
    session.config.policyVersion = undefined;
    expect(selectedIds(session)).toEqual([]);
    session.config.policyVersion = "simple-social-v1";
    session.advanceMinutes(120);
    expect(selectedIds(session)).toEqual([]);
    session.now -= 1;
    expect(selectedIds(session)).toHaveLength(4);
    session.state.phase = "ended";
    expect(selectedIds(session)).toEqual([]);
  });
  it("reserves called players on unrequested courts and deduplicates requested courts", () => {
    const session = sessionFor("MMMMMMMMMMMM", 3);
    session.state.courts[fixtureCourtId(3)].nextGroup = {
      calledEventId: "call",
      teamA: ids([1, 2]),
      teamB: ids([3, 4]),
    };
    const suggestions = simpleRecommend(session.state, session.now, [
      fixtureCourtId(2),
      fixtureCourtId(2),
      fixtureCourtId(1),
      fixtureCourtId(3),
      "unknown",
    ]);
    expect(suggestions).toHaveLength(2);
    expect(
      new Set(suggestions.flatMap((group) => [...group.teamA, ...group.teamB])),
    ).toEqual(new Set(ids([5, 6, 7, 8, 9, 10, 11, 12])));
  });
  it("prepares a busy court using only players available now without forecasting", () => {
    const session = sessionFor("MMMMMMMM");
    session.startMatch(1, ids([1, 2]), ids([3, 4]));
    session.advanceMinutes(30);
    expect(selectedIds(session, [1])).toEqual(ids([5, 6, 7, 8]));
  });
  it("regroups the same oldest set to avoid third mixed games; abandoned games do not count", () => {
    const session = sessionFor("MMFFMMFFMMFF");
    for (let round = 0; round < 2; round += 1) {
      for (const [court, male, female] of [
        [1, [1, 2], [3, 4]],
        [2, [5, 6], [7, 8]],
      ] as const) {
        const match = session.startMatch(
          court,
          ids([male[0], female[0]]),
          ids([male[1], female[1]]),
        );
        session.advanceMinutes(1);
        session.apply("MatchCompleted", { matchId: match });
      }
    }
    // Keep precisely the first eight oldest, so variety cannot take a newer ninth.
    for (let number = 9; number <= 12; number += 1)
      session.state.participants[
        fixtureParticipantId(number)
      ].presence[0].from = session.now;
    const abandoned = session.startMatch(1, ids([1, 2]), ids([5, 6]));
    session.apply("MatchAbandoned", { matchId: abandoned });
    const groups = simpleRecommend(session.state, session.now, [
      fixtureCourtId(1),
      fixtureCourtId(2),
    ]);
    expect(
      new Set(groups.flatMap((group) => [...group.teamA, ...group.teamB])),
    ).toEqual(new Set(ids([1, 2, 3, 4, 5, 6, 7, 8])));
    for (const group of groups)
      expect(
        new Set(
          [...group.teamA, ...group.teamB].map(
            (id) => session.state.participants[id].participant.gender,
          ),
        ).size,
      ).toBe(1);
  });
  it("matches exhaustive feasible-set selection for every eight-player gender roster", () => {
    for (let gendersMask = 0; gendersMask < 256; gendersMask += 1) {
      const genders = Array.from({ length: 8 }, (_, index) =>
        gendersMask & (1 << index) ? "M" : "F",
      ).join("");
      const session = sessionFor(genders);
      let expected: number[] = [];
      for (let subset = 0; subset < 256; subset += 1) {
        const chosen = Array.from(
          { length: 8 },
          (_, index) => index + 1,
        ).filter((number) => subset & (1 << (number - 1)));
        if (chosen.length % 4 !== 0) continue;
        const maleCount = chosen.filter(
          (number) => genders[number - 1] === "M",
        ).length;
        if (maleCount % 2 !== 0) continue;
        const firstDifference = chosen.findIndex(
          (number, index) => number !== expected[index],
        );
        if (
          chosen.length > expected.length ||
          (chosen.length === expected.length &&
            firstDifference >= 0 &&
            chosen[firstDifference] < expected[firstDifference])
        )
          expected = chosen;
      }
      expect([...selectedIds(session)].sort()).toEqual(ids(expected).sort());
    }
  });
  it("prefers mixed games after two same-sex games without changing the selected set", () => {
    const session = sessionFor("MMMMFFFF");
    for (let round = 0; round < 2; round += 1) {
      for (const [court, teamA, teamB] of [
        [1, [1, 2], [3, 4]],
        [2, [5, 6], [7, 8]],
      ] as const) {
        const match = session.startMatch(
          court,
          ids([...teamA]),
          ids([...teamB]),
        );
        session.advanceMinutes(1);
        session.apply("MatchCompleted", { matchId: match });
      }
    }
    const groups = simpleRecommend(session.state, session.now, [
      fixtureCourtId(1),
      fixtureCourtId(2),
    ]);
    expect(
      new Set(groups.flatMap((group) => [...group.teamA, ...group.teamB])),
    ).toEqual(new Set(ids([1, 2, 3, 4, 5, 6, 7, 8])));
    for (const group of groups) {
      for (const team of [group.teamA, group.teamB])
        expect(
          team
            .map((id) => session.state.participants[id].participant.gender)
            .sort(),
        ).toEqual(["female", "male"]);
    }
  });
  it("is deterministic, leaves input unchanged and handles 320 players / 50 courts", () => {
    const session = sessionFor("MMFF".repeat(80), 50);
    const before = structuredClone(session.state);
    const courts = Array.from({ length: 50 }, (_, index) =>
      fixtureCourtId(50 - index),
    );
    const started = performance.now();
    const groups = simpleRecommend(session.state, session.now, courts);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(groups).toHaveLength(50);
    expect(
      new Set(groups.flatMap((group) => [...group.teamA, ...group.teamB])).size,
    ).toBe(200);
    expect(simpleRecommend(session.state, session.now, courts)).toEqual(groups);
    expect(session.state).toEqual(before);
  });
  it("does not move older players between busy and free courts for variety", () => {
    const session = sessionFor("MMMMFFFFMMMM");
    for (let round = 0; round < 2; round += 1) {
      for (const [court, teamA, teamB] of [
        [1, [1, 2], [3, 4]],
        [2, [5, 6], [7, 8]],
      ] as const) {
        const match = session.startMatch(
          court,
          ids([...teamA]),
          ids([...teamB]),
        );
        session.advanceMinutes(1);
        session.apply("MatchCompleted", { matchId: match });
      }
    }
    session.startMatch(1, ids([9, 10]), ids([11, 12]));
    for (const requested of [
      [1, 2],
      [2, 1],
    ]) {
      const groups = simpleRecommend(
        session.state,
        session.now,
        requested.map(fixtureCourtId),
      );
      expect(groups.map((group) => group.courtId)).toEqual(
        requested.map(fixtureCourtId),
      );
      expect(new Set([...groups[0].teamA, ...groups[0].teamB])).toEqual(
        new Set(ids([1, 2, 3, 4])),
      );
      expect(new Set([...groups[1].teamA, ...groups[1].teamB])).toEqual(
        new Set(ids([5, 6, 7, 8])),
      );
    }
  });
});
