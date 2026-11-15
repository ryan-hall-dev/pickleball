import { describe, expect, it } from "vitest";
import {
  makeConfig,
  makeParticipants,
  TestSession,
  fixtureCourtId,
  MINUTE_MS,
} from "./testing/fixtures";
import { playerMetrics } from "./metrics";
import { applyEvent, replay } from "./applyEvent";
import { reservedCourtId } from "./simplePolicy";
import type { Participant, SessionConfig } from "./types";

function simpleSession() {
  const participants: Participant[] = makeParticipants(12).map((player, i) => ({
    ...player,
    skill: "intermediate",
    gender: i < 6 ? "male" : "female",
  }));
  const config: SessionConfig = {
    ...makeConfig({ participants, courts: 2 }),
    policyVersion: "simple-social-v1",
  };
  const session = new TestSession();
  session.apply("SessionStarted", {
    config,
    initialAttendeeIds: participants.map((p) => p.participantId),
  });
  const ids = participants.map((p) => p.participantId);
  return { session, ids, config };
}
function code(result: ReturnType<TestSession["tryApply"]>) {
  return result.ok ? null : result.error.code;
}

describe("simple social session rules", () => {
  it("requires known gender and level, doubles courts, and preserves legacy sessions", () => {
    const { config } = simpleSession();
    for (const invalid of [
      {
        ...config,
        participants: config.participants.map((p) => ({
          ...p,
          gender: undefined,
        })),
      },
      {
        ...config,
        participants: config.participants.map((p) => ({ ...p, skill: null })),
      },
      {
        ...config,
        courts: config.courts.map((c) => ({
          ...c,
          format: "singles" as const,
        })),
      },
    ]) {
      expect(
        code(
          new TestSession().tryApply("SessionStarted", {
            config: invalid,
            initialAttendeeIds: [],
          }),
        ),
      ).toBe("INVALID_CONFIG");
    }
    expect(
      TestSession.start({ participantCount: 4, format: "singles" }).state.phase,
    ).toBe("live");
  });
  it("freezes earned wait for ten minutes and returns without another event", () => {
    const { session, ids } = simpleSession();
    session.now += 7 * MINUTE_MS;
    const rest = session.apply("PlayerSkipped", {
      participantId: ids[0],
      returnsAt: session.now + 10 * MINUTE_MS,
    });
    const at = (minutes: number) =>
      playerMetrics(session.state, rest.at + minutes * MINUTE_MS).find(
        (p) => p.participantId === ids[0],
      )!;
    expect(at(9).status).toBe("skipped");
    expect(at(9).currentWaitMs).toBe(7 * MINUTE_MS);
    expect(at(10).status).toBe("waiting");
    expect(at(12).currentWaitMs).toBe(9 * MINUTE_MS);
    session.now += 12 * MINUTE_MS;
    expect(
      code(session.tryApply("PlayerUnskipped", { targetSeq: rest.seq })),
    ).toBe("PLAYER_NOT_SKIPPED");
    session.apply("PlayerSkipped", {
      participantId: ids[0],
      returnsAt: session.now + 10 * MINUTE_MS,
    });
    expect(
      playerMetrics(session.state, session.now).find(
        (p) => p.participantId === ids[0],
      )?.currentWaitMs,
    ).toBe(9 * MINUTE_MS);
    expect(replay(session.events).ok).toBe(true);
  });
  it("Ready now ends rest early without losing earlier waiting", () => {
    const { session, ids } = simpleSession();
    session.now += 7 * MINUTE_MS;
    const rest = session.apply("PlayerSkipped", {
      participantId: ids[0],
      returnsAt: session.now + 10 * MINUTE_MS,
    });
    session.now += 3 * MINUTE_MS;
    session.apply("PlayerUnskipped", { targetSeq: rest.seq });
    session.now += 2 * MINUTE_MS;
    expect(
      playerMetrics(session.state, session.now).find(
        (p) => p.participantId === ids[0],
      )?.currentWaitMs,
    ).toBe(9 * MINUTE_MS);
    expect(
      code(session.tryApply("PlayerSkipped", { participantId: ids[0] })),
    ).toBe("MALFORMED_EVENT");
  });
  it("validates all same-sex and mixed teams, including manual replacements", () => {
    const { session, ids } = simpleSession();
    expect(
      code(
        session.tryApply("MatchStarted", {
          matchId: "invalid",
          courtId: fixtureCourtId(1),
          teamA: ids.slice(0, 2),
          teamB: [ids[2], ids[6]],
        }),
      ),
    ).toBe("INVALID_TEAMS");
    expect(
      code(
        session.tryApply("MatchStarted", {
          matchId: "invalid",
          courtId: fixtureCourtId(1),
          teamA: ids.slice(0, 2),
          teamB: ids.slice(6, 8),
        }),
      ),
    ).toBe("INVALID_TEAMS");
    const matchId = session.startMatch(1, [ids[0], ids[6]], [ids[1], ids[7]]);
    expect(
      code(
        session.tryApply("PlayerReplaced", {
          matchId,
          outId: ids[0],
          inId: ids[8],
          countGameForOut: false,
        }),
      ),
    ).toBe("INVALID_TEAMS");
    session.apply("PlayerReplaced", {
      matchId,
      outId: ids[0],
      inId: ids[2],
      countGameForOut: false,
    });
    session.apply("MatchCompleted", { matchId });
    session.startMatch(1, ids.slice(6, 8), ids.slice(8, 10));
  });
  it("keeps called groups stable, reserves across courts, and consumes the exact call", () => {
    const { session, ids } = simpleSession();
    const lineup = {
      courtId: fixtureCourtId(1),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    };
    const call = session.apply("NextGroupCalled", lineup);
    expect(
      code(
        session.tryApply("NextGroupCalled", {
          ...lineup,
          courtId: fixtureCourtId(2),
        }),
      ),
    ).toBe("PLAYER_RESERVED");
    expect(
      code(
        session.tryApply("MatchStarted", {
          ...lineup,
          courtId: fixtureCourtId(2),
          matchId: "wrong-court",
        }),
      ),
    ).toBe("PLAYER_RESERVED");
    expect(
      code(
        session.tryApply("MatchStarted", { ...lineup, matchId: "no-call-id" }),
      ),
    ).toBe("UNKNOWN_CALLED_GROUP");
    session.now += 3 * MINUTE_MS;
    expect(playerMetrics(session.state, session.now)[0].currentWaitMs).toBe(
      3 * MINUTE_MS,
    );
    const before = session.state;
    session.apply("MatchStarted", {
      ...lineup,
      matchId: "called-match",
      calledEventId: call.eventId,
    });
    expect(session.state.courts[lineup.courtId].nextGroup).toBeNull();
    expect(before.courts[lineup.courtId].nextGroup?.calledEventId).toBe(
      call.eventId,
    );
    expect(replay(session.events)).toEqual({ ok: true, state: session.state });
  });
  it("vacates only the resting or departed player's seat and requires explicit replacement", () => {
    const { session, ids } = simpleSession();
    const lineup = {
      courtId: fixtureCourtId(1),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    };
    const call = session.apply("NextGroupCalled", lineup);
    const rest = session.apply("PlayerSkipped", {
      participantId: ids[0],
      returnsAt: session.now + 10 * MINUTE_MS,
    });
    expect(session.state.courts[lineup.courtId].nextGroup?.teamA).toEqual([
      null,
      ids[1],
    ]);
    expect(
      code(
        session.tryApply("NextGroupChanged", {
          ...lineup,
          calledEventId: call.eventId,
        }),
      ),
    ).toBe("PLAYER_SKIPPED");
    session.now += MINUTE_MS;
    session.apply("PlayerUnskipped", { targetSeq: rest.seq });
    expect(session.state.courts[lineup.courtId].nextGroup?.teamA[0]).toBeNull();
    session.apply("NextGroupChanged", {
      ...lineup,
      calledEventId: call.eventId,
      teamA: [ids[4], ids[1]],
    });
    session.apply("PlayerLeft", { participantId: ids[1] });
    expect(session.state.courts[lineup.courtId].nextGroup?.teamA).toEqual([
      ids[4],
      null,
    ]);
    session.apply("NextGroupReleased", { calledEventId: call.eventId });
    expect(session.state.courts[lineup.courtId].nextGroup).toBeNull();
  });
  it("prepares a busy court and leaves its group intact when the game finishes", () => {
    const { session, ids } = simpleSession();
    const matchId = session.startMatch(1, ids.slice(0, 2), ids.slice(2, 4));
    const lineup = {
      courtId: fixtureCourtId(1),
      teamA: ids.slice(6, 8),
      teamB: ids.slice(8, 10),
    };
    const call = session.apply("NextGroupCalled", lineup);
    expect(
      code(
        session.tryApply("MatchStarted", {
          ...lineup,
          matchId: "too-soon",
          calledEventId: call.eventId,
        }),
      ),
    ).toBe("COURT_BUSY");
    session.now += 10 * MINUTE_MS;
    const finish = session.apply("MatchCompleted", { matchId });
    expect(session.state.courts[lineup.courtId].nextGroup?.calledEventId).toBe(
      call.eventId,
    );
    expect(playerMetrics(session.state, session.now)[0].currentWaitMs).toBe(0);
    session.apply("MatchStarted", {
      ...lineup,
      matchId: "next",
      calledEventId: call.eventId,
    });
    expect(session.tryUndo(finish.seq).ok).toBe(false);
  });
  it("blocks starts/calls at the deadline while allowing completion and end", () => {
    const { session, ids } = simpleSession();
    const matchId = session.startMatch(1, ids.slice(0, 2), ids.slice(2, 4));
    const lineup = {
      courtId: fixtureCourtId(2),
      teamA: ids.slice(6, 8),
      teamB: ids.slice(8, 10),
    };
    const call = session.apply("NextGroupCalled", lineup);
    session.now += 120 * MINUTE_MS;
    expect(
      code(
        session.tryApply("MatchStarted", {
          ...lineup,
          matchId: "late",
          calledEventId: call.eventId,
        }),
      ),
    ).toBe("SESSION_TIME_UP");
    expect(
      code(
        session.tryApply("NextGroupCalled", {
          ...lineup,
          courtId: fixtureCourtId(1),
        }),
      ),
    ).toBe("SESSION_TIME_UP");
    session.apply("MatchCompleted", { matchId });
    session.apply("SessionEnded", {});
    expect(session.state.courts[lineup.courtId].nextGroup).toBeNull();
  });
  it("keeps simple-only controls out of legacy sessions and rejects pause/short-handed play", () => {
    const { session, ids } = simpleSession();
    expect(code(session.tryApply("Paused", {}))).toBe(
      "POLICY_ACTION_NOT_ALLOWED",
    );
    const matchId = session.startMatch(1, ids.slice(0, 2), ids.slice(2, 4));
    expect(
      code(
        session.tryApply("PlayerRemovedMidMatch", {
          matchId,
          participantId: ids[0],
          countGameForOut: false,
        }),
      ),
    ).toBe("POLICY_ACTION_NOT_ALLOWED");
    const legacy = TestSession.start();
    expect(
      code(
        legacy.tryApply("NextGroupCalled", {
          courtId: fixtureCourtId(1),
          teamA: ids.slice(0, 2),
          teamB: ids.slice(2, 4),
        }),
      ),
    ).toBe("INVALID_CONFIG");
  });
  it("restores the fixed call on false-start undo, without mutating input, and replays exactly", () => {
    const { session, ids } = simpleSession();
    const lineup = {
      courtId: fixtureCourtId(1),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    };
    const call = session.apply("NextGroupCalled", lineup);
    const start = session.apply("MatchStarted", {
      ...lineup,
      matchId: "false-start",
      calledEventId: call.eventId,
    });
    const before = structuredClone(session.state);
    const input = session.state;
    session.advanceMinutes(1);
    session.undo(start.seq);
    expect(input).toEqual(before);
    expect(session.state.courts[lineup.courtId].nextGroup).toEqual({
      teamA: lineup.teamA,
      teamB: lineup.teamB,
      calledEventId: call.eventId,
    });
    for (const id of [...lineup.teamA, ...lineup.teamB]) {
      expect(reservedCourtId(session.state, id, session.now)).toBe(
        lineup.courtId,
      );
      expect(session.state.participants[id].activeMatchId).toBeNull();
    }
    expect(replay(session.events)).toEqual({ ok: true, state: session.state });
  });
  it("blocks false-start undo behind a newer call until that call is explicitly released", () => {
    const { session, ids } = simpleSession();
    const courtId = fixtureCourtId(1);
    const call = session.apply("NextGroupCalled", {
      courtId,
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    });
    const start = session.apply("MatchStarted", {
      courtId,
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
      matchId: "false-start",
      calledEventId: call.eventId,
    });
    const newer = session.apply("NextGroupCalled", {
      courtId,
      teamA: ids.slice(6, 8),
      teamB: ids.slice(8, 10),
    });
    const before = structuredClone(session.state);
    const result = session.tryUndo(start.seq);
    expect(result.ok ? null : result.error.code).toBe("UNDO_BLOCKED");
    expect(session.state).toEqual(before);
    session.apply("NextGroupReleased", { calledEventId: newer.eventId });
    session.undo(start.seq);
    expect(session.state.courts[courtId].nextGroup?.calledEventId).toBe(
      call.eventId,
    );
    expect(replay(session.events)).toEqual({ ok: true, state: session.state });
  });
  it("keeps failed call consumption atomic for stale IDs, changed lineups and vacancies", () => {
    const { session, ids } = simpleSession();
    const lineup = {
      courtId: fixtureCourtId(1),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    };
    const call = session.apply("NextGroupCalled", lineup);
    for (const assignment of [
      { ...lineup, calledEventId: "stale" },
      { ...lineup, teamA: [ids[4], ids[1]], calledEventId: call.eventId },
    ]) {
      const before = structuredClone(session.state);
      expect(
        code(
          session.tryApply("MatchStarted", {
            ...assignment,
            matchId: "bad-start",
          }),
        ),
      ).toBe("UNKNOWN_CALLED_GROUP");
      expect(session.state).toEqual(before);
    }
    const left = session.apply("PlayerLeft", { participantId: ids[0] });
    session.undo(left.seq);
    expect(session.state.courts[lineup.courtId].nextGroup?.teamA[0]).toBeNull();
    expect(
      code(
        session.tryApply("MatchStarted", {
          ...lineup,
          calledEventId: call.eventId,
          matchId: "vacant",
        }),
      ),
    ).toBe("UNKNOWN_CALLED_GROUP");
  });
  it("uses the current event clock for automatic rest expiry in calls, starts and replacements", () => {
    for (const action of ["call", "start", "replace"] as const) {
      const { session, ids } = simpleSession();
      let matchId: string | undefined;
      if (action === "replace")
        matchId = session.startMatch(1, ids.slice(0, 2), ids.slice(2, 4));
      const restingId = action === "replace" ? ids[4] : ids[0];
      session.apply("PlayerSkipped", {
        participantId: restingId,
        returnsAt: session.now + 10 * MINUTE_MS,
      });
      session.now += 10 * MINUTE_MS;
      if (action === "replace")
        session.apply("PlayerReplaced", {
          matchId: matchId!,
          outId: ids[0],
          inId: restingId,
          countGameForOut: false,
        });
      else if (action === "call")
        session.apply("NextGroupCalled", {
          courtId: fixtureCourtId(1),
          teamA: ids.slice(0, 2),
          teamB: ids.slice(2, 4),
        });
      else session.startMatch(1, ids.slice(0, 2), ids.slice(2, 4));
      expect(replay(session.events)).toEqual({
        ok: true,
        state: session.state,
      });
    }
  });
  it("rejects incorrect rest deadlines and invalid late arrivals without changing state", () => {
    const { session, ids } = simpleSession();
    for (const offset of [0, 9 * MINUTE_MS, 11 * MINUTE_MS]) {
      expect(
        code(
          session.tryApply("PlayerSkipped", {
            participantId: ids[0],
            returnsAt: session.now + offset,
          }),
        ),
      ).toBe("MALFORMED_EVENT");
    }
    const participant = {
      ...makeParticipants(1)[0],
      participantId: "late-player",
      gender: "male" as const,
      skill: "beginner" as const,
    };
    const before = structuredClone(session.state);
    expect(
      code(
        session.tryApply("PlayerJoined", {
          participant: { ...participant, gender: undefined },
        }),
      ),
    ).toBe("INVALID_CONFIG");
    expect(
      code(
        session.tryApply("PlayerJoined", {
          participant: { ...participant, skill: null },
        }),
      ),
    ).toBe("INVALID_CONFIG");
    expect(session.state).toEqual(before);
    session.apply("PlayerJoined", { participant });
  });
  it("blocks undo finish while its players are called, but lets expired reservations lapse", () => {
    const { session, ids } = simpleSession();
    const matchId = session.startMatch(1, ids.slice(0, 2), ids.slice(2, 4));
    const finish = session.apply("MatchCompleted", { matchId });
    session.apply("NextGroupCalled", {
      courtId: fixtureCourtId(2),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    });
    const before = structuredClone(session.state);
    const result = session.tryUndo(finish.seq);
    expect(result.ok ? null : result.error.code).toBe("UNDO_BLOCKED");
    expect(session.state).toEqual(before);
    session.now += 120 * MINUTE_MS;
    session.undo(finish.seq);
    expect(session.state.matches[matchId].status).toBe("active");
    expect(replay(session.events)).toEqual({ ok: true, state: session.state });
  });
  it("protects called players from playing replacement and releases calls on court closure", () => {
    const { session, ids } = simpleSession();
    const matchId = session.startMatch(1, ids.slice(0, 2), ids.slice(2, 4));
    const courtId = fixtureCourtId(2);
    session.apply("NextGroupCalled", {
      courtId,
      teamA: [ids[4], ids[6]],
      teamB: [ids[5], ids[7]],
    });
    expect(
      code(
        session.tryApply("PlayerReplaced", {
          matchId,
          outId: ids[0],
          inId: ids[4],
          countGameForOut: false,
        }),
      ),
    ).toBe("PLAYER_RESERVED");
    const close = session.apply("CourtClosed", { courtId });
    expect(session.state.courts[courtId].nextGroup).toBeNull();
    session.undo(close.seq);
    expect(session.state.courts[courtId].nextGroup).toBeNull();
    session.apply("PlayerReplaced", {
      matchId,
      outId: ids[0],
      inId: ids[4],
      countGameForOut: false,
    });
  });
  it("rejects a co-host event stamped against an old sequence without mutating state", () => {
    const { session, ids } = simpleSession();
    const staleMeta = session.nextMeta();
    session.apply("NextGroupCalled", {
      courtId: fixtureCourtId(1),
      teamA: ids.slice(0, 2),
      teamB: ids.slice(2, 4),
    });
    const before = structuredClone(session.state);
    const result = applyEvent(session.state, {
      ...staleMeta,
      type: "NextGroupCalled",
      payload: {
        courtId: fixtureCourtId(2),
        teamA: ids.slice(6, 8),
        teamB: ids.slice(8, 10),
      },
    });
    expect(result.ok ? null : result.error.code).toBe("SEQ_NOT_INCREASING");
    expect(session.state).toEqual(before);
  });
});
