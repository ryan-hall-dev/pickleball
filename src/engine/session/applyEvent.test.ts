// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyEvent, replay } from "./applyEvent";
import type { SessionErrorCode } from "./errors";
import type {
  SessionEvent,
  SessionEventPayloads,
  SessionEventType,
} from "./events";
import { matchRecords } from "./metrics";
import { createInitialSessionState } from "./state";
import {
  MINUTE_MS,
  TestSession,
  createEventLog,
  fixtureCourtId,
  fixtureParticipantId as p,
  makeConfig,
  makeCourt,
  makeParticipants,
} from "./testing/fixtures";

function expectRejected<TType extends SessionEventType>(
  session: TestSession,
  type: TType,
  payload: SessionEventPayloads[TType],
  code: SessionErrorCode,
) {
  const before = session.state;
  const result = session.tryApply(type, payload);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
    expect(result.error.message.length).toBeGreaterThan(0);
  }
  expect(session.state).toBe(before);
}

describe("envelope rules", () => {
  it("requires SessionStarted first", () => {
    const log = createEventLog();
    const event = log.add("PlayerLeft", { participantId: p(1) });
    const result = applyEvent(createInitialSessionState(), event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SESSION_NOT_STARTED");
  });

  it("rejects a non-increasing seq and time going backwards", () => {
    const session = TestSession.start();
    const meta = session.nextMeta();
    const duplicateSeq = applyEvent(session.state, {
      ...meta,
      seq: session.state.lastSeq,
      type: "Paused",
      payload: {},
    });
    expect(duplicateSeq.ok).toBe(false);
    if (!duplicateSeq.ok)
      expect(duplicateSeq.error.code).toBe("SEQ_NOT_INCREASING");

    const earlier = applyEvent(session.state, {
      ...meta,
      at: session.now - 1,
      type: "Paused",
      payload: {},
    });
    expect(earlier.ok).toBe(false);
    if (!earlier.ok) expect(earlier.error.code).toBe("TIME_WENT_BACKWARDS");
  });

  it("accepts gaps in seq and equal timestamps", () => {
    const session = TestSession.start();
    const result = applyEvent(session.state, {
      ...session.nextMeta(),
      seq: session.state.lastSeq + 5,
      type: "Paused",
      payload: {},
    });
    expect(result.ok).toBe(true);
  });

  it("returns MALFORMED_EVENT instead of throwing for structurally broken events", () => {
    const session = TestSession.start();
    const unknownType = applyEvent(session.state, {
      ...session.nextMeta(),
      type: "Nonsense",
      payload: {},
    } as unknown as SessionEvent);
    expect(unknownType.ok).toBe(false);
    if (!unknownType.ok) expect(unknownType.error.code).toBe("MALFORMED_EVENT");

    const missingPayloadFields = applyEvent(session.state, {
      ...session.nextMeta(),
      type: "MatchStarted",
      payload: { courtId: fixtureCourtId(1) },
    } as unknown as SessionEvent);
    expect(missingPayloadFields.ok).toBe(false);
    if (!missingPayloadFields.ok) {
      expect(missingPayloadFields.error.code).toBe("MALFORMED_EVENT");
    }

    const compensationWithoutTarget = applyEvent(session.state, {
      ...session.nextMeta(),
      type: "PlayerUnskipped",
      payload: {},
    } as unknown as SessionEvent);
    expect(compensationWithoutTarget.ok).toBe(false);
    if (!compensationWithoutTarget.ok) {
      expect(compensationWithoutTarget.error.code).toBe("MALFORMED_EVENT");
    }
  });

  it("rejects everything after SessionEnded", () => {
    const session = TestSession.start();
    session.apply("SessionEnded", {});
    expectRejected(session, "Paused", {}, "SESSION_ENDED");
    expectRejected(
      session,
      "PlayerLeft",
      { participantId: p(1) },
      "SESSION_ENDED",
    );
  });

  it("never mutates the input state", () => {
    const session = TestSession.start();
    const snapshot = structuredClone(session.state);
    const before = session.state;
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.apply("PlayerSkipped", { participantId: p(5) });
    expect(before).toEqual(snapshot);
  });
});

describe("SessionStarted", () => {
  it("creates courts and present attendees", () => {
    const session = TestSession.start({ participantCount: 6, courts: 2 });
    expect(session.state.phase).toBe("live");
    expect(Object.keys(session.state.courts)).toHaveLength(2);
    expect(session.players().map((metrics) => metrics.status)).toEqual(
      Array(6).fill("waiting"),
    );
  });

  it("only makes listed attendees present", () => {
    const session = TestSession.start({
      participantCount: 6,
      attendeeIds: [p(1), p(2)],
    });
    expect(Object.keys(session.state.participants)).toEqual([p(1), p(2)]);
  });

  it("starts initial matches with the session", () => {
    const participants = makeParticipants(4);
    const session = new TestSession();
    session.apply("SessionStarted", {
      config: makeConfig({ participants, courts: 1 }),
      initialAttendeeIds: participants.map(
        (participant) => participant.participantId,
      ),
      initialMatches: [
        {
          matchId: "m1",
          courtId: fixtureCourtId(1),
          teamA: [p(1), p(2)],
          teamB: [p(3), p(4)],
        },
      ],
    });
    expect(session.courts()[0].status).toBe("busy");
    expect(session.player(p(1)).status).toBe("playing");
  });

  it.each<
    [string, Partial<Parameters<typeof makeConfig>[0]>, SessionErrorCode]
  >([
    ["no courts", { courts: 0 }, "INVALID_CONFIG"],
    ["zero match length", { targetMatchMinutes: 0 }, "INVALID_CONFIG"],
    ["negative changeover", { changeoverMinutes: -1 }, "INVALID_CONFIG"],
    ["zero planned duration", { plannedDurationMinutes: 0 }, "INVALID_CONFIG"],
  ])("rejects %s", (_, options, code) => {
    const session = new TestSession();
    expectRejected(
      session,
      "SessionStarted",
      { config: makeConfig(options), initialAttendeeIds: [] },
      code,
    );
  });

  it("rejects duplicate courts, unknown formats, repeated objectives, unknown or duplicate attendees", () => {
    const participants = makeParticipants(2);
    const base = makeConfig({ participants });
    const session = new TestSession();
    expectRejected(
      session,
      "SessionStarted",
      {
        config: { ...base, courts: [base.courts[0], base.courts[0]] },
        initialAttendeeIds: [],
      },
      "DUPLICATE_ID",
    );
    expectRejected(
      session,
      "SessionStarted",
      {
        config: {
          ...base,
          courts: [{ ...base.courts[0], format: "triples" as "singles" }],
        },
        initialAttendeeIds: [],
      },
      "INVALID_CONFIG",
    );
    expectRejected(
      session,
      "SessionStarted",
      {
        config: {
          ...base,
          rotation: {
            ...base.rotation,
            objectiveOrder: ["equalGames", "equalGames"],
          },
        },
        initialAttendeeIds: [],
      },
      "INVALID_CONFIG",
    );
    expectRejected(
      session,
      "SessionStarted",
      { config: base, initialAttendeeIds: [p(99)] },
      "UNKNOWN_PARTICIPANT",
    );
    expectRejected(
      session,
      "SessionStarted",
      { config: base, initialAttendeeIds: [p(1), p(1)] },
      "DUPLICATE_ID",
    );
  });

  it("rejects invalid initial matches and a second start", () => {
    const participants = makeParticipants(4);
    const config = makeConfig({ participants, courts: 1 });
    const session = new TestSession();
    expectRejected(
      session,
      "SessionStarted",
      {
        config,
        initialAttendeeIds: [p(1), p(2), p(3)],
        initialMatches: [
          {
            matchId: "m1",
            courtId: fixtureCourtId(1),
            teamA: [p(1), p(2)],
            teamB: [p(3), p(4)],
          },
        ],
      },
      "UNKNOWN_PARTICIPANT",
    );
    session.apply("SessionStarted", { config, initialAttendeeIds: [] });
    expectRejected(
      session,
      "SessionStarted",
      { config, initialAttendeeIds: [] },
      "SESSION_ALREADY_STARTED",
    );
  });
});

describe("PlayerJoined / PlayerLeft", () => {
  it("adds a late arrival and lets a leaver rejoin with their stats", () => {
    const session = TestSession.start({ participantCount: 4, courts: 1 });
    const [newcomer] = makeParticipants(1, 77).map((participant) => ({
      ...participant,
      participantId: "late-1",
    }));
    session.apply("PlayerJoined", { participant: newcomer });
    expect(session.player("late-1").status).toBe("waiting");

    session.apply("PlayerLeft", { participantId: p(1) });
    expect(session.player(p(1)).status).toBe("away");
    session.apply("PlayerJoined", {
      participant: {
        ...session.player(p(1)).participant,
        firstName: "Renamed",
      },
    });
    expect(session.player(p(1)).status).toBe("waiting");
    // A returning participant keeps their original snapshot.
    expect(session.player(p(1)).participant.firstName).not.toBe("Renamed");
  });

  it("rejects joining twice, leaving twice, leaving mid-match and unknown players", () => {
    const session = TestSession.start({ participantCount: 5, courts: 1 });
    expectRejected(
      session,
      "PlayerJoined",
      { participant: session.player(p(1)).participant },
      "PLAYER_ALREADY_PRESENT",
    );
    expectRejected(
      session,
      "PlayerJoined",
      {
        participant: { ...session.player(p(1)).participant, participantId: "" },
      },
      "MALFORMED_EVENT",
    );
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    expectRejected(
      session,
      "PlayerLeft",
      { participantId: p(1) },
      "PLAYER_PLAYING",
    );
    expectRejected(
      session,
      "PlayerLeft",
      { participantId: p(99) },
      "UNKNOWN_PARTICIPANT",
    );
    session.apply("PlayerLeft", { participantId: p(5) });
    expectRejected(
      session,
      "PlayerLeft",
      { participantId: p(5) },
      "PLAYER_NOT_PRESENT",
    );
  });
});

describe("PlayerSkipped / PlayerLocked", () => {
  it("skips and locks a waiting player", () => {
    const session = TestSession.start({ courts: 1 });
    session.apply("PlayerSkipped", { participantId: p(1) });
    expect(session.player(p(1)).status).toBe("skipped");
    session.apply("PlayerLocked", {
      participantId: p(2),
      courtId: fixtureCourtId(1),
    });
    expect(session.player(p(2))).toMatchObject({
      isLocked: true,
      lockedCourtId: fixtureCourtId(1),
    });
    session.apply("PlayerLocked", { participantId: p(3) });
    expect(session.player(p(3))).toMatchObject({
      isLocked: true,
      lockedCourtId: null,
    });
  });

  it("allows locking a player who is playing (for Up next)", () => {
    const session = TestSession.start({ courts: 1 });
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.apply("PlayerLocked", { participantId: p(1) });
    expect(session.player(p(1)).isLocked).toBe(true);
  });

  it("rejects invalid skips and locks", () => {
    const session = TestSession.start({ participantCount: 6, courts: 1 });
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    expectRejected(
      session,
      "PlayerSkipped",
      { participantId: p(1) },
      "PLAYER_PLAYING",
    );
    session.apply("PlayerSkipped", { participantId: p(5) });
    expectRejected(
      session,
      "PlayerSkipped",
      { participantId: p(5) },
      "PLAYER_SKIPPED",
    );
    session.apply("PlayerLeft", { participantId: p(6) });
    expectRejected(
      session,
      "PlayerSkipped",
      { participantId: p(6) },
      "PLAYER_NOT_PRESENT",
    );
    expectRejected(
      session,
      "PlayerLocked",
      { participantId: p(6) },
      "PLAYER_NOT_PRESENT",
    );
    expectRejected(
      session,
      "PlayerLocked",
      { participantId: p(5), courtId: "nope" },
      "UNKNOWN_COURT",
    );
    session.apply("PlayerLocked", { participantId: p(5) });
    expectRejected(
      session,
      "PlayerLocked",
      { participantId: p(5) },
      "PLAYER_LOCKED",
    );
    expectRejected(
      session,
      "PlayerLocked",
      { participantId: p(99) },
      "UNKNOWN_PARTICIPANT",
    );
  });
});

describe("courts", () => {
  it("adds and closes courts mid-session", () => {
    const session = TestSession.start({ courts: 1 });
    session.apply("CourtAdded", { court: makeCourt(2, "singles") });
    expect(session.courts().map((court) => court.status)).toEqual([
      "free",
      "free",
    ]);
    session.apply("CourtClosed", { courtId: fixtureCourtId(2) });
    expect(session.courts()[1].status).toBe("closed");
  });

  it("rejects invalid court actions", () => {
    const session = TestSession.start({ courts: 1 });
    expectRejected(
      session,
      "CourtAdded",
      { court: makeCourt(1, "doubles") },
      "DUPLICATE_ID",
    );
    expectRejected(
      session,
      "CourtAdded",
      { court: { ...makeCourt(2, "doubles"), format: "quads" as "doubles" } },
      "INVALID_CONFIG",
    );
    expectRejected(
      session,
      "CourtClosed",
      { courtId: "nope" },
      "UNKNOWN_COURT",
    );
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    expectRejected(
      session,
      "CourtClosed",
      { courtId: fixtureCourtId(1) },
      "COURT_BUSY",
    );
    session.apply("CourtAdded", { court: makeCourt(2, "doubles") });
    session.apply("CourtClosed", { courtId: fixtureCourtId(2) });
    expectRejected(
      session,
      "CourtClosed",
      { courtId: fixtureCourtId(2) },
      "COURT_CLOSED",
    );
  });
});

describe("MatchStarted", () => {
  it("starts doubles and singles matches on mixed courts", () => {
    const session = TestSession.start({
      participantCount: 6,
      courts: ["doubles", "singles"],
    });
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.startMatch(2, [p(5)], [p(6)]);
    expect(
      session.players().every((metrics) => metrics.status === "playing"),
    ).toBe(true);
    expect(session.courts().map((court) => court.status)).toEqual([
      "busy",
      "busy",
    ]);
  });

  it("consumes locks and manual queue ranks of the players who start", () => {
    const session = TestSession.start({ participantCount: 6, courts: 1 });
    session.apply("PlayerLocked", { participantId: p(1) });
    session.apply("QueueReordered", { participantIds: [p(5), p(1), p(6)] });
    session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    expect(session.player(p(1)).isLocked).toBe(false);
    expect(session.player(p(1)).manualQueueRank).toBeNull();
    expect(session.state.queueOrder).toEqual([p(5), p(6)]);
  });

  it.each<
    [
      string,
      (session: TestSession) => void,
      () => SessionEventPayloads["MatchStarted"],
      SessionErrorCode,
    ]
  >([
    [
      "wrong team size for doubles",
      () => {},
      () => ({
        matchId: "m",
        courtId: fixtureCourtId(1),
        teamA: [p(1)],
        teamB: [p(2)],
      }),
      "INVALID_TEAMS",
    ],
    [
      "wrong team size for singles",
      () => {},
      () => ({
        matchId: "m",
        courtId: fixtureCourtId(2),
        teamA: [p(1), p(2)],
        teamB: [p(3), p(4)],
      }),
      "INVALID_TEAMS",
    ],
    [
      "a duplicated player",
      () => {},
      () => ({
        matchId: "m",
        courtId: fixtureCourtId(1),
        teamA: [p(1), p(2)],
        teamB: [p(1), p(4)],
      }),
      "INVALID_TEAMS",
    ],
    [
      "an unknown court",
      () => {},
      () => ({
        matchId: "m",
        courtId: "nope",
        teamA: [p(1), p(2)],
        teamB: [p(3), p(4)],
      }),
      "UNKNOWN_COURT",
    ],
    [
      "a closed court",
      (session) => session.apply("CourtClosed", { courtId: fixtureCourtId(1) }),
      () => ({
        matchId: "m",
        courtId: fixtureCourtId(1),
        teamA: [p(1), p(2)],
        teamB: [p(3), p(4)],
      }),
      "COURT_CLOSED",
    ],
    [
      "a busy court",
      (session) => session.startMatch(1, [p(5), p(6)], [p(7), p(8)]),
      () => ({
        matchId: "m",
        courtId: fixtureCourtId(1),
        teamA: [p(1), p(2)],
        teamB: [p(3), p(4)],
      }),
      "COURT_BUSY",
    ],
    [
      "a player already playing",
      (session) => session.startMatch(2, [p(1)], [p(5)]),
      () => ({
        matchId: "m",
        courtId: fixtureCourtId(1),
        teamA: [p(1), p(2)],
        teamB: [p(3), p(4)],
      }),
      "PLAYER_PLAYING",
    ],
    [
      "a skipped player",
      (session) => session.apply("PlayerSkipped", { participantId: p(2) }),
      () => ({
        matchId: "m",
        courtId: fixtureCourtId(1),
        teamA: [p(1), p(2)],
        teamB: [p(3), p(4)],
      }),
      "PLAYER_SKIPPED",
    ],
    [
      "an away player",
      (session) => session.apply("PlayerLeft", { participantId: p(3) }),
      () => ({
        matchId: "m",
        courtId: fixtureCourtId(1),
        teamA: [p(1), p(2)],
        teamB: [p(3), p(4)],
      }),
      "PLAYER_NOT_PRESENT",
    ],
    [
      "an unknown player",
      () => {},
      () => ({
        matchId: "m",
        courtId: fixtureCourtId(1),
        teamA: [p(1), p(2)],
        teamB: [p(3), p(99)],
      }),
      "UNKNOWN_PARTICIPANT",
    ],
    [
      "a reused match id",
      (session) =>
        session.apply("MatchStarted", {
          matchId: "m",
          courtId: fixtureCourtId(2),
          teamA: [p(5)],
          teamB: [p(6)],
        }),
      () => ({
        matchId: "m",
        courtId: fixtureCourtId(1),
        teamA: [p(1), p(2)],
        teamB: [p(3), p(4)],
      }),
      "DUPLICATE_ID",
    ],
  ])("rejects %s", (_, arrange, payload, code) => {
    const session = TestSession.start({
      participantCount: 8,
      courts: ["doubles", "singles"],
    });
    arrange(session);
    expectRejected(session, "MatchStarted", payload(), code);
  });

  it("cannot fill a court with fewer than k present players", () => {
    const session = TestSession.start({ participantCount: 3, courts: 1 });
    expectRejected(
      session,
      "MatchStarted",
      {
        matchId: "m",
        courtId: fixtureCourtId(1),
        teamA: [p(1), p(2)],
        teamB: [p(3), p(4)],
      },
      "UNKNOWN_PARTICIPANT",
    );
  });
});

describe("MatchCompleted / MatchAbandoned / PlayerReplaced", () => {
  it("completes a match, freeing the court and the players", () => {
    const session = TestSession.start({ courts: 1 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(15);
    session.apply("MatchCompleted", { matchId });
    expect(session.courts()[0].status).toBe("free");
    expect(session.player(p(1))).toMatchObject({
      status: "waiting",
      gamesCompleted: 1,
    });
  });

  it("abandons a match without crediting games", () => {
    const session = TestSession.start({ courts: 1 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(5);
    session.apply("MatchAbandoned", { matchId });
    expect(session.player(p(1))).toMatchObject({
      gamesCompleted: 0,
      committedGames: 0,
      playMs: 5 * 60_000,
    });
  });

  it("replaces a player in the same seat", () => {
    const session = TestSession.start({ courts: 1 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(4);
    session.apply("PlayerReplaced", {
      matchId,
      outId: p(2),
      inId: p(5),
      countGameForOut: false,
    });
    expect(session.player(p(2)).status).toBe("waiting");
    expect(session.player(p(5)).status).toBe("playing");
    expect(session.player(p(1)).partnerCounts).toEqual({ [p(5)]: 1 });
  });

  it("rejects actions on finished or unknown matches and bad replacements", () => {
    const session = TestSession.start({ participantCount: 7, courts: 2 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    expectRejected(
      session,
      "PlayerReplaced",
      { matchId, outId: p(5), inId: p(6), countGameForOut: false },
      "PLAYER_NOT_IN_MATCH",
    );
    expectRejected(
      session,
      "PlayerReplaced",
      { matchId, outId: p(1), inId: p(2), countGameForOut: false },
      "PLAYER_PLAYING",
    );
    session.apply("PlayerSkipped", { participantId: p(6) });
    expectRejected(
      session,
      "PlayerReplaced",
      { matchId, outId: p(1), inId: p(6), countGameForOut: false },
      "PLAYER_SKIPPED",
    );
    session.apply("PlayerLeft", { participantId: p(7) });
    expectRejected(
      session,
      "PlayerReplaced",
      { matchId, outId: p(1), inId: p(7), countGameForOut: false },
      "PLAYER_NOT_PRESENT",
    );
    session.apply("MatchCompleted", { matchId });
    expectRejected(session, "MatchCompleted", { matchId }, "MATCH_NOT_ACTIVE");
    expectRejected(session, "MatchAbandoned", { matchId }, "MATCH_NOT_ACTIVE");
    expectRejected(
      session,
      "PlayerReplaced",
      { matchId, outId: p(1), inId: p(5), countGameForOut: false },
      "MATCH_NOT_ACTIVE",
    );
    expectRejected(
      session,
      "MatchCompleted",
      { matchId: "nope" },
      "UNKNOWN_MATCH",
    );
  });
});

describe("PlayerRemovedMidMatch", () => {
  it.each([true, false])(
    "takes a player off court with nobody in their seat; the match continues short-handed (countGameForOut %s)",
    (countGameForOut) => {
      const session = TestSession.start({ courts: 1 });
      const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
      session.advanceMinutes(4);
      session.apply("PlayerRemovedMidMatch", {
        matchId,
        participantId: p(2),
        countGameForOut,
      });
      expect(session.player(p(2))).toMatchObject({
        status: "waiting",
        playMs: 4 * MINUTE_MS,
        currentMatchId: null,
        lastMatchEndAt: session.now,
      });
      expect(session.courts()[0]).toMatchObject({
        status: "busy",
        currentMatchId: matchId,
      });
      // The removed player is free for other actions straight away.
      session.apply("PlayerLeft", { participantId: p(2) });

      session.advanceMinutes(8);
      session.apply("MatchCompleted", { matchId });
      const [record] = matchRecords(session.state, session.now);
      expect(record).toMatchObject({ teamA: [p(1)], teamB: [p(3), p(4)] });
      expect(record.creditedParticipantIds.includes(p(2))).toBe(
        countGameForOut,
      );
      expect(session.player(p(2)).gamesCompleted).toBe(countGameForOut ? 1 : 0);
      expect(session.player(p(1))).toMatchObject({
        gamesCompleted: 1,
        partnerCounts: {},
      });
    },
  );

  it("rejects removing from a finished or unknown match, a player not on court, the last player, or while paused", () => {
    const session = TestSession.start({ courts: 2, format: "singles" });
    const matchId = session.startMatch(1, [p(1)], [p(2)]);
    expectRejected(
      session,
      "PlayerRemovedMidMatch",
      { matchId: "nope", participantId: p(1), countGameForOut: false },
      "UNKNOWN_MATCH",
    );
    expectRejected(
      session,
      "PlayerRemovedMidMatch",
      { matchId, participantId: p(3), countGameForOut: false },
      "PLAYER_NOT_IN_MATCH",
    );
    session.apply("PlayerRemovedMidMatch", {
      matchId,
      participantId: p(1),
      countGameForOut: false,
    });
    expectRejected(
      session,
      "PlayerRemovedMidMatch",
      { matchId, participantId: p(1), countGameForOut: false },
      "PLAYER_NOT_IN_MATCH",
    );
    expectRejected(
      session,
      "PlayerRemovedMidMatch",
      { matchId, participantId: p(2), countGameForOut: false },
      "INVALID_TEAMS",
    );

    const doubles = TestSession.start({ courts: 1 });
    const doublesMatch = doubles.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    doubles.apply("Paused", {});
    expectRejected(
      doubles,
      "PlayerRemovedMidMatch",
      { matchId: doublesMatch, participantId: p(1), countGameForOut: false },
      "SESSION_PAUSED",
    );
    doubles.apply("Resumed", {});
    doubles.apply("MatchAbandoned", { matchId: doublesMatch });
    expectRejected(
      doubles,
      "PlayerRemovedMidMatch",
      { matchId: doublesMatch, participantId: p(1), countGameForOut: false },
      "MATCH_NOT_ACTIVE",
    );
  });
});

describe("review regressions", () => {
  it("never reuses a match id, even after its start was undone or from an initial match", () => {
    const session = TestSession.start({ courts: 2 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.undo(session.state.lastSeq);
    expectRejected(
      session,
      "MatchStarted",
      {
        matchId,
        courtId: fixtureCourtId(1),
        teamA: [p(1), p(2)],
        teamB: [p(3), p(4)],
      },
      "DUPLICATE_ID",
    );

    const participants = makeParticipants(8);
    const withInitialMatch = new TestSession();
    withInitialMatch.apply("SessionStarted", {
      config: makeConfig({ participants }),
      initialAttendeeIds: participants.map(
        (participant) => participant.participantId,
      ),
      initialMatches: [
        {
          matchId: "initial-match",
          courtId: fixtureCourtId(1),
          teamA: [p(1), p(2)],
          teamB: [p(3), p(4)],
        },
      ],
    });
    expectRejected(
      withInitialMatch,
      "MatchStarted",
      {
        matchId: "initial-match",
        courtId: fixtureCourtId(2),
        teamA: [p(5), p(6)],
        teamB: [p(7), p(8)],
      },
      "DUPLICATE_ID",
    );
  });

  it("rejects locking a player to a closed court", () => {
    const session = TestSession.start({ courts: 2 });
    session.apply("CourtClosed", { courtId: fixtureCourtId(2) });
    expectRejected(
      session,
      "PlayerLocked",
      { participantId: p(1), courtId: fixtureCourtId(2) },
      "COURT_CLOSED",
    );
  });
});

describe("pause rules", () => {
  it("blocks match changes while paused but allows roster changes", () => {
    const session = TestSession.start({ participantCount: 9, courts: 2 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.apply("Paused", {});
    expectRejected(session, "Paused", {}, "SESSION_PAUSED");
    expectRejected(
      session,
      "MatchStarted",
      {
        matchId: "m2",
        courtId: fixtureCourtId(2),
        teamA: [p(5), p(6)],
        teamB: [p(7), p(8)],
      },
      "SESSION_PAUSED",
    );
    expectRejected(session, "MatchCompleted", { matchId }, "SESSION_PAUSED");
    expectRejected(session, "MatchAbandoned", { matchId }, "SESSION_PAUSED");
    expectRejected(
      session,
      "PlayerReplaced",
      { matchId, outId: p(1), inId: p(5), countGameForOut: false },
      "SESSION_PAUSED",
    );
    session.apply("PlayerLeft", { participantId: p(9) });
    session.apply("PlayerSkipped", { participantId: p(8) });
    session.apply("QueueReordered", { participantIds: [p(5)] });
    session.apply("SuggestionsShuffled", { seed: 7 });
    session.apply("Resumed", {});
    expectRejected(session, "Resumed", {}, "SESSION_NOT_PAUSED");
    session.apply("MatchCompleted", { matchId });
  });

  it("can end while paused, closing the pause", () => {
    const session = TestSession.start();
    session.apply("Paused", {});
    session.advanceMinutes(5);
    session.apply("SessionEnded", {});
    expect(session.state.pauses[0].to).toBe(session.now);
    expect(session.clock()).toMatchObject({ isPaused: false, phase: "ended" });
  });
});

describe("QueueReordered / SuggestionsShuffled / SessionEnded", () => {
  it("records the manual order and the seed", () => {
    const session = TestSession.start();
    session.apply("QueueReordered", { participantIds: [p(3), p(1)] });
    expect(session.player(p(3)).manualQueueRank).toBe(0);
    expect(session.player(p(1)).manualQueueRank).toBe(1);
    expect(session.player(p(2)).manualQueueRank).toBeNull();
    session.apply("SuggestionsShuffled", { seed: 42 });
    expect(session.state.suggestionSeed).toBe(42);
  });

  it("rejects bad orders and seeds", () => {
    const session = TestSession.start();
    expectRejected(
      session,
      "QueueReordered",
      { participantIds: [p(1), p(1)] },
      "INVALID_QUEUE_ORDER",
    );
    expectRejected(
      session,
      "QueueReordered",
      { participantIds: [p(99)] },
      "UNKNOWN_PARTICIPANT",
    );
    expectRejected(
      session,
      "SuggestionsShuffled",
      { seed: Number.NaN },
      "MALFORMED_EVENT",
    );
  });

  it("refuses to end with matches in progress", () => {
    const session = TestSession.start();
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    expectRejected(session, "SessionEnded", {}, "MATCHES_IN_PROGRESS");
    session.apply("MatchCompleted", { matchId });
    session.apply("SessionEnded", {});
    expect(session.state.phase).toBe("ended");
  });
});

describe("replay", () => {
  it("folds a log into the same state as applying one by one", () => {
    const session = TestSession.start({ courts: 2 });
    const matchId = session.startMatch(1, [p(1), p(2)], [p(3), p(4)]);
    session.advanceMinutes(10);
    session.apply("MatchCompleted", { matchId });
    session.undo(session.state.lastSeq);
    const result = replay(session.events);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state).toEqual(session.state);
  });

  it("reports the first rejected event with its seq and the state before it", () => {
    const log = createEventLog();
    const participants = makeParticipants(4);
    log.add("SessionStarted", {
      config: makeConfig({ participants, courts: 1 }),
      initialAttendeeIds: participants.map(
        (participant) => participant.participantId,
      ),
    });
    log.add("PlayerLeft", { participantId: p(1) });
    log.add("PlayerLeft", { participantId: p(1) });
    log.add("PlayerLeft", { participantId: p(2) });
    const result = replay(log.events);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedSeq).toBe(3);
      expect(result.error.code).toBe("PLAYER_NOT_PRESENT");
      expect(result.state.lastSeq).toBe(2);
    }
  });
});
