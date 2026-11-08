// @vitest-environment node
// Derived timers and statistics, always measured at an injected `now`.
import { describe, expect, it } from "vitest";
import {
  actionHistory,
  courtMetrics,
  matchRecords,
  playerMetrics,
  sessionClock,
} from "./metrics";
import { createInitialSessionState } from "./state";
import {
  FIXTURE_ACTOR_ID,
  FIXTURE_START_AT,
  MINUTE_MS,
  TestSession,
  fixtureCourtId,
  fixtureParticipantId as p,
  makeCourt,
  makeParticipants,
} from "./testing/fixtures";

const minutes = (count: number) => count * MINUTE_MS;
const at = (minutesAfterStart: number) =>
  FIXTURE_START_AT + minutes(minutesAfterStart);

describe("before the session starts", () => {
  it("returns empty metrics and a zero clock", () => {
    const state = createInitialSessionState();
    expect(playerMetrics(state, at(10))).toEqual([]);
    expect(courtMetrics(state, at(10))).toEqual([]);
    expect(matchRecords(state, at(10))).toEqual([]);
    expect(actionHistory(state)).toEqual([]);
    expect(sessionClock(state, at(10))).toEqual({
      phase: "notStarted",
      startedAt: null,
      endedAt: null,
      isPaused: false,
      pausedSince: null,
      elapsedMs: 0,
      pausedMs: 0,
      plannedMs: 0,
      remainingMs: 0,
    });
  });
});

describe("playerMetrics", () => {
  it("measures a completed game: games, play, wait, partners and opponents", () => {
    const session = TestSession.start();
    session.advanceMinutes(2);
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(15);
    session.apply("MatchCompleted", { matchId });
    session.advanceMinutes(5);

    expect(session.player(p(1))).toMatchObject({
      status: "waiting",
      gamesCompleted: 1,
      committedGames: 1,
      presentMs: minutes(22),
      playMs: minutes(15),
      totalWaitMs: minutes(7),
      currentWaitStartAt: at(17),
      currentWaitMs: minutes(5),
      lastMatchEndAt: at(17),
      joinedAt: at(0),
      partnerCounts: { [p(2)]: 1 },
      opponentCounts: { [p(3)]: 1, [p(4)]: 1 },
      completedGameEndTimes: [at(17)],
      currentMatchId: null,
      currentCourtId: null,
    });
    expect(session.player(p(5))).toMatchObject({
      status: "waiting",
      gamesCompleted: 0,
      presentMs: minutes(22),
      playMs: 0,
      totalWaitMs: minutes(22),
      currentWaitStartAt: at(0),
      currentWaitMs: minutes(22),
      lastMatchEndAt: null,
    });
  });

  it("lists players in join order and keeps presentMs = playMs + totalWaitMs", () => {
    const session = TestSession.start({ participantCount: 6 });
    const [lateArrival] = makeParticipants(7).slice(6);
    session.advanceMinutes(4);
    session.apply("PlayerJoined", { participant: lateArrival });
    session.startMatch(1, [p(7), p(1)], [p(2), p(3)]);
    session.advanceMinutes(9);
    const players = session.players();
    expect(players.map((player) => player.participantId)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map(p),
    );
    for (const player of players) {
      expect(player.presentMs).toBe(player.playMs + player.totalWaitMs);
    }
    expect(session.player(p(7))).toMatchObject({
      joinedAt: at(4),
      presentMs: minutes(9),
      playMs: minutes(9),
    });
  });

  it("counts an active match as committed but not completed", () => {
    const session = TestSession.start();
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(6);
    expect(session.player(p(1))).toMatchObject({
      status: "playing",
      gamesCompleted: 0,
      committedGames: 1,
      playMs: minutes(6),
      currentWaitStartAt: null,
      currentWaitMs: null,
      currentMatchId: matchId,
      currentCourtId: fixtureCourtId(1),
      partnerCounts: { [p(2)]: 1 },
    });
  });

  it("gives play time but no game or pairing for an abandoned match", () => {
    const session = TestSession.start();
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(7);
    session.apply("MatchAbandoned", { matchId });
    expect(session.player(p(1))).toMatchObject({
      status: "waiting",
      gamesCompleted: 0,
      committedGames: 0,
      playMs: minutes(7),
      lastMatchEndAt: at(7),
      partnerCounts: {},
      opponentCounts: {},
      completedGameEndTimes: [],
    });
  });

  it.each([true, false])(
    "credits a replaced-out player with the game only when countGameForOut is %s",
    (countGameForOut) => {
      const session = TestSession.start();
      const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
      session.advanceMinutes(4);
      session.apply("PlayerReplaced", {
        matchId,
        outId: p(1),
        inId: p(5),
        countGameForOut,
      });
      expect(session.player(p(1))).toMatchObject({
        status: "waiting",
        committedGames: countGameForOut ? 1 : 0,
        lastMatchEndAt: at(4),
        currentWaitStartAt: at(4),
      });
      session.advanceMinutes(10);
      session.apply("MatchCompleted", { matchId });
      expect(session.player(p(1))).toMatchObject({
        gamesCompleted: countGameForOut ? 1 : 0,
        playMs: minutes(4),
        // Pairings come from the final lineup only.
        partnerCounts: {},
      });
      expect(session.player(p(5))).toMatchObject({
        gamesCompleted: 1,
        playMs: minutes(10),
        partnerCounts: { [p(2)]: 1 },
        opponentCounts: { [p(3)]: 1, [p(4)]: 1 },
      });
    },
  );

  it("excludes skipped time from presence and the current wait", () => {
    const session = TestSession.start();
    session.advanceMinutes(5);
    const skip = session.apply("PlayerSkipped", { participantId: p(1) });
    session.advanceMinutes(10);
    expect(session.player(p(1))).toMatchObject({
      status: "skipped",
      presentMs: minutes(5),
      currentWaitStartAt: null,
      currentWaitMs: null,
    });
    session.undo(skip.seq);
    session.advanceMinutes(3);
    expect(session.player(p(1))).toMatchObject({
      status: "waiting",
      presentMs: minutes(8),
      currentWaitStartAt: at(0),
      currentWaitMs: minutes(8),
    });
  });

  it("marks a leaver away, keeps their stats, and starts a fresh wait when they rejoin", () => {
    const session = TestSession.start();
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(10);
    session.apply("MatchCompleted", { matchId });
    session.advanceMinutes(2);
    session.apply("PlayerLeft", { participantId: p(1) });
    session.advanceMinutes(20);
    expect(session.player(p(1))).toMatchObject({
      status: "away",
      gamesCompleted: 1,
      presentMs: minutes(12),
      currentWaitMs: null,
    });
    session.apply("PlayerJoined", {
      participant: session.state.participants[p(1)].participant,
    });
    session.advanceMinutes(3);
    expect(session.player(p(1))).toMatchObject({
      status: "waiting",
      joinedAt: at(0),
      presentMs: minutes(15),
      currentWaitStartAt: at(32),
      currentWaitMs: minutes(3),
    });
  });

  it("excludes paused time from presence, play and wait", () => {
    const session = TestSession.start();
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(5);
    session.apply("Paused", {});
    session.advanceMinutes(10);
    // Still paused: nothing accrues.
    expect(session.player(p(1))).toMatchObject({
      presentMs: minutes(5),
      playMs: minutes(5),
    });
    expect(session.player(p(5))).toMatchObject({
      presentMs: minutes(5),
      currentWaitMs: minutes(5),
    });
    session.apply("Resumed", {});
    session.advanceMinutes(2);
    expect(session.player(p(1)).playMs).toBe(minutes(7));
    expect(session.player(p(5))).toMatchObject({
      presentMs: minutes(7),
      totalWaitMs: minutes(7),
      currentWaitMs: minutes(7),
    });
  });

  it("reports locks and manual queue ranks", () => {
    const session = TestSession.start();
    session.apply("PlayerLocked", {
      participantId: p(1),
      courtId: fixtureCourtId(2),
    });
    session.apply("PlayerLocked", { participantId: p(2) });
    session.apply("QueueReordered", { participantIds: [p(6), p(3)] });
    expect(session.player(p(1))).toMatchObject({
      isLocked: true,
      lockedCourtId: fixtureCourtId(2),
      manualQueueRank: null,
    });
    expect(session.player(p(2))).toMatchObject({
      isLocked: true,
      lockedCourtId: null,
    });
    expect(session.player(p(3)).manualQueueRank).toBe(1);
    expect(session.player(p(6)).manualQueueRank).toBe(0);
    expect(session.player(p(4))).toMatchObject({
      isLocked: false,
      lockedCourtId: null,
      manualQueueRank: null,
    });
  });

  it("never measures before the last event, and freezes at the end", () => {
    const session = TestSession.start();
    session.advanceMinutes(10);
    session.apply("PlayerSkipped", { participantId: p(8) });
    // A client clock behind the server clamps to the last event time.
    expect(playerMetrics(session.state, at(3))[0].presentMs).toBe(minutes(10));
    session.advanceMinutes(5);
    session.apply("SessionEnded", {});
    expect(playerMetrics(session.state, at(500))[0].presentMs).toBe(
      minutes(15),
    );
  });

  it("orders completed game end times and counts repeat partners", () => {
    const session = TestSession.start({ participantCount: 6, courts: 1 });
    const first = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(12);
    session.apply("MatchCompleted", { matchId: first });
    const second = session.startMatch(1, [p(1), p(2)], [p(5), p(3)]);
    session.advanceMinutes(13);
    session.apply("MatchCompleted", { matchId: second });
    expect(session.player(p(1))).toMatchObject({
      gamesCompleted: 2,
      completedGameEndTimes: [at(12), at(25)],
      partnerCounts: { [p(2)]: 2 },
      opponentCounts: { [p(3)]: 2, [p(4)]: 1, [p(5)]: 1 },
    });
  });
});

describe("sessionClock", () => {
  it("counts elapsed and remaining time against the planned length", () => {
    const session = TestSession.start({ plannedDurationMinutes: 90 });
    session.advanceMinutes(30);
    expect(session.clock()).toEqual({
      phase: "live",
      startedAt: at(0),
      endedAt: null,
      isPaused: false,
      pausedSince: null,
      elapsedMs: minutes(30),
      pausedMs: 0,
      plannedMs: minutes(90),
      remainingMs: minutes(60),
    });
  });

  it("excludes every pause from elapsed and remaining, open or closed", () => {
    const session = TestSession.start({ plannedDurationMinutes: 60 });
    session.advanceMinutes(10);
    session.apply("Paused", {});
    session.advanceMinutes(5);
    session.apply("Resumed", {});
    session.advanceMinutes(20);
    const secondPause = session.apply("Paused", {});
    session.advanceMinutes(7);
    expect(session.clock()).toMatchObject({
      isPaused: true,
      pausedSince: secondPause.at,
      elapsedMs: minutes(30),
      pausedMs: minutes(12),
      remainingMs: minutes(30),
    });
    session.apply("Resumed", {});
    session.advanceMinutes(1);
    expect(session.clock()).toMatchObject({
      isPaused: false,
      pausedSince: null,
      elapsedMs: minutes(31),
      pausedMs: minutes(12),
      remainingMs: minutes(29),
    });
  });

  it("goes negative once the session overruns", () => {
    const session = TestSession.start({ plannedDurationMinutes: 30 });
    session.advanceMinutes(45);
    expect(session.clock().remainingMs).toBe(-minutes(15));
  });

  it("freezes at the end, closing a pause that was still open", () => {
    const session = TestSession.start({ plannedDurationMinutes: 120 });
    session.advanceMinutes(40);
    session.apply("Paused", {});
    session.advanceMinutes(10);
    session.apply("SessionEnded", {});
    const clockAtEnd = sessionClock(session.state, at(50));
    expect(clockAtEnd).toEqual({
      phase: "ended",
      startedAt: at(0),
      endedAt: at(50),
      isPaused: false,
      pausedSince: null,
      elapsedMs: minutes(40),
      pausedMs: minutes(10),
      plannedMs: minutes(120),
      remainingMs: minutes(80),
    });
    expect(sessionClock(session.state, at(300))).toEqual(clockAtEnd);
  });
});

describe("courtMetrics", () => {
  it("reports free, busy and closed courts in the order they were added", () => {
    const session = TestSession.start({ courts: 2 });
    session.apply("CourtAdded", { court: makeCourt(3, "singles") });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.apply("CourtClosed", { courtId: fixtureCourtId(2) });
    session.advanceMinutes(3);
    expect(
      session.courts().map((court) => [court.court.name, court.status]),
    ).toEqual([
      ["Court 1", "busy"],
      ["Court 2", "closed"],
      ["Court 3", "free"],
    ]);
    expect(session.courts()[0]).toMatchObject({
      currentMatchId: matchId,
      currentMatchElapsedMs: minutes(3),
    });
    expect(session.courts()[2]).toMatchObject({
      currentMatchId: null,
      currentMatchElapsedMs: null,
    });
  });

  it("measures the current match against the target, excluding pauses, so overdue can be shown", () => {
    const session = TestSession.start({ targetMatchMinutes: 15 });
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const targetMs = minutes(session.config.targetMatchMinutes);
    const isOverdue = () =>
      (session.courts()[0].currentMatchElapsedMs ?? 0) > targetMs;

    session.advanceMinutes(10);
    session.apply("Paused", {});
    session.advanceMinutes(20);
    session.apply("Resumed", {});
    expect(session.courts()[0].currentMatchElapsedMs).toBe(minutes(10));
    expect(isOverdue()).toBe(false);

    session.advanceMinutes(5);
    expect(session.courts()[0].currentMatchElapsedMs).toBe(targetMs);
    expect(isOverdue()).toBe(false);

    session.advanceMinutes(1);
    expect(isOverdue()).toBe(true);
  });

  it("measures open time (minus pauses and closures) and busy time across matches", () => {
    const session = TestSession.start({ courts: 1 });
    session.advanceMinutes(5);
    session.apply("CourtAdded", { court: makeCourt(2, "doubles") });
    const first = session.startMatch(2, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(10);
    session.apply("MatchAbandoned", { matchId: first });
    const close = session.apply("CourtClosed", { courtId: fixtureCourtId(2) });
    session.advanceMinutes(4);
    session.undo(close.seq);
    const second = session.startMatch(2, [p(5), p(6)], [p(7), p(8)]);
    session.advanceMinutes(6);
    session.apply("Paused", {});
    session.advanceMinutes(3);
    session.apply("Resumed", {});
    session.advanceMinutes(2);
    session.apply("MatchCompleted", { matchId: second });

    const [court1, court2] = session.courts();
    expect(court1).toMatchObject({ openMs: minutes(27), busyMs: 0 });
    expect(court2).toMatchObject({
      status: "free",
      openMs: minutes(18),
      busyMs: minutes(18),
    });
  });
});

describe("matchRecords", () => {
  it("lists completed, abandoned and active matches in start order with credits and durations", () => {
    const session = TestSession.start({ participantCount: 12, courts: 3 });
    const completed = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(1);
    const abandoned = session.startMatch(2, [p(5), p(6)], [p(7), p(8)]);
    session.advanceMinutes(4);
    session.apply("PlayerReplaced", {
      matchId: completed,
      outId: p(2),
      inId: p(9),
      countGameForOut: true,
    });
    session.apply("Paused", {});
    session.advanceMinutes(10);
    session.apply("Resumed", {});
    session.advanceMinutes(6);
    session.apply("MatchCompleted", { matchId: completed });
    session.apply("MatchAbandoned", { matchId: abandoned });
    const active = session.startMatch(3, [p(10), p(11)], [p(12), p(1)]);
    session.advanceMinutes(2);

    const records = matchRecords(session.state, session.now);
    expect(records.map((record) => [record.matchId, record.status])).toEqual([
      [completed, "completed"],
      [abandoned, "abandoned"],
      [active, "active"],
    ]);
    expect(records[0]).toEqual({
      matchId: completed,
      courtId: fixtureCourtId(1),
      courtName: "Court 1",
      status: "completed",
      matchesRowStatus: "completed",
      teamA: [p(1), p(9)],
      teamB: [p(3), p(4)],
      startedAt: at(0),
      endedAt: at(21),
      activeDurationMs: minutes(11),
      creditedParticipantIds: [p(1), p(2), p(3), p(4), p(9)],
      segments: [
        {
          participantId: p(1),
          team: "A",
          from: at(0),
          to: at(21),
          playMs: minutes(11),
          endedMidMatch: false,
          countGameForOut: false,
        },
        {
          participantId: p(2),
          team: "A",
          from: at(0),
          to: at(5),
          playMs: minutes(5),
          endedMidMatch: true,
          countGameForOut: true,
        },
        {
          participantId: p(3),
          team: "B",
          from: at(0),
          to: at(21),
          playMs: minutes(11),
          endedMidMatch: false,
          countGameForOut: false,
        },
        {
          participantId: p(4),
          team: "B",
          from: at(0),
          to: at(21),
          playMs: minutes(11),
          endedMidMatch: false,
          countGameForOut: false,
        },
        {
          participantId: p(9),
          team: "A",
          from: at(5),
          to: at(21),
          playMs: minutes(6),
          endedMidMatch: false,
          countGameForOut: false,
        },
      ],
    });
    expect(records[1]).toMatchObject({
      endedAt: at(21),
      activeDurationMs: minutes(10),
    });
    expect(records[2]).toMatchObject({
      endedAt: null,
      teamA: [p(10), p(11)],
      teamB: [p(12), p(1)],
      activeDurationMs: minutes(2),
    });
  });

  it("omits an undone match start and shows an undone completion as active again", () => {
    const session = TestSession.start();
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const revertedStartSeq = session.state.lastSeq;
    session.undo(revertedStartSeq);
    const matchId = session.startMatch(2, [p(5), p(6)], [p(7), p(8)]);
    session.advanceMinutes(15);
    const completion = session.apply("MatchCompleted", { matchId });
    session.advanceMinutes(1);
    session.undo(completion.seq);

    const records = matchRecords(session.state, session.now);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      matchId,
      status: "active",
      endedAt: null,
      activeDurationMs: minutes(16),
    });
    expect(records[0].segments.every((segment) => segment.to === null)).toBe(
      true,
    );
  });
});

describe("matchRecords matchesRowStatus (the `matches` row status for M3)", () => {
  const rowStatuses = (session: TestSession) =>
    matchRecords(session.state, session.now).map(
      (record) => record.matchesRowStatus,
    );

  it("has no row while a match is in progress, then follows each end and undo", () => {
    const session = TestSession.start({ courts: 1 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    expect(rowStatuses(session)).toEqual([null]);

    session.advanceMinutes(15);
    const completion = session.apply("MatchCompleted", { matchId });
    expect(rowStatuses(session)).toEqual(["completed"]);

    session.undo(completion.seq);
    expect(rowStatuses(session)).toEqual(["reverted"]);
    expect(matchRecords(session.state, session.now)[0].status).toBe("active");

    const abandonment = session.apply("MatchAbandoned", { matchId });
    expect(rowStatuses(session)).toEqual(["abandoned"]);

    session.undo(abandonment.seq);
    expect(rowStatuses(session)).toEqual(["reverted"]);

    session.apply("MatchCompleted", { matchId });
    expect(rowStatuses(session)).toEqual(["completed"]);
  });

  it("drops the record when the start is undone after a reverted end", () => {
    const session = TestSession.start({ courts: 1 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    const startSeq = session.state.lastSeq;
    const completion = session.apply("MatchCompleted", { matchId });
    session.undo(completion.seq);
    session.undo(startSeq);
    expect(rowStatuses(session)).toEqual([]);
  });
});

describe("actionHistory", () => {
  it("lists every action oldest first with who did it, undo targets and compensations", () => {
    const session = TestSession.start();
    session.advanceMinutes(1);
    const skip = session.apply("PlayerSkipped", { participantId: p(1) });
    session.advanceMinutes(1);
    const unskip = session.undo(skip.seq);
    const shuffle = session.apply("SuggestionsShuffled", { seed: 9 });

    expect(actionHistory(session.state)).toEqual([
      {
        seq: 1,
        eventId: session.events[0].eventId,
        type: "SessionStarted",
        actorId: FIXTURE_ACTOR_ID,
        at: at(0),
        targetSeq: null,
        targetMatchId: null,
        compensatedBySeq: null,
      },
      {
        seq: skip.seq,
        eventId: skip.eventId,
        type: "PlayerSkipped",
        actorId: FIXTURE_ACTOR_ID,
        at: at(1),
        targetSeq: null,
        targetMatchId: null,
        compensatedBySeq: unskip.seq,
      },
      {
        seq: unskip.seq,
        eventId: unskip.eventId,
        type: "PlayerUnskipped",
        actorId: FIXTURE_ACTOR_ID,
        at: at(2),
        targetSeq: skip.seq,
        targetMatchId: null,
        compensatedBySeq: null,
      },
      {
        seq: shuffle.seq,
        eventId: shuffle.eventId,
        type: "SuggestionsShuffled",
        actorId: FIXTURE_ACTOR_ID,
        at: at(2),
        targetSeq: null,
        targetMatchId: null,
        compensatedBySeq: null,
      },
    ]);
  });
});
