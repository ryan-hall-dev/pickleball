// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  compensate,
  createInitialSessionState,
  type SessionEvent,
  type SessionEventPayloads,
  type SessionEventType,
  type SessionState,
} from "../session";
import { recommend } from "./recommend";
import { scheduleInputFromSession } from "./scheduleInputFromSession";
import { DEFAULT_SIMULATION_PREFERENCES } from "./simulation/simulateSession";
import {
  TEST_MINUTE_MS,
  testCourtId,
  testPlayerId as id,
} from "./testing/scheduleFixtures";

const START_AT = Date.UTC(2026, 10, 7, 18, 0, 0);

/** A minimal driver over the real action log. */
class Session {
  state: SessionState = createInitialSessionState();
  now = START_AT;

  advanceMinutes(minutes: number) {
    this.now += minutes * TEST_MINUTE_MS;
    return this;
  }

  private meta() {
    const seq = this.state.lastSeq + 1;
    return {
      seq,
      eventId: `00000000-0000-4000-a000-${seq.toString(16).padStart(12, "0")}`,
      at: this.now,
      actorId: "00000000-0000-4000-b000-000000000001",
    };
  }

  apply<TType extends SessionEventType>(
    type: TType,
    payload: SessionEventPayloads[TType],
  ): number {
    const event = { ...this.meta(), type, payload } as SessionEvent;
    const result = applyEvent(this.state, event);
    if (!result.ok) throw new Error(`${type}: ${result.error.message}`);
    this.state = result.state;
    return event.seq;
  }

  undo(targetSeq: number) {
    const result = compensate(this.state, targetSeq, this.meta());
    if (!result.ok) throw new Error(result.error.message);
    this.state = result.state;
  }

  input() {
    return scheduleInputFromSession(this.state, this.now);
  }

  player(number: number) {
    return this.input().players.find(
      (player) => player.participantId === id(number),
    );
  }
}

function startSession(playerCount: number, courtCount: number): Session {
  const session = new Session();
  const participants = Array.from({ length: playerCount }, (_, index) => ({
    participantId: id(index + 1),
    firstName: "Player",
    lastName: `${index + 1}`,
    skill: null,
  }));
  session.apply("SessionStarted", {
    config: {
      courts: Array.from({ length: courtCount }, (_, index) => ({
        courtId: testCourtId(index + 1),
        name: `Court ${index + 1}`,
        format: "doubles" as const,
      })),
      targetMatchMinutes: 15,
      changeoverMinutes: 2,
      plannedDurationMinutes: 120,
      rotation: DEFAULT_SIMULATION_PREFERENCES,
      participants,
    },
    initialAttendeeIds: participants.map(
      (participant) => participant.participantId,
    ),
  });
  return session;
}

describe("scheduleInputFromSession", () => {
  it("fails fast before the session starts", () => {
    expect(() =>
      scheduleInputFromSession(createInitialSessionState(), START_AT),
    ).toThrow(/before the session has started/);
  });

  it("snapshots players, courts and timings from the replayed log", () => {
    const session = startSession(6, 2);
    session.apply("MatchStarted", {
      matchId: "match-1",
      courtId: testCourtId(1),
      teamA: [id(1), id(2)],
      teamB: [id(3), id(4)],
    });
    session.advanceMinutes(14);
    session.apply("MatchCompleted", { matchId: "match-1" });
    session.advanceMinutes(3);

    const input = session.input();
    expect(input.slotMs).toBe(17 * TEST_MINUTE_MS);
    expect(input.expectedMatchMs).toBe(14 * TEST_MINUTE_MS);
    expect(input.courts.map((court) => court.currentMatchElapsedMs)).toEqual([
      null,
      null,
    ]);
    expect(session.player(1)).toMatchObject({
      status: "waiting",
      gamesCompleted: 1,
      presentMs: 17 * TEST_MINUTE_MS,
      playMs: 14 * TEST_MINUTE_MS,
      currentWaitMs: 3 * TEST_MINUTE_MS,
      restMs: 3 * TEST_MINUTE_MS,
      completedGameAgesMs: [3 * TEST_MINUTE_MS],
      partnerCounts: { [id(2)]: 1 },
    });
    expect(session.player(5)).toMatchObject({
      gamesCompleted: 0,
      currentWaitMs: 17 * TEST_MINUTE_MS,
      restMs: null,
    });
  });

  it("rotates the tie-break seed as matches complete and when the host shuffles", () => {
    const session = startSession(4, 1);
    const seedAtStart = session.input().seed;
    session.apply("SuggestionsShuffled", { seed: 12345 });
    const seedAfterShuffle = session.input().seed;
    expect(seedAfterShuffle).not.toBe(seedAtStart);
    session.apply("MatchStarted", {
      matchId: "match-1",
      courtId: testCourtId(1),
      teamA: [id(1), id(2)],
      teamB: [id(3), id(4)],
    });
    expect(session.input().seed).toBe(seedAfterShuffle);
    session.advanceMinutes(15);
    session.apply("MatchCompleted", { matchId: "match-1" });
    expect(session.input().seed).not.toBe(seedAfterShuffle);
  });

  it("marks players on court with their pending game and court", () => {
    const session = startSession(4, 1);
    session.apply("MatchStarted", {
      matchId: "match-1",
      courtId: testCourtId(1),
      teamA: [id(1), id(2)],
      teamB: [id(3), id(4)],
    });
    session.advanceMinutes(5);
    expect(session.player(1)).toMatchObject({
      status: "playing",
      pendingGameCredit: 1,
      currentCourtId: testCourtId(1),
    });
    expect(session.input().courts[0].currentMatchElapsedMs).toBe(
      5 * TEST_MINUTE_MS,
    );
  });

  it("excludes paused time from waits and rest (pause and resume)", () => {
    const session = startSession(4, 1);
    session.advanceMinutes(5);
    session.apply("Paused", {});
    session.advanceMinutes(10);
    session.apply("Resumed", {});
    session.advanceMinutes(2);
    expect(session.player(1)?.currentWaitMs).toBe(7 * TEST_MINUTE_MS);
  });

  it("leaves out closed courts until they reopen", () => {
    const session = startSession(8, 2);
    const closedSeq = session.apply("CourtClosed", { courtId: testCourtId(2) });
    expect(session.input().courts.map((court) => court.courtId)).toEqual([
      testCourtId(1),
    ]);
    expect(recommend(session.input()).readyNow).toHaveLength(1);
    session.undo(closedSeq);
    expect(recommend(session.input()).readyNow).toHaveLength(2);
  });

  it("drops players who left, keeps skipped players as not eligible, and restores stats on rejoin", () => {
    const session = startSession(6, 1);
    session.apply("MatchStarted", {
      matchId: "match-1",
      courtId: testCourtId(1),
      teamA: [id(1), id(2)],
      teamB: [id(3), id(4)],
    });
    session.advanceMinutes(15);
    session.apply("MatchCompleted", { matchId: "match-1" });
    session.apply("PlayerLeft", { participantId: id(1) });
    session.apply("PlayerSkipped", { participantId: id(5) });
    expect(session.player(1)).toBeUndefined();
    expect(session.player(5)?.status).toBe("skipped");

    session.advanceMinutes(10);
    session.apply("PlayerJoined", {
      participant: session.state.participants[id(1)].participant,
    });
    expect(session.player(1)).toMatchObject({
      status: "waiting",
      gamesCompleted: 1,
      currentWaitMs: 0,
    });
  });

  it("carries host locks and the manual order", () => {
    const session = startSession(6, 2);
    session.apply("PlayerLocked", {
      participantId: id(6),
      courtId: testCourtId(2),
    });
    session.apply("QueueReordered", { participantIds: [id(3), id(1)] });
    expect(session.player(6)).toMatchObject({
      isLocked: true,
      lockedCourtId: testCourtId(2),
    });
    expect(session.player(3)?.manualQueueRank).toBe(0);
    expect(session.player(1)?.manualQueueRank).toBe(1);
    expect(session.player(2)?.manualQueueRank).toBeNull();
  });
});
