// @vitest-environment node
import { describe, expect, it } from "vitest";
import { simpleSessionDeadline } from "@/engine/session";
import {
  TestSession,
  fixtureCourtId,
  fixtureParticipantId,
  fixtureUuid,
  makeParticipants,
  MINUTE_MS,
} from "@/engine/session/testing/fixtures";
import { heldCourtIds, planAutoPreparation } from "./autoPreparePlan";

function sessionFor(genders: string, courts: number) {
  const participants = makeParticipants(genders.length).map(
    (participant, index) => ({
      ...participant,
      gender: genders[index] === "M" ? ("male" as const) : ("female" as const),
    }),
  );
  const session = TestSession.start({ participants, courts });
  session.config.policyVersion = "simple-social-v1";
  return session;
}
const plan = (session: TestSession) =>
  planAutoPreparation(session.state, session.now);
/** Prepares every court the planner fills, the way the server appends them. */
function prepare(session: TestSession) {
  const groups = plan(session);
  for (const group of groups)
    session.apply("NextGroupCalled", {
      courtId: group.courtId,
      teamA: group.teamA,
      teamB: group.teamB,
    });
  return groups;
}
const idsOf = (groups: ReturnType<typeof plan>) =>
  groups.flatMap((group) => [...group.teamA, ...group.teamB]);

describe("planAutoPreparation: initial allocation", () => {
  it.each([
    [4, 1],
    [7, 1],
    [16, 4],
  ])(
    "prepares %i eligible players into %i distinct group(s), in court order",
    (players, groupCount) => {
      const session = sessionFor("M".repeat(players), 4);
      const groups = plan(session);
      expect(groups).toHaveLength(groupCount);
      expect(groups.map((group) => group.courtId)).toEqual(
        [1, 2, 3, 4].slice(0, groupCount).map(fixtureCourtId),
      );
      expect(new Set(idsOf(groups)).size).toBe(groupCount * 4);
      // The engine accepts every group, and nothing more is planned.
      expect(prepare(session)).toHaveLength(groupCount);
      expect(plan(session)).toEqual([]);
      const reserved = Object.values(session.state.courts).flatMap((court) =>
        court.nextGroup
          ? [...court.nextGroup.teamA, ...court.nextGroup.teamB]
          : [],
      );
      expect(new Set(reserved).size).toBe(groupCount * 4);
    },
  );

  it("leaves the court free with three players: nothing is planned", () => {
    expect(plan(sessionFor("MMM", 2))).toEqual([]);
  });

  it("fills courts in court order and skips a court that is busy", () => {
    const session = sessionFor("MMMMMMMM", 2);
    const [first] = plan(session);
    session.apply("NextGroupCalled", {
      courtId: first.courtId,
      teamA: first.teamA,
      teamB: first.teamB,
    });
    session.apply("MatchStarted", {
      matchId: fixtureUuid("m", 1),
      courtId: first.courtId,
      calledEventId: fixtureUuid("e", 2),
      teamA: first.teamA,
      teamB: first.teamB,
    });
    expect(plan(session).map((group) => group.courtId)).toEqual([
      fixtureCourtId(2),
    ]);
  });
});

describe("planAutoPreparation: during the session", () => {
  const join = (session: TestSession, number: number) =>
    session.apply("PlayerJoined", {
      participant: {
        participantId: fixtureParticipantId(number),
        firstName: `Late${number}`,
        lastName: "Arrival",
        gender: "male",
        skill: "intermediate",
      },
    });

  it("an arrival that completes a group fills the next free court and never changes a prepared group", () => {
    const session = sessionFor("MMMMMMM", 2);
    const [court1] = prepare(session);
    const before = session.state.courts[court1.courtId].nextGroup;
    expect(plan(session)).toEqual([]);
    join(session, 8);
    const next = plan(session);
    expect(next.map((group) => group.courtId)).toEqual([fixtureCourtId(2)]);
    expect(idsOf(next)).toContain(fixtureParticipantId(8));
    expect(new Set([...idsOf(next), ...idsOf([court1])]).size).toBe(8);
    prepare(session);
    expect(session.state.courts[court1.courtId].nextGroup).toEqual(before);
  });

  it("arrivals stay waiting while every court is occupied or prepared", () => {
    const session = sessionFor("MMMMMMMM", 2);
    prepare(session);
    for (const number of [9, 10, 11, 12]) join(session, number);
    expect(plan(session)).toEqual([]);
  });

  it("a finished game prepares the next four for that court, not the four who just played", () => {
    const session = sessionFor("MMMMMMMM", 1);
    const [group] = prepare(session);
    const matchId = fixtureUuid("m", 3);
    session.apply("MatchStarted", {
      matchId,
      courtId: group.courtId,
      calledEventId: fixtureUuid("e", 2),
      teamA: group.teamA,
      teamB: group.teamB,
    });
    session.advanceMinutes(15);
    expect(plan(session)).toEqual([]); // busy court: nothing to prepare
    session.apply("MatchCompleted", { matchId });
    const next = plan(session);
    expect(next).toHaveLength(1);
    expect(next[0].courtId).toBe(group.courtId);
    const played = new Set([...group.teamA, ...group.teamB]);
    expect(idsOf(next).some((id) => played.has(id))).toBe(false);
  });

  it("never prepares resting, playing or already prepared players", () => {
    const session = sessionFor("MMMMM", 1);
    session.apply("PlayerSkipped", {
      participantId: fixtureParticipantId(1),
      returnsAt: session.now + 10 * MINUTE_MS,
    });
    const resting = plan(session);
    expect(idsOf(resting)).not.toContain(fixtureParticipantId(1));
    expect(resting).toHaveLength(1);
    session.apply("PlayerSkipped", {
      participantId: fixtureParticipantId(2),
      returnsAt: session.now + 10 * MINUTE_MS,
    });
    expect(plan(session)).toEqual([]); // three eligible players
    session.advanceMinutes(11);
    expect(plan(session)).toHaveLength(1); // rest ended with nobody opening the page
  });

  it("a prepared group records no playing time and keeps the waits running", () => {
    const session = sessionFor("MMMMMMMM", 2);
    prepare(session);
    session.advanceMinutes(10);
    for (const player of session.players()) {
      expect(player.playMs).toBe(0);
      expect(player.status).toBe("waiting");
      expect(player.currentWaitMs).toBe(10 * MINUTE_MS);
    }
  });

  it("prepares nothing once the session deadline has passed", () => {
    const session = sessionFor("MMMMMMMM", 2);
    session.now = simpleSessionDeadline(session.state)! + 1;
    expect(plan(session)).toEqual([]);
    const justBefore = sessionFor("MMMMMMMM", 2);
    justBefore.now = simpleSessionDeadline(justBefore.state)! - 1;
    expect(plan(justBefore)).toHaveLength(2);
  });
});

describe("planAutoPreparation: released courts stay released", () => {
  it("a host release holds the court until a game finishes on it", () => {
    const session = sessionFor("MMMMMMMMMMMM", 2);
    const [first] = prepare(session);
    const calledEventId =
      session.state.courts[first.courtId].nextGroup!.calledEventId;
    session.apply("NextGroupReleased", { calledEventId });
    expect(heldCourtIds(session.state)).toEqual(new Set([first.courtId]));
    expect(plan(session)).toEqual([]);
    // A manual call and a game on the held court clear the hold on finish.
    session.apply("NextGroupCalled", {
      courtId: first.courtId,
      teamA: first.teamA,
      teamB: first.teamB,
    });
    const manualCallId = fixtureUuid("e", session.state.lastSeq);
    const matchId = fixtureUuid("m", session.state.lastSeq + 1);
    session.apply("MatchStarted", {
      matchId,
      courtId: first.courtId,
      calledEventId: manualCallId,
      teamA: first.teamA,
      teamB: first.teamB,
    });
    expect(heldCourtIds(session.state).size).toBe(0);
    session.apply("MatchCompleted", { matchId });
    expect(plan(session).map((group) => group.courtId)).toEqual([
      first.courtId,
    ]);
  });
});
