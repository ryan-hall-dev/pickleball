// simple-social-v2 (docs/plans/reclub-to-court-v1.md, Phase 2): Up next
// confirmations, open breaks, group moves and swaps, close after this game,
// and when a court's next four are due. v1 rules are in simplePolicy.test.ts.
import { describe, expect, it } from "vitest";
import { replay } from "./applyEvent";
import { compensate } from "./compensate";
import { playerMetrics } from "./metrics";
import {
  dueCourtIds,
  isUpNextReadyToPlay,
  reservedCourtId,
} from "./simplePolicy";
import {
  fixtureCourtId,
  makeConfig,
  makeParticipants,
  MINUTE_MS,
  TestSession,
} from "./testing/fixtures";
import type { Participant, SessionConfig } from "./types";
import {
  arrangeTeams,
  simpleRecommend,
  simpleRefill,
} from "../schedule/simpleRecommend";
import { friendPairOf } from "./pairHandlers";

function v2Session(courts = 2, overrides: Partial<SessionConfig> = {}) {
  const participants: Participant[] = makeParticipants(16).map((player, i) => ({
    ...player,
    skill: "intermediate",
    gender: i < 8 ? "male" : "female",
  }));
  const config: SessionConfig = {
    ...makeConfig({ participants, courts }),
    policyVersion: "simple-social-v2",
    ...overrides,
  };
  const session = new TestSession();
  session.apply("SessionStarted", {
    config,
    initialAttendeeIds: participants.map((p) => p.participantId),
  });
  const ids = participants.map((p) => p.participantId);
  // Four men: a valid all-men game.
  const call = (court: number, players = ids.slice(0, 4)) =>
    session.apply("NextGroupCalled", {
      courtId: fixtureCourtId(court),
      teamA: players.slice(0, 2),
      teamB: players.slice(2, 4),
    });
  return { session, ids, config, call };
}

function code(result: ReturnType<TestSession["tryApply"]>) {
  return result.ok ? null : result.error.code;
}

const group = (session: TestSession, court: number) =>
  session.state.courts[fixtureCourtId(court)].nextGroup;

describe("simple-social-v2", () => {
  it("validates the Up next timer, and only v2 has one", () => {
    const { config } = v2Session();
    for (const upNextAfterMinutes of [0, 31, 2.5]) {
      expect(
        code(
          new TestSession().tryApply("SessionStarted", {
            config: { ...config, upNextAfterMinutes },
            initialAttendeeIds: [],
          }),
        ),
      ).toBe("INVALID_CONFIG");
    }
    expect(
      code(
        new TestSession().tryApply("SessionStarted", {
          config: {
            ...config,
            policyVersion: "simple-social-v1",
            upNextAfterMinutes: 6,
          },
          initialAttendeeIds: [],
        }),
      ),
    ).toBe("INVALID_CONFIG");
  });

  it("records confirmations; all four on a free court is ready to play", () => {
    const { session, ids, call } = v2Session();
    const called = call(1);
    expect(group(session, 1)?.confirmedIds).toEqual([]);
    for (const id of ids.slice(0, 4)) {
      expect(isUpNextReadyToPlay(session.state, fixtureCourtId(1))).toBe(false);
      session.apply("NextGroupSeatConfirmed", {
        calledEventId: called.eventId,
        participantId: id,
      });
    }
    expect(isUpNextReadyToPlay(session.state, fixtureCourtId(1))).toBe(true);
    expect(
      code(
        session.tryApply("NextGroupSeatConfirmed", {
          calledEventId: called.eventId,
          participantId: ids[0],
        }),
      ),
    ).toBe("ALREADY_CONFIRMED");
    expect(
      code(
        session.tryApply("NextGroupSeatConfirmed", {
          calledEventId: called.eventId,
          participantId: ids[9],
        }),
      ),
    ).toBe("NOT_IN_CALLED_GROUP");
  });

  it("a break empties only that seat; the other three keep their confirmations, a replacement starts unconfirmed", () => {
    const { session, ids, call } = v2Session();
    const called = call(1);
    for (const id of ids.slice(0, 4))
      session.apply("NextGroupSeatConfirmed", {
        calledEventId: called.eventId,
        participantId: id,
      });
    session.apply("PlayerSkipped", { participantId: ids[1], reason: "break" });
    expect(group(session, 1)).toMatchObject({
      teamA: [ids[0], null],
      confirmedIds: [ids[0], ids[2], ids[3]],
    });
    expect(isUpNextReadyToPlay(session.state, fixtureCourtId(1))).toBe(false);
    // A stale reply from the player who left the group is refused.
    expect(
      code(
        session.tryApply("NextGroupSeatConfirmed", {
          calledEventId: called.eventId,
          participantId: ids[1],
        }),
      ),
    ).toBe("NOT_IN_CALLED_GROUP");
    session.apply("NextGroupChanged", {
      calledEventId: called.eventId,
      teamA: [ids[0], ids[4]],
      teamB: [ids[2], ids[3]],
    });
    expect(group(session, 1)?.confirmedIds).toEqual([ids[0], ids[2], ids[3]]);
  });

  it("a break is open-ended with a reason, freezes the wait, and Ready ends it", () => {
    const { session, ids } = v2Session();
    session.advanceMinutes(7);
    expect(
      code(
        session.tryApply("PlayerSkipped", {
          participantId: ids[0],
          returnsAt: session.now + 10 * MINUTE_MS,
          reason: "break",
        }),
      ),
    ).toBe("MALFORMED_EVENT");
    expect(
      code(session.tryApply("PlayerSkipped", { participantId: ids[0] })),
    ).toBe("MALFORMED_EVENT");
    const skip = session.apply("PlayerSkipped", {
      participantId: ids[0],
      reason: "noReply",
    });
    session.advanceMinutes(20);
    const metrics = () =>
      playerMetrics(session.state, session.now).find(
        (player) => player.participantId === ids[0],
      )!;
    expect(metrics()).toMatchObject({
      status: "skipped",
      currentWaitMs: 7 * MINUTE_MS,
    });
    expect(session.state.participants[ids[0]].skips.at(-1)?.reason).toBe(
      "noReply",
    );
    const ready = compensate(session.state, skip.seq, session.nextMeta());
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    session.apply(ready.event.type, ready.event.payload);
    session.advanceMinutes(3);
    expect(metrics()).toMatchObject({
      status: "waiting",
      currentWaitMs: 10 * MINUTE_MS,
    });
  });

  it("moves a group to a free court, swapping with a group there; never onto a busy court", () => {
    const { session, ids, call } = v2Session(3);
    const first = call(1);
    session.apply("NextGroupSeatConfirmed", {
      calledEventId: first.eventId,
      participantId: ids[0],
    });
    call(2, ids.slice(4, 8));
    session.apply("NextGroupMoved", {
      calledEventId: first.eventId,
      toCourtId: fixtureCourtId(2),
    });
    expect(group(session, 2)).toMatchObject({
      calledEventId: first.eventId,
      confirmedIds: [ids[0]],
    });
    expect(group(session, 1)?.teamA).toEqual(ids.slice(4, 6));
    expect(reservedCourtId(session.state, ids[0])).toBe(fixtureCourtId(2));
    // Court 3 is busy: the group can't move there.
    session.apply("MatchStarted", {
      matchId: "match-3",
      courtId: fixtureCourtId(3),
      teamA: ids.slice(8, 10),
      teamB: ids.slice(10, 12),
    });
    expect(
      code(
        session.tryApply("NextGroupMoved", {
          calledEventId: first.eventId,
          toCourtId: fixtureCourtId(3),
        }),
      ),
    ).toBe("COURT_BUSY");
  });

  it("close after this game releases the Up next group, blocks new groups, and can be undone", () => {
    const { session, ids, call } = v2Session();
    session.apply("MatchStarted", {
      matchId: "match-1",
      courtId: fixtureCourtId(1),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    });
    call(1, ids.slice(4, 8));
    const scheduled = session.apply("CourtCloseScheduled", {
      courtId: fixtureCourtId(1),
    });
    expect(group(session, 1)).toBeNull();
    expect(reservedCourtId(session.state, ids[4])).toBeNull();
    expect(
      code(
        session.tryApply("NextGroupCalled", {
          courtId: fixtureCourtId(1),
          teamA: ids.slice(4, 6),
          teamB: ids.slice(6, 8),
        }),
      ),
    ).toBe("COURT_CLOSED");
    expect(dueCourtIds(session.state, session.now)).not.toContain(
      fixtureCourtId(1),
    );
    const cancel = compensate(session.state, scheduled.seq, session.nextMeta());
    expect(cancel.ok).toBe(true);
    if (!cancel.ok) return;
    session.apply(cancel.event.type, cancel.event.payload);
    expect(
      session.state.courts[fixtureCourtId(1)].closeScheduledBySeq,
    ).toBeNull();
    // A free court is closed straight away, not scheduled.
    expect(
      code(
        session.tryApply("CourtCloseScheduled", {
          courtId: fixtureCourtId(2),
        }),
      ),
    ).toBe("MATCH_NOT_ACTIVE");
  });

  it("a closing court closes when its game ends and takes no new game", () => {
    const { session, ids } = v2Session();
    session.apply("MatchStarted", {
      matchId: "match-1",
      courtId: fixtureCourtId(1),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    });
    session.apply("CourtCloseScheduled", { courtId: fixtureCourtId(1) });
    session.apply("MatchCompleted", { matchId: "match-1" });
    expect(
      code(
        session.tryApply("MatchStarted", {
          matchId: "match-2",
          courtId: fixtureCourtId(1),
          teamA: ids.slice(4, 6),
          teamB: ids.slice(6, 8),
        }),
      ),
    ).toBe("COURT_CLOSED");
    session.apply("CourtClosed", { courtId: fixtureCourtId(1) });
    expect(
      session.state.courts[fixtureCourtId(1)].closeScheduledBySeq,
    ).toBeNull();
  });

  it("asks the next four for a free court first, then games past the timer, oldest first", () => {
    const { session, ids } = v2Session(3, { upNextAfterMinutes: 6 });
    session.apply("MatchStarted", {
      matchId: "match-2",
      courtId: fixtureCourtId(2),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    });
    session.advanceMinutes(1);
    session.apply("MatchStarted", {
      matchId: "match-1",
      courtId: fixtureCourtId(1),
      teamA: ids.slice(4, 6),
      teamB: ids.slice(6, 8),
    });
    expect(dueCourtIds(session.state, session.now)).toEqual([
      fixtureCourtId(3),
    ]);
    expect(dueCourtIds(session.state, session.now + 5 * MINUTE_MS)).toEqual([
      fixtureCourtId(3),
      fixtureCourtId(2),
    ]);
    expect(dueCourtIds(session.state, session.now + 6 * MINUTE_MS)).toEqual([
      fixtureCourtId(3),
      fixtureCourtId(2),
      fixtureCourtId(1),
    ]);
  });

  it("an undone start brings back the group with its confirmations", () => {
    const { session, ids, call } = v2Session();
    const called = call(1);
    for (const id of ids.slice(0, 4))
      session.apply("NextGroupSeatConfirmed", {
        calledEventId: called.eventId,
        participantId: id,
      });
    const started = session.apply("MatchStarted", {
      matchId: "match-1",
      courtId: fixtureCourtId(1),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
      calledEventId: called.eventId,
    });
    const undo = compensate(session.state, started.seq, session.nextMeta());
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    session.apply(undo.event.type, undo.event.payload);
    expect(group(session, 1)?.confirmedIds).toEqual(ids.slice(0, 4));
  });

  it("replays to the same state", () => {
    const { session, ids, call } = v2Session();
    const called = call(1);
    session.apply("NextGroupSeatConfirmed", {
      calledEventId: called.eventId,
      participantId: ids[0],
    });
    session.apply("PlayerSkipped", { participantId: ids[1], reason: "break" });
    const replayed = replay(session.events);
    expect(replayed.ok).toBe(true);
    if (replayed.ok)
      expect(replayed.state.courts).toEqual(session.state.courts);
  });

  it("v1 logs are unchanged: a ten-minute rest, no confirmations", () => {
    const participants: Participant[] = makeParticipants(8).map((p, i) => ({
      ...p,
      skill: "beginner",
      gender: i < 4 ? "male" : "female",
    }));
    const session = new TestSession();
    session.apply("SessionStarted", {
      config: {
        ...makeConfig({ participants, courts: 1 }),
        policyVersion: "simple-social-v1",
      },
      initialAttendeeIds: participants.map((p) => p.participantId),
    });
    const ids = participants.map((p) => p.participantId);
    const called = session.apply("NextGroupCalled", {
      courtId: fixtureCourtId(1),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    });
    expect(group(session, 1)).not.toHaveProperty("confirmedIds");
    expect(
      code(
        session.tryApply("NextGroupSeatConfirmed", {
          calledEventId: called.eventId,
          participantId: ids[0],
        }),
      ),
    ).toBe("POLICY_ACTION_NOT_ALLOWED");
    expect(
      code(
        session.tryApply("PlayerSkipped", {
          participantId: ids[5],
          reason: "break",
        }),
      ),
    ).toBe("MALFORMED_EVENT");
  });

  describe("automatic replacement (D9)", () => {
    it("fills a rested player's seat with the longest-waiting valid player", () => {
      const { session, ids, call } = v2Session(1);
      // ids 0-7 men, 8-15 women. The group is men 0-3; Duy (1) rests.
      // The free men are 4-7; women would make the game invalid.
      const called = call(1);
      session.advanceMinutes(2);
      session.apply("PlayerSkipped", {
        participantId: ids[1],
        reason: "break",
      });
      const [refill] = simpleRefill(session.state, session.now);
      expect(refill.calledEventId).toBe(called.eventId);
      expect(refill.teamA[0]).toBe(ids[0]);
      expect(refill.teamB).toEqual(ids.slice(2, 4));
      expect(ids.slice(4, 8)).toContain(refill.teamA[1]);
      session.apply("NextGroupChanged", refill);
      expect(simpleRefill(session.state, session.now)).toEqual([]);
    });

    it("leaves the seat open when nobody valid is free", () => {
      const participants: Participant[] = makeParticipants(5).map((p, i) => ({
        ...p,
        skill: "beginner",
        gender: i < 4 ? "male" : "female",
      }));
      const session = new TestSession();
      session.apply("SessionStarted", {
        config: {
          ...makeConfig({ participants, courts: 1 }),
          policyVersion: "simple-social-v2",
        },
        initialAttendeeIds: participants.map((p) => p.participantId),
      });
      const ids = participants.map((p) => p.participantId);
      session.apply("NextGroupCalled", {
        courtId: fixtureCourtId(1),
        teamA: ids.slice(0, 2),
        teamB: ids.slice(2, 4),
      });
      session.apply("PlayerLeft", { participantId: ids[3] });
      // Only a woman is free: three men and a woman is never valid.
      expect(simpleRefill(session.state, session.now)).toEqual([]);
    });
  });

  describe("friend pairs (D4) and teams (D7)", () => {
    it("needs both to agree; a break ends the pair and the friend keeps their place", () => {
      const { session, ids } = v2Session(1);
      expect(
        code(
          session.tryApply("FriendPairRequested", {
            participantId: ids[0],
            friendId: ids[0],
          }),
        ),
      ).toBe("INVALID_PAIR");
      const asked = session.apply("FriendPairRequested", {
        participantId: ids[0],
        friendId: ids[8],
      });
      expect(
        code(
          session.tryApply("FriendPairRequested", {
            participantId: ids[1],
            friendId: ids[8],
          }),
        ),
      ).toBe("ALREADY_PAIRED");
      session.apply("FriendPairAccepted", { requestSeq: asked.seq });
      expect(friendPairOf(session.state, ids[8])?.status).toBe("accepted");
      session.apply("PlayerSkipped", {
        participantId: ids[0],
        reason: "break",
      });
      expect(friendPairOf(session.state, ids[8])).toBeNull();
    });

    it("a pair waits as its shorter wait and plays on one team", () => {
      const { session, ids } = v2Session(1);
      // Everyone but man 7 and woman 15 plays first, so those two wait longest.
      session.apply("MatchStarted", {
        matchId: "warmup",
        courtId: fixtureCourtId(1),
        teamA: [ids[0], ids[1]],
        teamB: [ids[2], ids[3]],
      });
      session.advanceMinutes(10);
      session.apply("MatchCompleted", { matchId: "warmup" });
      session.advanceMinutes(1);
      // Man 0 (just played) and woman 15 (waited longest) team up.
      const asked = session.apply("FriendPairRequested", {
        participantId: ids[0],
        friendId: ids[15],
      });
      session.apply("FriendPairAccepted", { requestSeq: asked.seq });
      const [group] = simpleRecommend(session.state, session.now, [
        fixtureCourtId(1),
      ]);
      const four = [...group.teamA, ...group.teamB];
      // Ranked by man 0's shorter wait, the pair loses to four who waited longer.
      expect(four).not.toContain(ids[0]);
      expect(four).not.toContain(ids[15]);
    });

    it("keeps a pair together on one team when they are picked, and a start uses the pair up", () => {
      const { session, ids } = v2Session(3);
      const asked = session.apply("FriendPairRequested", {
        participantId: ids[4],
        friendId: ids[12],
      });
      session.apply("FriendPairAccepted", { requestSeq: asked.seq });
      const groups = simpleRecommend(session.state, session.now, [
        fixtureCourtId(1),
        fixtureCourtId(2),
        fixtureCourtId(3),
      ]);
      const group = groups.find((candidate) =>
        [...candidate.teamA, ...candidate.teamB].includes(ids[4]),
      )!;
      const team = group.teamA.includes(ids[4]) ? group.teamA : group.teamB;
      expect(team).toContain(ids[12]);
      session.apply("MatchStarted", {
        matchId: "with-friend",
        courtId: group.courtId,
        teamA: group.teamA,
        teamB: group.teamB,
      });
      expect(friendPairOf(session.state, ids[4])).toBeNull();
    });

    it("splits four into teams with the fewest repeat partners, then the closest skill", () => {
      const { session, ids } = v2Session(1);
      // Men 0 and 1 partner once.
      session.apply("MatchStarted", {
        matchId: "first",
        courtId: fixtureCourtId(1),
        teamA: [ids[0], ids[1]],
        teamB: [ids[2], ids[3]],
      });
      session.apply("MatchCompleted", { matchId: "first" });
      const [teamA, teamB] = arrangeTeams(
        session.state,
        session.now,
        [ids[0], ids[1], ids[2], ids[3]],
        [],
      );
      expect(teamA).not.toEqual([ids[0], ids[1]]);
      expect([...teamA, ...teamB].sort()).toEqual(ids.slice(0, 4).sort());
    });
  });
});
