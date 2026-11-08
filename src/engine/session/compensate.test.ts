// @vitest-environment node
// Undo through compensating actions (plan §3 table, §6): every reversible
// action type, rejection rules, out-of-order undo and undo chains.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyEvent, replay } from "./applyEvent";
import { compensate } from "./compensate";
import type { SessionErrorCode } from "./errors";
import {
  COMPENSATING_EVENT_TYPE,
  type ReversibleEventType,
  type MatchAssignment,
  type SessionEvent,
  type SessionEventPayloads,
} from "./events";
import {
  actionHistory,
  courtMetrics,
  matchRecords,
  playerMetrics,
  sessionClock,
} from "./metrics";
import {
  createInitialSessionState,
  currentLineup,
  isPresent,
  isSkipped,
  type MatchState,
  type SessionState,
} from "./state";
import { PLAYERS_PER_TEAM } from "./types";
import {
  TestSession,
  fixtureCourtId,
  fixtureParticipantId as p,
  makeCourt,
  makeParticipants,
  createSeededRandom,
} from "./testing/fixtures";

/**
 * State minus the audit trail. `history`, `lastSeq` and `lastAt` always change
 * on an undo (the undo is itself a logged action), and `startedMatchIds` keeps
 * undone match ids so they are never reused; all are excluded from "restores
 * the exact prior state" comparisons.
 */
function stateWithoutAuditTrail(state: SessionState): Partial<SessionState> {
  const comparable: Partial<SessionState> = { ...state };
  delete comparable.history;
  delete comparable.lastSeq;
  delete comparable.lastAt;
  delete comparable.startedMatchIds;
  return comparable;
}

/** Everything the UI and scheduler read, measured at `now`. */
function derivedViews(state: SessionState, now: number) {
  return {
    players: playerMetrics(state, now),
    courts: courtMetrics(state, now),
    clock: sessionClock(state, now),
    matches: matchRecords(state, now),
    queueOrder: state.queueOrder,
    suggestionSeed: state.suggestionSeed,
  };
}

const minutesMs = (count: number) => count * 60_000;

function expectUndoRejected(
  session: TestSession,
  targetSeq: number,
  code: SessionErrorCode,
) {
  const before = session.state;
  const result = session.tryUndo(targetSeq);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
    expect(result.error.message.length).toBeGreaterThan(0);
  }
  expect(session.state).toBe(before);
}

/** Applies an action, undoes it straight away, and returns the states either side. */
function applyThenUndo(
  session: TestSession,
  applyAction: () => SessionEvent,
  minutesBeforeUndo = 0,
) {
  const stateBefore = session.state;
  const action = applyAction();
  session.advanceMinutes(minutesBeforeUndo);
  const undoEvent = session.undo(action.seq);
  return { stateBefore, action, undoEvent, stateAfter: session.state };
}

describe("compensate builds the right event", () => {
  it("pairs every reversible action type with its compensating type", () => {
    expect(COMPENSATING_EVENT_TYPE).toEqual({
      PlayerJoined: "PlayerJoinReverted",
      PlayerLeft: "PlayerLeaveReverted",
      PlayerSkipped: "PlayerUnskipped",
      PlayerLocked: "PlayerUnlocked",
      CourtAdded: "CourtAddReverted",
      CourtClosed: "CourtReopened",
      MatchStarted: "MatchStartReverted",
      MatchCompleted: "MatchCompletionReverted",
      PlayerReplaced: "PlayerReplacementReverted",
      PlayerRemovedMidMatch: "PlayerRemovalReverted",
      MatchAbandoned: "MatchAbandonReverted",
      QueueReordered: "QueueReordered",
      SuggestionsShuffled: "SuggestionsShuffled",
      Paused: "Resumed",
      Resumed: "Paused",
    } satisfies Record<ReversibleEventType, string>);
  });

  it("stamps the caller's meta and targetSeq, and records compensatedBySeq on the target", () => {
    const session = TestSession.start();
    const skip = session.apply("PlayerSkipped", { participantId: p(1) });
    const meta = session.nextMeta();
    const result = compensate(session.state, skip.seq, meta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      ...meta,
      type: "PlayerUnskipped",
      payload: { targetSeq: skip.seq },
    });
    expect(result.state.lastSeq).toBe(meta.seq);
    expect(
      result.state.history.find((entry) => entry.event.seq === skip.seq)
        ?.compensatedBySeq,
    ).toBe(meta.seq);
    // compensate() is pure: the input state is untouched.
    expect(
      session.state.history.find((entry) => entry.event.seq === skip.seq)
        ?.compensatedBySeq,
    ).toBeNull();
  });

  it("produces the same state as applying the returned event", () => {
    const session = TestSession.start();
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(12);
    const completion = session.apply("MatchCompleted", { matchId });
    const result = compensate(
      session.state,
      completion.seq,
      session.nextMeta(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyEvent(session.state, result.event);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.state).toEqual(result.state);
  });
});

describe("undo restores the exact prior state", () => {
  it("PlayerJoined (first arrival) → PlayerJoinReverted: as if they never joined", () => {
    const session = TestSession.start({ participantCount: 4 });
    session.advanceMinutes(5);
    const [lateArrival] = makeParticipants(5).slice(4);
    const { stateBefore, stateAfter } = applyThenUndo(session, () =>
      session.apply("PlayerJoined", { participant: lateArrival }),
    );
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
    expect(stateAfter.participants[p(5)]).toBeUndefined();
  });

  it("PlayerJoined (a rejoin) → PlayerJoinReverted: only the new presence interval is removed", () => {
    const session = TestSession.start({ participantCount: 4 });
    session.advanceMinutes(5);
    session.apply("PlayerLeft", { participantId: p(1) });
    session.advanceMinutes(5);
    const participant = session.state.participants[p(1)].participant;
    const { stateBefore, stateAfter } = applyThenUndo(
      session,
      () => session.apply("PlayerJoined", { participant }),
      3,
    );
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
    expect(session.player(p(1)).status).toBe("away");
  });

  it("PlayerLocked → PlayerUnlocked", () => {
    const session = TestSession.start();
    const { stateBefore, stateAfter } = applyThenUndo(
      session,
      () =>
        session.apply("PlayerLocked", {
          participantId: p(1),
          courtId: fixtureCourtId(2),
        }),
      2,
    );
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
  });

  it("CourtAdded → CourtAddReverted", () => {
    const session = TestSession.start({ courts: 1 });
    const { stateBefore, stateAfter } = applyThenUndo(
      session,
      () => session.apply("CourtAdded", { court: makeCourt(2, "singles") }),
      4,
    );
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
    expect(session.courts()).toHaveLength(1);
  });

  it("MatchStarted → MatchStartReverted: players back to waiting, wait clocks continue, false start discarded", () => {
    const session = TestSession.start();
    session.advanceMinutes(6);
    const waitStartBefore = session.player(p(1)).currentWaitStartAt;
    const { stateBefore, stateAfter } = applyThenUndo(
      session,
      () => {
        session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
        return session.events[session.events.length - 1];
      },
      3,
    );
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
    expect(session.player(p(1))).toMatchObject({
      status: "waiting",
      currentWaitStartAt: waitStartBefore,
      playMs: 0,
      // 6 min before the false start plus 3 min during it.
      currentWaitMs: 9 * 60_000,
    });
    expect(session.courts()[0]).toMatchObject({ status: "free", busyMs: 0 });
  });

  it("MatchStarted → MatchStartReverted restores consumed locks and manual queue ranks", () => {
    const session = TestSession.start();
    session.apply("PlayerLocked", {
      participantId: p(2),
      courtId: fixtureCourtId(1),
    });
    session.apply("QueueReordered", {
      participantIds: [p(5), p(2), p(6), p(1)],
    });
    const { stateBefore, stateAfter } = applyThenUndo(session, () => {
      session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
      return session.events[session.events.length - 1];
    });
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
    expect(stateAfter.queueOrder).toEqual([p(5), p(2), p(6), p(1)]);
    expect(stateAfter.participants[p(2)].lock).toEqual(
      stateBefore.participants[p(2)].lock,
    );
  });

  it("MatchCompleted → MatchCompletionReverted: match live again with its games and times", () => {
    const session = TestSession.start();
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(14);
    const { stateBefore, stateAfter } = applyThenUndo(
      session,
      () => session.apply("MatchCompleted", { matchId }),
      2,
    );
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
    expect(session.player(p(1))).toMatchObject({
      status: "playing",
      gamesCompleted: 0,
      committedGames: 1,
      playMs: 16 * 60_000,
    });
  });

  it("MatchAbandoned → MatchAbandonReverted", () => {
    const session = TestSession.start();
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(5);
    const { stateBefore, stateAfter } = applyThenUndo(
      session,
      () => session.apply("MatchAbandoned", { matchId }),
      1,
    );
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
  });

  it.each([true, false])(
    "PlayerRemovedMidMatch (countGameForOut %s) → PlayerRemovalReverted: back in their seat, as if never removed",
    (countGameForOut) => {
      const session = TestSession.start();
      const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
      session.advanceMinutes(5);
      const { stateBefore, undoEvent, stateAfter } = applyThenUndo(
        session,
        () =>
          session.apply("PlayerRemovedMidMatch", {
            matchId,
            participantId: p(3),
            countGameForOut,
          }),
        2,
      );
      expect(undoEvent.type).toBe("PlayerRemovalReverted");
      expect(stateWithoutAuditTrail(stateAfter)).toEqual(
        stateWithoutAuditTrail(stateBefore),
      );
      expect(session.player(p(3))).toMatchObject({
        status: "playing",
        committedGames: 1,
        playMs: minutesMs(7),
      });
    },
  );

  it.each([true, false])(
    "PlayerReplaced (countGameForOut %s) → PlayerReplacementReverted",
    (countGameForOut) => {
      const session = TestSession.start();
      const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
      session.advanceMinutes(5);
      const { stateBefore, stateAfter } = applyThenUndo(
        session,
        () =>
          session.apply("PlayerReplaced", {
            matchId,
            outId: p(2),
            inId: p(5),
            countGameForOut,
          }),
        2,
      );
      expect(stateWithoutAuditTrail(stateAfter)).toEqual(
        stateWithoutAuditTrail(stateBefore),
      );
      expect(session.player(p(5))).toMatchObject({
        status: "waiting",
        playMs: 0,
      });
    },
  );

  it("PlayerReplaced of a player who had already played in the match restores their earlier segment only", () => {
    const session = TestSession.start();
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(2);
    session.apply("PlayerReplaced", {
      matchId,
      outId: p(2),
      inId: p(5),
      countGameForOut: false,
    });
    session.advanceMinutes(2);
    // p(2) comes back in for p(5): p(2) now has two segments in the match.
    const { stateBefore, stateAfter } = applyThenUndo(
      session,
      () =>
        session.apply("PlayerReplaced", {
          matchId,
          outId: p(5),
          inId: p(2),
          countGameForOut: false,
        }),
      1,
    );
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
  });

  it("QueueReordered → QueueReordered with the previous order", () => {
    const session = TestSession.start();
    session.apply("QueueReordered", { participantIds: [p(3), p(1)] });
    const { stateBefore, undoEvent, stateAfter } = applyThenUndo(session, () =>
      session.apply("QueueReordered", { participantIds: [p(4), p(2), p(1)] }),
    );
    expect(undoEvent).toMatchObject({
      type: "QueueReordered",
      payload: { participantIds: [p(3), p(1)] },
    });
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
  });

  it("SuggestionsShuffled → SuggestionsShuffled with the previous seed", () => {
    const session = TestSession.start();
    session.apply("SuggestionsShuffled", { seed: 11 });
    const { stateBefore, undoEvent, stateAfter } = applyThenUndo(session, () =>
      session.apply("SuggestionsShuffled", { seed: 42 }),
    );
    expect(undoEvent).toMatchObject({
      type: "SuggestionsShuffled",
      payload: { seed: 11 },
    });
    expect(stateWithoutAuditTrail(stateAfter)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
  });

  it("undoing the very first reorder and shuffle restores the empty order and seed 0", () => {
    const session = TestSession.start();
    const stateBefore = session.state;
    const reorder = session.apply("QueueReordered", {
      participantIds: [p(2)],
    });
    const shuffle = session.apply("SuggestionsShuffled", { seed: 7 });
    session.undo(shuffle.seq);
    session.undo(reorder.seq);
    expect(stateWithoutAuditTrail(session.state)).toEqual(
      stateWithoutAuditTrail(stateBefore),
    );
  });
});

// These undos end an interval instead of erasing it, by design (plan §3): the
// interval stays in state as an audit of what happened. Undone straight away,
// every derived view (metrics, clock, records) matches the prior state.
describe("undo of interval actions (skip, leave, close, pause, resume)", () => {
  it.each<{
    name: string;
    setUp?: (session: TestSession) => void;
    act: (session: TestSession) => SessionEvent;
  }>([
    {
      name: "PlayerSkipped",
      act: (session) => session.apply("PlayerSkipped", { participantId: p(1) }),
    },
    {
      name: "PlayerLeft",
      act: (session) => session.apply("PlayerLeft", { participantId: p(1) }),
    },
    {
      name: "CourtClosed",
      act: (session) =>
        session.apply("CourtClosed", { courtId: fixtureCourtId(2) }),
    },
    {
      name: "Paused",
      act: (session) => session.apply("Paused", {}),
    },
    {
      name: "Resumed",
      setUp: (session) => {
        session.apply("Paused", {});
        session.advanceMinutes(4);
      },
      act: (session) => session.apply("Resumed", {}),
    },
  ])(
    "$name undone at the same instant leaves every derived view unchanged",
    ({ setUp, act }) => {
      const session = TestSession.start();
      session.startMatch(1, [p(5), p(6)], [p(7), p(8)]);
      session.advanceMinutes(7);
      setUp?.(session);
      const viewsBefore = derivedViews(session.state, session.now);
      session.undo(act(session).seq);
      const viewsAfter = derivedViews(session.state, session.now);
      // Undoing a resume reopens the pause at the undo time, so "paused since"
      // moves to the undo; the paused total is unchanged.
      if (viewsBefore.clock.isPaused) {
        expect(viewsAfter.clock.pausedMs).toBe(viewsBefore.clock.pausedMs);
        viewsAfter.clock.pausedSince = viewsBefore.clock.pausedSince;
      }
      expect(viewsAfter).toEqual(viewsBefore);
    },
  );

  it("PlayerSkipped → PlayerUnskipped keeps the skip as a closed interval; skipped time is not presence", () => {
    const session = TestSession.start();
    session.advanceMinutes(5);
    const { stateBefore, action, stateAfter } = applyThenUndo(
      session,
      () => session.apply("PlayerSkipped", { participantId: p(1) }),
      10,
    );
    expect(stateAfter.participants[p(1)]).toEqual({
      ...stateBefore.participants[p(1)],
      skips: [{ from: action.at, to: session.now, skippedBySeq: action.seq }],
    });
    session.advanceMinutes(5);
    expect(session.player(p(1))).toMatchObject({
      status: "waiting",
      presentMs: 10 * 60_000,
      currentWaitMs: 10 * 60_000,
    });
  });

  it("PlayerLeft → PlayerLeaveReverted: back in, wait continues, time away not counted", () => {
    const session = TestSession.start();
    session.advanceMinutes(5);
    const waitStart = session.player(p(1)).currentWaitStartAt;
    const { action, undoEvent, stateAfter } = applyThenUndo(
      session,
      () => session.apply("PlayerLeft", { participantId: p(1) }),
      10,
    );
    expect(stateAfter.participants[p(1)].presence).toEqual([
      {
        from: session.state.startedAt,
        to: action.at,
        startKind: "joined",
        startedBySeq: 1,
        endedBySeq: action.seq,
      },
      {
        from: undoEvent.at,
        to: null,
        startKind: "returned",
        startedBySeq: undoEvent.seq,
        endedBySeq: null,
      },
    ]);
    session.advanceMinutes(5);
    expect(session.player(p(1))).toMatchObject({
      status: "waiting",
      currentWaitStartAt: waitStart,
      presentMs: 10 * 60_000,
      currentWaitMs: 10 * 60_000,
    });
  });

  it("CourtClosed → CourtReopened keeps the closure; closed time is not open time", () => {
    const session = TestSession.start();
    session.advanceMinutes(5);
    applyThenUndo(
      session,
      () => session.apply("CourtClosed", { courtId: fixtureCourtId(2) }),
      10,
    );
    session.advanceMinutes(5);
    expect(session.courts()[1]).toMatchObject({
      status: "free",
      openMs: 10 * 60_000,
    });
  });

  it("Paused → Resumed: time that passed while paused stays paused", () => {
    const session = TestSession.start();
    session.advanceMinutes(5);
    const { stateBefore, stateAfter } = applyThenUndo(
      session,
      () => session.apply("Paused", {}),
      10,
    );
    expect(stateAfter.pausedBySeq).toBe(stateBefore.pausedBySeq);
    expect(stateAfter.resumedBySeq).toBe(stateBefore.resumedBySeq);
    expect(session.clock()).toMatchObject({
      isPaused: false,
      elapsedMs: 5 * 60_000,
      pausedMs: 10 * 60_000,
    });
  });

  it("Resumed → Paused: paused again under the original pause, which can then be undone", () => {
    const session = TestSession.start();
    session.advanceMinutes(5);
    const pause = session.apply("Paused", {});
    session.advanceMinutes(3);
    const resume = session.apply("Resumed", {});
    session.advanceMinutes(2);
    session.undo(resume.seq);
    expect(session.state.pausedBySeq).toBe(pause.seq);
    expect(session.state.resumedBySeq).toBeNull();
    expect(session.clock()).toMatchObject({
      isPaused: true,
      elapsedMs: 7 * 60_000,
      pausedMs: 3 * 60_000,
    });
    session.advanceMinutes(1);
    session.undo(pause.seq);
    expect(session.clock()).toMatchObject({
      isPaused: false,
      elapsedMs: 7 * 60_000,
      pausedMs: 4 * 60_000,
    });
    expect(session.state.resumedBySeq).toBeNull();
  });
});

describe("undo rejections", () => {
  it("rejects an unknown target", () => {
    const session = TestSession.start();
    expectUndoRejected(session, 99, "UNKNOWN_TARGET");
  });

  it("rejects undoing SessionStarted itself", () => {
    const session = TestSession.start({
      initialMatches: [
        {
          matchId: "initial-match",
          courtId: fixtureCourtId(1),
          teamA: [p(1), p(2)],
          teamB: [p(3), p(4)],
        },
      ],
    });
    expectUndoRejected(session, 1, "NOT_REVERSIBLE");
    // An initial match can still be abandoned, and the abandonment undone.
    session.advanceMinutes(3);
    const abandon = session.apply("MatchAbandoned", {
      matchId: "initial-match",
    });
    const beforeAbandon = replay(session.events.slice(0, -1));
    session.undo(abandon.seq);
    expect(beforeAbandon.ok).toBe(true);
    if (beforeAbandon.ok) {
      expect(stateWithoutAuditTrail(session.state)).toEqual(
        stateWithoutAuditTrail(beforeAbandon.state),
      );
    }
  });

  it("rejects undoing an undo (no redo)", () => {
    const session = TestSession.start();
    const skip = session.apply("PlayerSkipped", { participantId: p(1) });
    const unskip = session.undo(skip.seq);
    expectUndoRejected(session, unskip.seq, "NOT_REVERSIBLE");

    // Reorder/shuffle/pause undos reuse ordinary types but carry targetSeq; still not undoable.
    const shuffle = session.apply("SuggestionsShuffled", { seed: 3 });
    const shuffleUndo = session.undo(shuffle.seq);
    expectUndoRejected(session, shuffleUndo.seq, "NOT_REVERSIBLE");
    const pause = session.apply("Paused", {});
    const pauseUndo = session.undo(pause.seq);
    expect(pauseUndo.type).toBe("Resumed");
    expectUndoRejected(session, pauseUndo.seq, "NOT_REVERSIBLE");
  });

  it("rejects an undo of an action already compensated", () => {
    const session = TestSession.start();
    const lock = session.apply("PlayerLocked", { participantId: p(1) });
    session.undo(lock.seq);
    expectUndoRejected(session, lock.seq, "ALREADY_COMPENSATED");
  });

  it("rejects a hand-built compensation with the wrong type, wrong order, wrong seed or no targetSeq", () => {
    const session = TestSession.start();
    const reorder = session.apply("QueueReordered", { participantIds: [p(1)] });
    const shuffle = session.apply("SuggestionsShuffled", { seed: 5 });
    const skip = session.apply("PlayerSkipped", { participantId: p(2) });
    const cases: Array<[SessionEvent, SessionErrorCode]> = [
      [
        {
          ...session.nextMeta(),
          type: "PlayerUnlocked",
          payload: { targetSeq: skip.seq },
        },
        "TARGET_MISMATCH",
      ],
      [
        {
          ...session.nextMeta(),
          type: "QueueReordered",
          payload: { participantIds: [p(4)], targetSeq: reorder.seq },
        },
        "TARGET_MISMATCH",
      ],
      [
        {
          ...session.nextMeta(),
          type: "SuggestionsShuffled",
          payload: { seed: 99, targetSeq: shuffle.seq },
        },
        "TARGET_MISMATCH",
      ],
      [
        {
          ...session.nextMeta(),
          type: "PlayerUnskipped",
          payload: {} as { targetSeq: number },
        },
        "MALFORMED_EVENT",
      ],
    ];
    for (const [event, code] of cases) {
      const result = applyEvent(session.state, event);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    }
  });

  it("rejects any undo after the session has ended", () => {
    const session = TestSession.start();
    const skip = session.apply("PlayerSkipped", { participantId: p(1) });
    const end = session.apply("SessionEnded", {});
    expectUndoRejected(session, skip.seq, "SESSION_ENDED");
    expectUndoRejected(session, end.seq, "NOT_REVERSIBLE");
  });

  it("rejects undoing a match start after a replacement in that match, until the replacement is undone", () => {
    const session = TestSession.start();
    const stateBeforeStart = session.state;
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const startSeq = session.state.lastSeq;
    session.advanceMinutes(4);
    const replacement = session.apply("PlayerReplaced", {
      matchId,
      outId: p(1),
      inId: p(5),
      countGameForOut: false,
    });
    expectUndoRejected(session, startSeq, "UNDO_BLOCKED");
    session.undo(replacement.seq);
    session.undo(startSeq);
    expect(stateWithoutAuditTrail(session.state)).toEqual(
      stateWithoutAuditTrail(stateBeforeStart),
    );
  });

  it("rejects undoing a match start once the match has finished", () => {
    const session = TestSession.start();
    const completed = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const completedStartSeq = session.state.lastSeq;
    const abandoned = session.startMatch(2, [p(5), p(6)], [p(7), p(8)]);
    const abandonedStartSeq = session.state.lastSeq;
    session.advanceMinutes(10);
    session.apply("MatchCompleted", { matchId: completed });
    session.apply("MatchAbandoned", { matchId: abandoned });
    expectUndoRejected(session, completedStartSeq, "UNDO_BLOCKED");
    expectUndoRejected(session, abandonedStartSeq, "UNDO_BLOCKED");
  });

  it("rejects undoing a completion when the court or a player has moved on", () => {
    const session = TestSession.start({ participantCount: 12, courts: 3 });
    const first = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(15);
    const firstCompletion = session.apply("MatchCompleted", { matchId: first });

    // Court 1 reused.
    session.startMatch(1, [p(5), p(6)], [p(7), p(8)]);
    expectUndoRejected(session, firstCompletion.seq, "UNDO_BLOCKED");
  });

  it.each<{
    name: string;
    moveOn: (session: TestSession, matchId: string) => void;
  }>([
    {
      name: "a player is in another match",
      moveOn: (session) => session.startMatch(2, [p(1), p(5)], [p(6), p(7)]),
    },
    {
      name: "a player played another match since",
      moveOn: (session) => {
        const other = session.startMatch(2, [p(1), p(5)], [p(6), p(7)]);
        session.advanceMinutes(10);
        session.apply("MatchCompleted", { matchId: other });
      },
    },
    {
      name: "a player left",
      moveOn: (session) => session.apply("PlayerLeft", { participantId: p(2) }),
    },
    {
      name: "a player was skipped",
      moveOn: (session) =>
        session.apply("PlayerSkipped", { participantId: p(3) }),
    },
    {
      name: "the court was closed",
      moveOn: (session) =>
        session.apply("CourtClosed", { courtId: fixtureCourtId(1) }),
    },
  ])("rejects undoing a completion when $name", ({ moveOn }) => {
    const session = TestSession.start({ participantCount: 10 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(15);
    const completion = session.apply("MatchCompleted", { matchId });
    session.advanceMinutes(1);
    moveOn(session, matchId);
    expectUndoRejected(session, completion.seq, "UNDO_BLOCKED");
  });

  it("rejects undoing a replacement when the incoming player was replaced since, or the outgoing player moved on", () => {
    const session = TestSession.start({ participantCount: 12, courts: 2 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(3);
    const firstReplacement = session.apply("PlayerReplaced", {
      matchId,
      outId: p(1),
      inId: p(5),
      countGameForOut: false,
    });
    session.advanceMinutes(3);
    const secondReplacement = session.apply("PlayerReplaced", {
      matchId,
      outId: p(5),
      inId: p(6),
      countGameForOut: false,
    });
    expectUndoRejected(session, firstReplacement.seq, "UNDO_BLOCKED");
    session.undo(secondReplacement.seq);

    // Outgoing p(1) now playing elsewhere.
    session.startMatch(2, [p(1), p(7)], [p(8), p(9)]);
    expectUndoRejected(session, firstReplacement.seq, "UNDO_BLOCKED");
  });

  it("rejects undoing a match start after a removal in that match, until the removal is undone", () => {
    const session = TestSession.start();
    const stateBeforeStart = session.state;
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const startSeq = session.state.lastSeq;
    const removal = session.apply("PlayerRemovedMidMatch", {
      matchId,
      participantId: p(4),
      countGameForOut: false,
    });
    expectUndoRejected(session, startSeq, "UNDO_BLOCKED");
    session.undo(removal.seq);
    session.undo(startSeq);
    expect(stateWithoutAuditTrail(session.state)).toEqual(
      stateWithoutAuditTrail(stateBeforeStart),
    );
  });

  it.each<{
    name: string;
    moveOn: (session: TestSession, matchId: string) => void;
  }>([
    {
      name: "the match was completed",
      moveOn: (session, matchId) =>
        session.apply("MatchCompleted", { matchId }),
    },
    {
      name: "the match was abandoned",
      moveOn: (session, matchId) =>
        session.apply("MatchAbandoned", { matchId }),
    },
    {
      name: "the player is in another match",
      moveOn: (session) => session.startMatch(2, [p(1), p(5)], [p(6), p(7)]),
    },
    {
      name: "the player played another match since",
      moveOn: (session) => {
        const other = session.startMatch(2, [p(1), p(5)], [p(6), p(7)]);
        session.advanceMinutes(10);
        session.apply("MatchCompleted", { matchId: other });
      },
    },
    {
      name: "the player left",
      moveOn: (session) => session.apply("PlayerLeft", { participantId: p(1) }),
    },
    {
      name: "the player was skipped",
      moveOn: (session) =>
        session.apply("PlayerSkipped", { participantId: p(1) }),
    },
  ])("rejects undoing a removal when $name", ({ moveOn }) => {
    const session = TestSession.start({ participantCount: 10 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(3);
    const removal = session.apply("PlayerRemovedMidMatch", {
      matchId,
      participantId: p(1),
      countGameForOut: true,
    });
    session.advanceMinutes(1);
    moveOn(session, matchId);
    expectUndoRejected(session, removal.seq, "UNDO_BLOCKED");
  });

  it("rejects undoing a replacement once the match has finished", () => {
    const session = TestSession.start();
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const replacement = session.apply("PlayerReplaced", {
      matchId,
      outId: p(1),
      inId: p(5),
      countGameForOut: true,
    });
    session.advanceMinutes(10);
    session.apply("MatchCompleted", { matchId });
    expectUndoRejected(session, replacement.seq, "UNDO_BLOCKED");
  });

  it("rejects undoing a join when the player has played, is skipped or locked, or left", () => {
    const [lateArrival] = makeParticipants(9).slice(8);
    const joinedSession = () => {
      const session = TestSession.start();
      const join = session.apply("PlayerJoined", { participant: lateArrival });
      return { session, joinSeq: join.seq };
    };

    const played = joinedSession();
    played.session.startMatch(1, [p(9), p(1)], [p(2), p(3)]);
    expectUndoRejected(played.session, played.joinSeq, "UNDO_BLOCKED");

    const skipped = joinedSession();
    skipped.session.apply("PlayerSkipped", { participantId: p(9) });
    expectUndoRejected(skipped.session, skipped.joinSeq, "UNDO_BLOCKED");

    const locked = joinedSession();
    locked.session.apply("PlayerLocked", { participantId: p(9) });
    expectUndoRejected(locked.session, locked.joinSeq, "UNDO_BLOCKED");

    const left = joinedSession();
    left.session.apply("PlayerLeft", { participantId: p(9) });
    expectUndoRejected(left.session, left.joinSeq, "UNDO_BLOCKED");
  });

  // Regression (found by the property test): a lock or skip from before the
  // player left used to block undoing their rejoin.
  it.each<{
    name: string;
    markBeforeLeaving: (session: TestSession) => void;
  }>([
    {
      name: "lock",
      markBeforeLeaving: (session) =>
        session.apply("PlayerLocked", { participantId: p(1) }),
    },
    {
      name: "skip",
      markBeforeLeaving: (session) =>
        session.apply("PlayerSkipped", { participantId: p(1) }),
    },
  ])(
    "allows undoing a rejoin when the $name predates it, and keeps the $name",
    ({ markBeforeLeaving }) => {
      const session = TestSession.start();
      markBeforeLeaving(session);
      session.apply("PlayerLeft", { participantId: p(1) });
      session.advanceMinutes(5);
      const stateBefore = session.state;
      const { stateAfter } = applyThenUndo(session, () =>
        session.apply("PlayerJoined", {
          participant: session.state.participants[p(1)].participant,
        }),
      );
      expect(stateWithoutAuditTrail(stateAfter)).toEqual(
        stateWithoutAuditTrail(stateBefore),
      );
    },
  );

  it("rejects undoing a leave after the player rejoined", () => {
    const session = TestSession.start();
    const leave = session.apply("PlayerLeft", { participantId: p(1) });
    session.apply("PlayerJoined", {
      participant: session.state.participants[p(1)].participant,
    });
    expectUndoRejected(session, leave.seq, "PLAYER_ALREADY_PRESENT");
  });

  it("rejects undoing a lock once it is used up by a match start; undoing the start brings it back", () => {
    const session = TestSession.start();
    const lock = session.apply("PlayerLocked", { participantId: p(1) });
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const startSeq = session.state.lastSeq;
    expectUndoRejected(session, lock.seq, "PLAYER_NOT_LOCKED");
    session.undo(startSeq);
    session.undo(lock.seq);
    expect(session.player(p(1)).isLocked).toBe(false);
  });

  // Regression (review): the lock would come back pointing at a removed court.
  it.each([false, true])(
    "rejects undoing a court add while a match holds a lock used up on it (match finished: %s)",
    (finishMatch) => {
      const session = TestSession.start({ courts: 1 });
      const add = session.apply("CourtAdded", {
        court: makeCourt(2, "doubles"),
      });
      session.apply("PlayerLocked", {
        participantId: p(1),
        courtId: fixtureCourtId(2),
      });
      const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
      const startSeq = session.state.lastSeq;
      const completion = finishMatch
        ? session.apply("MatchCompleted", { matchId })
        : null;
      expectUndoRejected(session, add.seq, "UNDO_BLOCKED");
      if (completion) session.undo(completion.seq);
      session.undo(startSeq);
      expect(session.state.participants[p(1)].lock?.courtId).toBe(
        fixtureCourtId(2),
      );
      // Now the lock is back on the player, the existing guard applies.
      expectUndoRejected(session, add.seq, "UNDO_BLOCKED");
    },
  );

  // Regression (review): a removed participant left in queueOrder made every
  // later reorder fail with UNKNOWN_PARTICIPANT.
  it("rejects undoing a first join while the player is in the manual order", () => {
    const session = TestSession.start();
    const [lateArrival] = makeParticipants(9).slice(8);
    const join = session.apply("PlayerJoined", { participant: lateArrival });
    const reorder = session.apply("QueueReordered", {
      participantIds: [p(9), p(1)],
    });
    expectUndoRejected(session, join.seq, "UNDO_BLOCKED");
    session.undo(reorder.seq);
    session.undo(join.seq);
    session.apply("QueueReordered", { participantIds: [p(1)] });
  });

  it("allows undoing a rejoin while the player is in the manual order (they stay known)", () => {
    const session = TestSession.start();
    session.apply("PlayerLeft", { participantId: p(1) });
    const rejoin = session.apply("PlayerJoined", {
      participant: session.state.participants[p(1)].participant,
    });
    session.apply("QueueReordered", { participantIds: [p(1)] });
    session.undo(rejoin.seq);
    expect(session.player(p(1))).toMatchObject({
      status: "away",
      manualQueueRank: 0,
    });
  });

  it("rejects undoing a court add once matches were played on it or a player is locked to it", () => {
    const session = TestSession.start({ courts: 1 });
    const add = session.apply("CourtAdded", { court: makeCourt(2, "doubles") });
    const lock = session.apply("PlayerLocked", {
      participantId: p(1),
      courtId: fixtureCourtId(2),
    });
    expectUndoRejected(session, add.seq, "UNDO_BLOCKED");
    session.undo(lock.seq);
    session.startMatch(2, [p(1), p(2)], [p(3), p(4)]);
    expectUndoRejected(session, add.seq, "UNDO_BLOCKED");
  });

  it("rejects undoing a reorder or shuffle that a later one replaced, until that one is undone", () => {
    const session = TestSession.start();
    const firstReorder = session.apply("QueueReordered", {
      participantIds: [p(1)],
    });
    const secondReorder = session.apply("QueueReordered", {
      participantIds: [p(2)],
    });
    const firstShuffle = session.apply("SuggestionsShuffled", { seed: 1 });
    const secondShuffle = session.apply("SuggestionsShuffled", { seed: 2 });
    expectUndoRejected(session, firstReorder.seq, "UNDO_BLOCKED");
    expectUndoRejected(session, firstShuffle.seq, "UNDO_BLOCKED");
    session.undo(secondReorder.seq);
    session.undo(secondShuffle.seq);
    session.undo(firstReorder.seq);
    session.undo(firstShuffle.seq);
    expect(session.state.queueOrder).toEqual([]);
    expect(session.state.suggestionSeed).toBe(0);
  });

  it("rejects undoing a pause or resume that is no longer the latest", () => {
    const session = TestSession.start();
    const firstPause = session.apply("Paused", {});
    const firstResume = session.apply("Resumed", {});
    session.apply("Paused", {});
    // The first pause has already ended; the session is paused by a later one.
    expectUndoRejected(session, firstPause.seq, "UNDO_BLOCKED");
    expectUndoRejected(session, firstResume.seq, "SESSION_PAUSED");
    session.apply("Resumed", {});
    expectUndoRejected(session, firstResume.seq, "UNDO_BLOCKED");
    expectUndoRejected(session, firstPause.seq, "SESSION_NOT_PAUSED");
  });

  it("rejects undoing a skip or closure already ended by a later action", () => {
    const session = TestSession.start();
    const skip = session.apply("PlayerSkipped", { participantId: p(1) });
    const close = session.apply("CourtClosed", { courtId: fixtureCourtId(2) });
    session.undo(skip.seq);
    session.undo(close.seq);
    expectUndoRejected(session, skip.seq, "ALREADY_COMPENSATED");
    expectUndoRejected(session, close.seq, "ALREADY_COMPENSATED");
  });
});

describe("undoing a match started with the session", () => {
  const FIRST_MATCH = "first-match-court-1";
  const SECOND_MATCH = "first-match-court-2";
  const initialMatches = [
    {
      matchId: FIRST_MATCH,
      courtId: fixtureCourtId(1),
      teamA: [p(1), p(2)],
      teamB: [p(3), p(4)],
    },
    {
      matchId: SECOND_MATCH,
      courtId: fixtureCourtId(2),
      teamA: [p(5), p(6)],
      teamB: [p(7), p(8)],
    },
  ];
  const startWithFirstMatches = () =>
    TestSession.start({ participantCount: 10, initialMatches });

  it("restores the state as if that match had never started; the session and its other match stay", () => {
    const session = startWithFirstMatches();
    session.advanceMinutes(4);
    session.apply("PlayerSkipped", { participantId: p(9) });
    session.advanceMinutes(2);
    const undo = session.undo(1, FIRST_MATCH);
    expect(undo).toMatchObject({
      type: "MatchStartReverted",
      payload: { targetSeq: 1, matchId: FIRST_MATCH },
    });

    const startedWithoutIt = [
      {
        ...session.events[0],
        payload: {
          ...(session.events[0]
            .payload as SessionEventPayloads["SessionStarted"]),
          initialMatches: [initialMatches[1]],
        },
      } as SessionEvent,
      ...session.events.slice(1, -1),
    ];
    const expected = replay(startedWithoutIt);
    expect(expected.ok).toBe(true);
    if (expected.ok) {
      expect(stateWithoutAuditTrail(session.state)).toEqual(
        stateWithoutAuditTrail(expected.state),
      );
    }
    // Players back to waiting, wait clocks running from session start.
    expect(session.player(p(1))).toMatchObject({
      status: "waiting",
      playMs: 0,
      currentWaitStartAt: session.state.startedAt,
      currentWaitMs: 6 * 60_000,
      committedGames: 0,
    });
    expect(session.player(p(5)).status).toBe("playing");
    // The append-only history keeps the SessionStarted in force.
    expect(actionHistory(session.state)[0].compensatedBySeq).toBeNull();
    expect(actionHistory(session.state).at(-1)).toMatchObject({
      type: "MatchStartReverted",
      targetSeq: 1,
      targetMatchId: FIRST_MATCH,
    });
  });

  it("undoes each first match separately, once", () => {
    const session = startWithFirstMatches();
    session.undo(1, FIRST_MATCH);
    expectUndoRejected(session, 1, "NOT_REVERSIBLE");
    const again = session.tryUndo(1, FIRST_MATCH);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("ALREADY_COMPENSATED");
    session.undo(1, SECOND_MATCH);
    expect(
      session.players().every((player) => player.status === "waiting"),
    ).toBe(true);
    // Ids are never reused, even after the undo.
    const reuse = session.tryApply("MatchStarted", initialMatches[0]);
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.error.code).toBe("DUPLICATE_ID");
  });

  it("rejects an unknown or missing match id, and a match id on another kind of target", () => {
    const session = startWithFirstMatches();
    const unknown = session.tryUndo(1, "not-a-first-match");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("TARGET_MISMATCH");
    const handBuilt = applyEvent(session.state, {
      ...session.nextMeta(),
      type: "MatchStartReverted",
      payload: { targetSeq: 1 },
    });
    expect(handBuilt.ok).toBe(false);
    if (!handBuilt.ok) expect(handBuilt.error.code).toBe("TARGET_MISMATCH");

    const skip = session.apply("PlayerSkipped", { participantId: p(9) });
    const onSkip = session.tryUndo(skip.seq, FIRST_MATCH);
    expect(onSkip.ok).toBe(false);
    if (!onSkip.ok) expect(onSkip.error.code).toBe("TARGET_MISMATCH");
  });

  it("rejects a matchId that doesn't match the targeted MatchStarted", () => {
    const session = TestSession.start();
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const startSeq = session.state.lastSeq;
    const result = session.tryUndo(startSeq, "some-other-match");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TARGET_MISMATCH");
  });

  it.each<{
    name: string;
    dependOnIt: (session: TestSession) => void;
  }>([
    {
      name: "a replacement",
      dependOnIt: (session) =>
        session.apply("PlayerReplaced", {
          matchId: FIRST_MATCH,
          outId: p(1),
          inId: p(9),
          countGameForOut: false,
        }),
    },
    {
      name: "a removal",
      dependOnIt: (session) =>
        session.apply("PlayerRemovedMidMatch", {
          matchId: FIRST_MATCH,
          participantId: p(1),
          countGameForOut: false,
        }),
    },
  ])(
    "after $name in it, tells the host to undo that or abandon the match instead",
    ({ dependOnIt }) => {
      const session = startWithFirstMatches();
      session.advanceMinutes(3);
      dependOnIt(session);
      const before = session.state;
      const result = session.tryUndo(1, FIRST_MATCH);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("UNDO_BLOCKED");
        expect(result.error.message).toContain("abandon the match instead");
      }
      expect(session.state).toBe(before);
      session.apply("MatchAbandoned", { matchId: FIRST_MATCH });
    },
  );

  it("after a completion, asks for the completion to be undone first, then undoes the start", () => {
    const session = startWithFirstMatches();
    const stateAtStart = session.state;
    session.advanceMinutes(15);
    const completion = session.apply("MatchCompleted", {
      matchId: FIRST_MATCH,
    });
    expectUndoRejected(session, 1, "NOT_REVERSIBLE");
    const blocked = session.tryUndo(1, FIRST_MATCH);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("UNDO_BLOCKED");
    session.undo(completion.seq);
    session.undo(1, FIRST_MATCH);
    expect(session.state.matches[FIRST_MATCH]).toBeUndefined();
    expect(session.state.courts[fixtureCourtId(1)]).toEqual({
      ...stateAtStart.courts[fixtureCourtId(1)],
      activeMatchId: null,
      matchIds: [],
    });
    expect(session.player(p(1))).toMatchObject({
      status: "waiting",
      gamesCompleted: 0,
      currentWaitStartAt: session.state.startedAt,
    });
  });
});

describe("out-of-order undo", () => {
  // Current behaviour, pinned so a change is deliberate (see stateForReplayComparison).
  it("an undone reorder restores the previous order minus players who have started a match since", () => {
    const session = TestSession.start();
    session.apply("QueueReordered", { participantIds: [p(1), p(5), p(2)] });
    const reorder = session.apply("QueueReordered", {
      participantIds: [p(6)],
    });
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const undo = session.undo(reorder.seq);
    expect(undo.payload).toEqual({
      participantIds: [p(5)],
      targetSeq: reorder.seq,
    });
    expect(session.state.queueOrder).toEqual([p(5)]);
    expect(session.player(p(1))).toMatchObject({
      status: "playing",
      manualQueueRank: null,
    });
  });

  it("a hand-built reorder undo that keeps a player who has started a match since is rejected", () => {
    const session = TestSession.start();
    session.apply("QueueReordered", { participantIds: [p(1), p(5)] });
    const reorder = session.apply("QueueReordered", {
      participantIds: [p(6)],
    });
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const result = applyEvent(session.state, {
      ...session.nextMeta(),
      type: "QueueReordered",
      payload: { participantIds: [p(1), p(5)], targetSeq: reorder.seq },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TARGET_MISMATCH");
  });

  it("an undone reorder keeps a rank for a player brought in only as a replacement", () => {
    const session = TestSession.start();
    session.apply("QueueReordered", { participantIds: [p(5)] });
    const reorder = session.apply("QueueReordered", { participantIds: [] });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.apply("PlayerReplaced", {
      matchId,
      outId: p(1),
      inId: p(5),
      countGameForOut: false,
    });
    session.undo(reorder.seq);
    expect(session.state.queueOrder).toEqual([p(5)]);
  });

  it("an undone reorder drops a player whose first join was undone since", () => {
    const session = TestSession.start();
    const [lateArrival] = makeParticipants(9).slice(8);
    const join = session.apply("PlayerJoined", { participant: lateArrival });
    session.apply("QueueReordered", { participantIds: [p(9), p(2)] });
    const reorder = session.apply("QueueReordered", {
      participantIds: [p(2)],
    });
    session.undo(join.seq);
    session.undo(reorder.seq);
    expect(session.state.queueOrder).toEqual([p(2)]);
  });

  it("an undone match start re-inserts the ranks it cleared into a newer order, after their old neighbours", () => {
    const session = TestSession.start();
    session.apply("QueueReordered", { participantIds: [p(1), p(5), p(2)] });
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const startSeq = session.state.lastSeq;
    session.apply("QueueReordered", { participantIds: [p(6), p(5)] });
    session.undo(startSeq);
    // p(1) had nobody ahead, so goes first; p(2) goes back right after p(5).
    expect(session.state.queueOrder).toEqual([p(1), p(6), p(5), p(2)]);
  });

  // Regression (review): ranks were restored at absolute positions, which
  // shift once a later match start removes players ahead of them.
  it("an undone match start puts ranks back exactly when later starts removed players ahead of them", () => {
    const session = TestSession.start({ participantCount: 12 });
    session.apply("QueueReordered", {
      participantIds: [p(9), p(10), p(1), p(11)],
    });
    session.advanceMinutes(1);
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const firstStartSeq = session.state.lastSeq;
    session.advanceMinutes(1);
    session.startMatch(2, [p(9), p(5)], [p(6), p(7)]);
    session.advanceMinutes(1);
    session.undo(firstStartSeq);
    expect(session.state.queueOrder).toEqual([p(10), p(1), p(11)]);

    const withoutFirstStart = replay(
      session.events.filter(
        (event, index) =>
          event.seq !== firstStartSeq && index !== session.events.length - 1,
      ),
    );
    expect(withoutFirstStart.ok).toBe(true);
    if (withoutFirstStart.ok) {
      expect(session.state.queueOrder).toEqual(
        withoutFirstStart.state.queueOrder,
      );
    }
  });

  it("undoes a Court 1 completion from three actions ago without touching later actions", () => {
    const session = TestSession.start({ participantCount: 12, courts: 3 });
    const court1Match = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const court2Match = session.startMatch(2, [p(5), p(6)], [p(7), p(8)]);
    session.advanceMinutes(15);
    const court1Completion = session.apply("MatchCompleted", {
      matchId: court1Match,
    });
    session.advanceMinutes(1);
    session.apply("MatchCompleted", { matchId: court2Match });
    session.startMatch(3, [p(9), p(10)], [p(11), p(12)]);
    session.apply("PlayerSkipped", { participantId: p(5) });
    session.advanceMinutes(2);

    session.undo(court1Completion.seq);

    const withoutCompletion = replay(
      session.events.filter(
        (event, index) =>
          event.seq !== court1Completion.seq &&
          index !== session.events.length - 1,
      ),
    );
    expect(withoutCompletion.ok).toBe(true);
    if (!withoutCompletion.ok) return;
    expect(stateWithoutAuditTrail(session.state)).toEqual(
      stateWithoutAuditTrail(withoutCompletion.state),
    );
    expect(session.player(p(1))).toMatchObject({
      status: "playing",
      playMs: 18 * 60_000,
    });
    expect(session.player(p(5))).toMatchObject({
      status: "skipped",
      gamesCompleted: 1,
    });
  });
});

describe("undo chains", () => {
  it("unwinds a match with a replacement in reverse dependency order back to the state before it started", () => {
    const session = TestSession.start();
    session.advanceMinutes(2);
    const stateBeforeStart = session.state;
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const startSeq = session.state.lastSeq;
    session.advanceMinutes(5);
    const replacement = session.apply("PlayerReplaced", {
      matchId,
      outId: p(3),
      inId: p(5),
      countGameForOut: true,
    });
    session.advanceMinutes(10);
    const completion = session.apply("MatchCompleted", { matchId });
    session.advanceMinutes(1);

    expectUndoRejected(session, startSeq, "UNDO_BLOCKED");
    expectUndoRejected(session, replacement.seq, "UNDO_BLOCKED");
    session.undo(completion.seq);
    expectUndoRejected(session, startSeq, "UNDO_BLOCKED");
    session.undo(replacement.seq);
    session.undo(startSeq);

    expect(stateWithoutAuditTrail(session.state)).toEqual(
      stateWithoutAuditTrail(stateBeforeStart),
    );
    // Every action and every undo stays in the log.
    expect(session.state.history).toHaveLength(7);
  });

  it("undoing every reversible action newest first returns to the state right after SessionStarted", () => {
    const session = TestSession.start({ participantCount: 10, courts: 1 });
    const stateAfterStart = session.state;
    const [lateArrival] = makeParticipants(11).slice(10);
    session.apply("CourtAdded", { court: makeCourt(2, "singles") });
    session.apply("PlayerJoined", { participant: lateArrival });
    session.apply("PlayerLocked", { participantId: p(11) });
    session.apply("QueueReordered", { participantIds: [p(11), p(9)] });
    session.apply("SuggestionsShuffled", { seed: 1234 });
    const doubles = session.startMatch(1, [p(1), p(11)], [p(3), p(4)]);
    session.startMatch(2, [p(9)], [p(10)]);
    session.advanceMinutes(5);
    session.apply("PlayerReplaced", {
      matchId: doubles,
      outId: p(1),
      inId: p(2),
      countGameForOut: false,
    });
    session.advanceMinutes(9);
    session.apply("MatchCompleted", { matchId: doubles });
    session.advanceMinutes(1);

    const actionSeqs = session.state.history
      .slice(1)
      .map((entry) => entry.event.seq)
      .reverse();
    for (const seq of actionSeqs) session.undo(seq);

    expect(stateWithoutAuditTrail(session.state)).toEqual(
      stateWithoutAuditTrail(stateAfterStart),
    );
  });
});

// ---------------------------------------------------------------------------
// Property: random valid sessions, then undo.

const POOL_SIZE = 12;
const INITIAL_ATTENDEES = 9;
const MAX_COURTS = 4;
const PROPERTY_SEED = 20261107;

interface RandomStep {
  actionChoice: number;
  argumentChoice: number;
  advanceMinutes: number;
}

const randomStepArbitrary = fc.record({
  actionChoice: fc.nat(),
  argumentChoice: fc.nat(),
  advanceMinutes: fc.integer({ min: 0, max: 6 }),
});

type CandidateAction = (session: TestSession, argumentChoice: number) => void;

/** Rotates `values` by `offset`, so one number picks a varied subset. */
function rotate<T>(values: readonly T[], offset: number): T[] {
  if (values.length === 0) return [];
  const start = offset % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

function availableIds(session: TestSession): string[] {
  return session
    .players()
    .filter((player) => player.status === "waiting")
    .map((player) => player.participantId);
}

function activeMatchIds(session: TestSession): string[] {
  return Object.values(session.state.matches)
    .filter((match) => match.status === "active")
    .map((match) => match.matchId);
}

/**
 * Builds plausible actions from the current state. Some may still be rejected
 * (e.g. match actions while paused); the driver just skips those.
 */
const CANDIDATE_ACTIONS: CandidateAction[] = [
  // Start a match on a free court (weighted: listed twice).
  ...Array.from({ length: 2 }, (): CandidateAction => (session, choice) => {
    const freeCourts = session
      .courts()
      .filter((court) => court.status === "free");
    const court = rotate(freeCourts, choice)[0];
    if (!court) return;
    const teamSize = court.court.format === "doubles" ? 2 : 1;
    const players = rotate(availableIds(session), choice >> 3).slice(
      0,
      teamSize * 2,
    );
    if (players.length < teamSize * 2) return;
    session.tryApply("MatchStarted", {
      matchId: `match-${session.state.lastSeq + 1}`,
      courtId: court.courtId,
      teamA: players.slice(0, teamSize),
      teamB: players.slice(teamSize),
    });
  }),
  ...Array.from({ length: 2 }, (): CandidateAction => (session, choice) => {
    const matchId = rotate(activeMatchIds(session), choice)[0];
    if (matchId) session.tryApply("MatchCompleted", { matchId });
  }),
  (session, choice) => {
    const matchId = rotate(activeMatchIds(session), choice)[0];
    if (matchId) session.tryApply("MatchAbandoned", { matchId });
  },
  (session, choice) => {
    const matchId = rotate(activeMatchIds(session), choice)[0];
    const inId = rotate(availableIds(session), choice >> 2)[0];
    if (!matchId || !inId) return;
    const lineup = session.state.matches[matchId].segments.filter(
      (segment) => segment.endedMidMatchBySeq === null,
    );
    session.tryApply("PlayerReplaced", {
      matchId,
      outId: rotate(lineup, choice >> 4)[0].participantId,
      inId,
      countGameForOut: choice % 2 === 0,
    });
  },
  (session, choice) => {
    const matchId = rotate(activeMatchIds(session), choice)[0];
    if (!matchId) return;
    const lineup = session.state.matches[matchId].segments.filter(
      (segment) => segment.endedMidMatchBySeq === null,
    );
    session.tryApply("PlayerRemovedMidMatch", {
      matchId,
      participantId: rotate(lineup, choice >> 3)[0].participantId,
      countGameForOut: choice % 2 === 0,
    });
  },
  (session, choice) => {
    const absent = makeParticipants(POOL_SIZE).filter((participant) => {
      const participantState =
        session.state.participants[participant.participantId];
      return (
        !participantState ||
        session.player(participant.participantId).status === "away"
      );
    });
    const participant = rotate(absent, choice)[0];
    if (!participant) return;
    session.tryApply("PlayerJoined", {
      participant:
        session.state.participants[participant.participantId]?.participant ??
        participant,
    });
  },
  (session, choice) => {
    const participantId = rotate(availableIds(session), choice)[0];
    if (participantId) session.tryApply("PlayerLeft", { participantId });
  },
  (session, choice) => {
    const participantId = rotate(availableIds(session), choice)[0];
    if (participantId) session.tryApply("PlayerSkipped", { participantId });
  },
  (session, choice) => {
    const unlocked = session
      .players()
      .filter((player) => player.status !== "away" && !player.isLocked);
    const player = rotate(unlocked, choice)[0];
    if (!player) return;
    const courtId =
      choice % 3 === 0
        ? undefined
        : rotate(session.courts(), choice >> 2)[0].courtId;
    session.tryApply("PlayerLocked", {
      participantId: player.participantId,
      courtId,
    });
  },
  (session) => {
    const courtCount = Object.keys(session.state.courts).length;
    if (courtCount >= MAX_COURTS) return;
    session.tryApply("CourtAdded", {
      court: makeCourt(courtCount + 1, courtCount % 2 ? "singles" : "doubles"),
    });
  },
  (session, choice) => {
    const freeCourt = rotate(
      session.courts().filter((court) => court.status === "free"),
      choice,
    )[0];
    if (freeCourt) {
      session.tryApply("CourtClosed", { courtId: freeCourt.courtId });
    }
  },
  (session, choice) => {
    const presentIds = session
      .players()
      .filter((player) => player.status !== "away")
      .map((player) => player.participantId);
    session.tryApply("QueueReordered", {
      participantIds: rotate(presentIds, choice).slice(0, 1 + (choice % 5)),
    });
  },
  (session, choice) => {
    session.tryApply("SuggestionsShuffled", { seed: choice % 10_000 });
  },
  (session) => {
    if (session.state.pausedBySeq === null) session.tryApply("Paused", {});
    else session.tryApply("Resumed", {});
  },
  // Undo something earlier, so logs contain undos and undo chains.
  ...Array.from({ length: 2 }, (): CandidateAction => (session, choice) => {
    const history = session.state.history;
    session.tryUndo(history[choice % history.length].event.seq);
  }),
  // Undo a match started with the session (when the run has them).
  (session, choice) => {
    const initialMatchId = rotate(RANDOM_INITIAL_MATCH_IDS, choice)[0];
    session.tryUndo(1, initialMatchId);
  },
];

const RANDOM_INITIAL_MATCHES: MatchAssignment[] = [
  {
    matchId: "initial-court-1",
    courtId: fixtureCourtId(1),
    teamA: [p(1), p(2)],
    teamB: [p(3), p(4)],
  },
  {
    matchId: "initial-court-2",
    courtId: fixtureCourtId(2),
    teamA: [p(5)],
    teamB: [p(6)],
  },
];
const RANDOM_INITIAL_MATCH_IDS = RANDOM_INITIAL_MATCHES.map(
  (assignment) => assignment.matchId,
);

/** The log as if `matchId` had not been started with the session. */
function logWithoutInitialMatch(
  events: readonly SessionEvent[],
  matchId: string,
): SessionEvent[] {
  const [sessionStarted, ...rest] = events;
  if (sessionStarted.type !== "SessionStarted") {
    throw new Error("The log must start with SessionStarted.");
  }
  return [
    {
      ...sessionStarted,
      payload: {
        ...sessionStarted.payload,
        initialMatches: (sessionStarted.payload.initialMatches ?? []).filter(
          (assignment) => assignment.matchId !== matchId,
        ),
      },
    },
    ...rest,
  ];
}

/**
 * Structural invariants that must hold after every accepted action. Throws
 * (via expect) with the broken rule. `presentMs === playMs + totalWaitMs` is
 * how metrics define the wait, so it is checked as `totalWaitMs >= 0` (play
 * time always lies inside presence) instead.
 */
function checkStateInvariants(state: SessionState, now: number): void {
  const matches = Object.values(state.matches);
  const activeMatchIdByPlayer = new Map<string, string>();
  for (const match of matches) {
    const court = state.courts[match.courtId];
    expect(court, `match ${match.matchId} court exists`).toBeDefined();
    const teamSize = PLAYERS_PER_TEAM[court.court.format];
    const startingLineup = match.segments.filter(
      (segment) => segment.startedByReplacementSeq === null,
    );
    const lineup = currentLineup(match);
    expect(startingLineup).toHaveLength(teamSize * 2);
    for (const team of ["A", "B"] as const) {
      expect(
        startingLineup.filter((segment) => segment.team === team),
      ).toHaveLength(teamSize);
      expect(
        lineup.filter((segment) => segment.team === team).length,
      ).toBeLessThanOrEqual(teamSize);
    }
    const lineupIds = lineup.map((segment) => segment.participantId);
    expect(new Set(lineupIds).size).toBe(lineupIds.length);
    expect(lineupIds.length).toBeGreaterThan(0);
    expect(match.status === "active", "court points at its active match").toBe(
      court.activeMatchId === match.matchId,
    );
    for (const lock of Object.values(match.consumedLocks)) {
      if (lock.courtId !== null)
        expect(state.courts[lock.courtId]).toBeDefined();
    }
    if (match.status !== "active") continue;
    for (const participantId of lineupIds) {
      expect(
        activeMatchIdByPlayer.has(participantId),
        `${participantId} is in two active matches`,
      ).toBe(false);
      activeMatchIdByPlayer.set(participantId, match.matchId);
    }
  }
  for (const [participantId, participantState] of Object.entries(
    state.participants,
  )) {
    expect(participantState.activeMatchId).toBe(
      activeMatchIdByPlayer.get(participantId) ?? null,
    );
    if (participantState.activeMatchId !== null) {
      expect(isPresent(participantState), "a player on court is present").toBe(
        true,
      );
      expect(
        isSkipped(participantState),
        "a player on court is not skipped",
      ).toBe(false);
    }
    if (participantState.lock?.courtId) {
      expect(state.courts[participantState.lock.courtId]).toBeDefined();
    }
  }
  for (const court of Object.values(state.courts)) {
    if (court.activeMatchId !== null) {
      expect(state.matches[court.activeMatchId]?.status).toBe("active");
    }
  }
  for (const participantId of state.queueOrder) {
    expect(state.participants[participantId]).toBeDefined();
  }
  for (const player of playerMetrics(state, now)) {
    expect(player.totalWaitMs).toBeGreaterThanOrEqual(0);
    expect(player.currentWaitMs ?? 0).toBeLessThanOrEqual(player.totalWaitMs);
  }
}

/** Runs with an even number of steps start with both courts already in play. */
function runRandomSession(steps: readonly RandomStep[]): TestSession {
  const session = TestSession.start({
    participants: makeParticipants(POOL_SIZE),
    attendeeIds: makeParticipants(INITIAL_ATTENDEES).map(
      (participant) => participant.participantId,
    ),
    courts: ["doubles", "singles"],
    initialMatches: steps.length % 2 === 0 ? RANDOM_INITIAL_MATCHES : [],
  });
  for (const step of steps) {
    session.advanceMinutes(step.advanceMinutes);
    CANDIDATE_ACTIONS[step.actionChoice % CANDIDATE_ACTIONS.length](
      session,
      step.argumentChoice,
    );
    checkStateInvariants(session.state, session.now);
  }
  return session;
}

/** Undo types that erase their target (the others close an interval instead, see above). */
const ERASING_UNDO_TARGET_TYPES: ReadonlySet<string> = new Set([
  "PlayerJoined",
  "PlayerLocked",
  "CourtAdded",
  "MatchStarted",
  "MatchCompleted",
  "MatchAbandoned",
  "PlayerReplaced",
  "PlayerRemovedMidMatch",
  "QueueReordered",
  "SuggestionsShuffled",
]);

/**
 * Manual queue ranks are the one place an out-of-order undo is not the same as
 * "the action never happened", by design (see compensate.ts):
 * - a match-start undo re-inserts the ranks it cleared, even into a newer
 *   reorder (replaying without it, the newer order stands as written);
 * - a reorder undo filters the previous order by who has started a match
 *   since, which differs from replay once starts are also undone or reordered;
 * - `queueOrderAtStart` is a snapshot of the order each start saw, which
 *   differs when an earlier action is removed from the log.
 * The order itself is compared only when no such interaction happened.
 */
function stateForReplayComparison(state: SessionState) {
  const comparable = stateWithoutAuditTrail(state);
  delete comparable.queueOrder;
  const matches: Record<string, Partial<MatchState>> = {};
  for (const [matchId, match] of Object.entries(state.matches)) {
    matches[matchId] = { ...match };
    delete matches[matchId].queueOrderAtStart;
  }
  return { ...comparable, matches };
}

function queueRanksComparable(
  events: readonly SessionEvent[],
  targetSeq: number,
  targetType: string,
): boolean {
  return !events.some((event) => {
    if (event.seq <= targetSeq) return false;
    // A reorder undo filters the old order by who has started a match since,
    // so later starts and start undos make it differ from replay (by design).
    if (targetType === "QueueReordered") {
      return (
        event.type === "MatchStarted" || event.type === "MatchStartReverted"
      );
    }
    // A start undo is exact while the order has only lost entries since the
    // start. It is genuinely ambiguous after a newer reorder (the host's new
    // order wins, by design) or after undoing a start from before this one:
    // both put back ranks this start never saw, and replay can interleave
    // players who shared a neighbour differently.
    if (event.type === "QueueReordered") return true;
    if (event.type !== "MatchStartReverted") return false;
    const undoneStartSeq = event.payload.targetSeq;
    const undoesAnEarlierRankClearingStart =
      undoneStartSeq > 1 && undoneStartSeq < targetSeq;
    return undoesAnEarlierRankClearingStart;
  });
}

function undoableSeqs(state: SessionState): number[] {
  return state.history
    .filter(
      ({ event, compensatedBySeq }) =>
        compensatedBySeq === null &&
        event.type in COMPENSATING_EVENT_TYPE &&
        !("targetSeq" in event.payload),
    )
    .map((entry) => entry.event.seq);
}

describe("replay on a large generated log", () => {
  const LARGE_LOG_STEPS = 4_000;

  let cachedLargeSession: TestSession | null = null;
  /** Built once (about 850 accepted events, invariants checked at every step); tests only read it. */
  function largeRandomSession(): TestSession {
    if (cachedLargeSession) return cachedLargeSession;
    const random = createSeededRandom(PROPERTY_SEED);
    const nextNat = () => Math.floor(random() * 2 ** 31);
    cachedLargeSession = runRandomSession(
      Array.from({ length: LARGE_LOG_STEPS }, () => ({
        actionChoice: nextNat(),
        argumentChoice: nextNat(),
        advanceMinutes: Math.floor(random() * 4),
      })),
    );
    return cachedLargeSession;
  }

  it("equals applying every event one by one with applyEvent", () => {
    const session = largeRandomSession();
    expect(session.events.length).toBeGreaterThan(800);
    const replayed = replay(session.events);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.state).toEqual(session.state);
  });

  it("reports a rejected event with the exact state before it, like applyEvent", () => {
    const session = largeRandomSession();
    const cut = Math.floor(session.events.length / 2);
    const invalid: SessionEvent = {
      ...session.events[cut],
      type: "PlayerLeft",
      payload: { participantId: "no-such-participant" },
    };
    const log = [...session.events.slice(0, cut), invalid];
    const expectedBefore = session.events
      .slice(0, cut)
      .reduce((state, event) => {
        const result = applyEvent(state, event);
        if (!result.ok) throw new Error(result.error.message);
        return result.state;
      }, createInitialSessionState());

    const replayed = replay(log);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.failedSeq).toBe(invalid.seq);
      expect(replayed.error.code).toBe("UNKNOWN_PARTICIPANT");
      expect(replayed.state).toEqual(expectedBefore);
    }
  });

  it("leaves its input events untouched and returns a state applyEvent can extend without side effects", () => {
    const session = largeRandomSession();
    const eventsSnapshot = structuredClone(session.events);
    const replayed = replay(session.events);
    expect(session.events).toEqual(eventsSnapshot);
    if (!replayed.ok) throw new Error("replay failed");
    const historyLength = replayed.state.history.length;
    const pause = applyEvent(replayed.state, {
      ...session.nextMeta(),
      type: replayed.state.pausedBySeq === null ? "Paused" : "Resumed",
      payload: {},
    });
    expect(pause.ok).toBe(true);
    expect(replayed.state.history).toHaveLength(historyLength);
  });
});

describe("undo properties (fast-check, seeded)", () => {
  const steps = fc.array(randomStepArbitrary, { minLength: 1, maxLength: 40 });

  it("undoing the last action at the same instant restores every derived view (and the exact state for erasing undos)", () => {
    fc.assert(
      fc.property(steps, (randomSteps) => {
        const session = runRandomSession(randomSteps);
        const lastEntry = session.state.history.at(-1)!;
        if (!undoableSeqs(session.state).includes(lastEntry.event.seq)) return;
        const before = replay(session.events.slice(0, -1));
        expect(before.ok).toBe(true);
        if (!before.ok) return;
        // Undo at the instant of the action, before any time passes.
        const actionAt = lastEntry.event.at;
        const result = compensate(session.state, lastEntry.event.seq, {
          ...session.nextMeta(),
          at: actionAt,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const viewsBefore = derivedViews(before.state, actionAt);
        const viewsAfter = derivedViews(result.state, actionAt);
        if (lastEntry.event.type === "Resumed") {
          viewsAfter.clock.pausedSince = viewsBefore.clock.pausedSince;
        }
        // An undone end leaves the `matches` row marked reverted (plan §3).
        const lastEvent = lastEntry.event;
        if (
          lastEvent.type === "MatchCompleted" ||
          lastEvent.type === "MatchAbandoned"
        ) {
          const reopened = viewsAfter.matches.find(
            (record) => record.matchId === lastEvent.payload.matchId,
          )!;
          expect(reopened.matchesRowStatus).toBe("reverted");
          reopened.matchesRowStatus = viewsBefore.matches.find(
            (record) => record.matchId === lastEvent.payload.matchId,
          )!.matchesRowStatus;
        }
        expect(viewsAfter).toEqual(viewsBefore);
        if (ERASING_UNDO_TARGET_TYPES.has(lastEntry.event.type)) {
          expect(stateWithoutAuditTrail(result.state)).toEqual(
            stateWithoutAuditTrail(before.state),
          );
        }
      }),
      { seed: PROPERTY_SEED, numRuns: 150 },
    );
  });

  it("an accepted undo of any earlier erasing action equals replaying the log without that action", () => {
    let comparedUndoCount = 0;
    let comparedInitialMatchUndoCount = 0;
    fc.assert(
      fc.property(
        steps,
        fc.integer({ min: 0, max: 5 }),
        (randomSteps, advanceMinutes) => {
          const session = runRandomSession(randomSteps);
          session.advanceMinutes(advanceMinutes);
          for (const targetSeq of undoableSeqs(session.state)) {
            const targetType = session.state.history.find(
              (entry) => entry.event.seq === targetSeq,
            )!.event.type;
            const result = compensate(
              session.state,
              targetSeq,
              session.nextMeta(),
            );
            if (!result.ok) {
              // Rejections are always explained, never thrown.
              expect(result.error.message.length).toBeGreaterThan(0);
              continue;
            }
            if (!ERASING_UNDO_TARGET_TYPES.has(targetType)) continue;
            const withoutTarget = replay(
              session.events.filter((event) => event.seq !== targetSeq),
            );
            // A later action may only make sense because the target happened
            // (e.g. a reorder that names a late arrival); nothing to compare.
            if (!withoutTarget.ok) continue;
            comparedUndoCount += 1;
            expect(stateForReplayComparison(result.state)).toEqual(
              stateForReplayComparison(withoutTarget.state),
            );
            if (queueRanksComparable(session.events, targetSeq, targetType)) {
              expect(result.state.queueOrder).toEqual(
                withoutTarget.state.queueOrder,
              );
            }
          }
          for (const matchId of RANDOM_INITIAL_MATCH_IDS) {
            if (!session.state.matches[matchId]) continue;
            const result = compensate(
              session.state,
              1,
              session.nextMeta(),
              matchId,
            );
            if (!result.ok) {
              expect(result.error.message.length).toBeGreaterThan(0);
              continue;
            }
            checkStateInvariants(result.state, session.now);
            const withoutMatch = replay(
              logWithoutInitialMatch(session.events, matchId),
            );
            if (!withoutMatch.ok) continue;
            comparedInitialMatchUndoCount += 1;
            expect(stateForReplayComparison(result.state)).toEqual(
              stateForReplayComparison(withoutMatch.state),
            );
            expect(result.state.queueOrder).toEqual(
              withoutMatch.state.queueOrder,
            );
          }
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 150 },
    );
    // Guard against a generator that never exercises the property.
    expect(comparedUndoCount).toBeGreaterThan(150);
    expect(comparedInitialMatchUndoCount).toBeGreaterThan(30);
  });
});
