// Seeded test data and a small session driver for engine tests and
// simulations. Test-only: never import from production code.
import { applyEvent, type ApplyEventResult } from "../applyEvent";
import { compensate, type CompensateResult } from "../compensate";
import type {
  EventMeta,
  MatchAssignment,
  SessionEvent,
  SessionEventOf,
  SessionEventPayloads,
  SessionEventType,
} from "../events";
import {
  courtMetrics,
  playerMetrics,
  sessionClock,
  type CourtMetrics,
  type PlayerMetrics,
  type SessionClock,
} from "../metrics";
import { createInitialSessionState, type SessionState } from "../state";
import {
  RECOMMENDED_ROTATION_PREFERENCES,
  type CourtConfig,
  type CourtFormat,
  type Participant,
  type ParticipantId,
  type RotationPreferences,
  type SessionConfig,
  type SkillLevel,
} from "../types";

/** Mulberry32: a tiny deterministic RNG returning floats in [0, 1). */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A UUID-shaped id that is stable for a given prefix digit and number. */
export function fixtureUuid(prefix: string, number: number): string {
  return `${prefix.padStart(8, "0")}-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
}

/** Id of the `number`-th (1-based) participant from `makeParticipants`. */
export function fixtureParticipantId(number: number): ParticipantId {
  return fixtureUuid("p", number);
}

/** Id of court `number` (1-based) from `makeConfig`. */
export function fixtureCourtId(number: number): string {
  return fixtureUuid("c", number);
}

const FIRST_NAMES = [
  "Grace",
  "Kofi",
  "Zoe",
  "Ravi",
  "Mia",
  "Leo",
  "Ana",
  "Sam",
  "Ivy",
  "Omar",
  "Lena",
  "Theo",
  "Nia",
  "Jon",
  "Ella",
  "Kai",
  "Rosa",
  "Finn",
  "Maya",
  "Ben",
];
const LAST_NAMES = [
  "Kim",
  "Mensah",
  "Park",
  "Patel",
  "Rossi",
  "Chen",
  "Silva",
  "Nguyen",
  "Brown",
  "Haddad",
  "Novak",
  "Okafor",
  "Lopez",
  "Smith",
  "Tanaka",
  "Moreau",
];
const SKILLS: Array<SkillLevel | null> = [
  "beginner",
  "intermediate",
  "advanced",
  null,
];

/** `count` participants with stable UUIDs (`fixtureUuid("p", i + 1)`) and seeded names and skills. */
export function makeParticipants(count: number, seed = 1): Participant[] {
  const random = createSeededRandom(seed);
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)];
  return Array.from({ length: count }, (_, index) => ({
    participantId: fixtureParticipantId(index + 1),
    firstName: pick(FIRST_NAMES),
    lastName: `${pick(LAST_NAMES)} ${index + 1}`,
    skill: pick(SKILLS),
    isGuest: random() < 0.2,
  }));
}

export const DEFAULT_ROTATION: RotationPreferences =
  RECOMMENDED_ROTATION_PREFERENCES;

/** Court `i` (1-based) has id `fixtureUuid("c", i)` and name "Court i". */
export function makeCourt(number: number, format: CourtFormat): CourtConfig {
  return {
    courtId: fixtureCourtId(number),
    name: `Court ${number}`,
    format,
  };
}

export interface MakeConfigOptions {
  /** A count (all `format`) or one format per court, for mixed sessions. Default 2. */
  courts?: number | CourtFormat[];
  /** Default "doubles". */
  format?: CourtFormat;
  participants?: Participant[];
  targetMatchMinutes?: number;
  changeoverMinutes?: number;
  plannedDurationMinutes?: number;
  rotation?: RotationPreferences;
}

export function makeConfig(options: MakeConfigOptions = {}): SessionConfig {
  const format = options.format ?? "doubles";
  const courts = options.courts ?? 2;
  const formats =
    typeof courts === "number"
      ? Array.from({ length: courts }, () => format)
      : courts;
  return {
    courts: formats.map((courtFormat, index) =>
      makeCourt(index + 1, courtFormat),
    ),
    targetMatchMinutes: options.targetMatchMinutes ?? 15,
    changeoverMinutes: options.changeoverMinutes ?? 2,
    plannedDurationMinutes: options.plannedDurationMinutes ?? 120,
    rotation: options.rotation ?? DEFAULT_ROTATION,
    participants: options.participants ?? [],
  };
}

export const FIXTURE_START_AT = Date.UTC(2026, 10, 7, 18, 0, 0);
export const FIXTURE_ACTOR_ID = fixtureUuid("a", 1);
export const MINUTE_MS = 60_000;

/** Stamps seq (1, 2, …), eventId and `at` onto events, without applying them. */
export function createEventLog(startAt = FIXTURE_START_AT) {
  let now = startAt;
  let seq = 0;
  const events: SessionEvent[] = [];
  return {
    events,
    get now() {
      return now;
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    nextMeta(): EventMeta {
      seq += 1;
      return {
        seq,
        eventId: fixtureUuid("e", seq),
        at: now,
        actorId: FIXTURE_ACTOR_ID,
      };
    },
    add<TType extends SessionEventType>(
      type: TType,
      payload: SessionEventPayloads[TType],
    ): SessionEventOf<TType> {
      const event = { ...this.nextMeta(), type, payload };
      events.push(event as SessionEvent);
      return event;
    },
  };
}

/**
 * A live session for tests: stamps and applies events, keeps the log, and
 * throws on rejection (use `tryApply` / `tryUndo` to inspect errors).
 */
export class TestSession {
  state: SessionState = createInitialSessionState();
  readonly events: SessionEvent[] = [];
  now: number;

  constructor(startAt = FIXTURE_START_AT) {
    this.now = startAt;
  }

  /** Starts a session with `participants` all present and the given courts. */
  static start(
    options: MakeConfigOptions & {
      participantCount?: number;
      seed?: number;
      attendeeIds?: ParticipantId[];
      startAt?: number;
      initialMatches?: MatchAssignment[];
    } = {},
  ): TestSession {
    const participants =
      options.participants ??
      makeParticipants(options.participantCount ?? 8, options.seed ?? 1);
    const config = makeConfig({ ...options, participants });
    const session = new TestSession(options.startAt);
    session.apply("SessionStarted", {
      config,
      initialAttendeeIds:
        options.attendeeIds ??
        participants.map((participant) => participant.participantId),
      initialMatches: options.initialMatches,
    });
    return session;
  }

  get config(): SessionConfig {
    if (!this.state.config) throw new Error("Session not started");
    return this.state.config;
  }

  advanceMinutes(minutes: number): this {
    this.now += minutes * MINUTE_MS;
    return this;
  }

  nextMeta(): EventMeta {
    const seq = this.state.lastSeq + 1;
    return {
      seq,
      eventId: fixtureUuid("e", seq),
      at: this.now,
      actorId: FIXTURE_ACTOR_ID,
    };
  }

  tryApply<TType extends SessionEventType>(
    type: TType,
    payload: SessionEventPayloads[TType],
  ): ApplyEventResult {
    const event = { ...this.nextMeta(), type, payload } as SessionEvent;
    const result = applyEvent(this.state, event);
    if (result.ok) {
      this.state = result.state;
      this.events.push(event);
    }
    return result;
  }

  apply<TType extends SessionEventType>(
    type: TType,
    payload: SessionEventPayloads[TType],
  ): SessionEventOf<TType> {
    const result = this.tryApply(type, payload);
    if (!result.ok) {
      throw new Error(
        `${type} rejected: ${result.error.code} ${result.error.message}`,
      );
    }
    return this.events[this.events.length - 1] as SessionEventOf<TType>;
  }

  /** `targetMatchId` picks one match started with the session (target = seq 1). */
  tryUndo(targetSeq: number, targetMatchId?: string): CompensateResult {
    const result = compensate(
      this.state,
      targetSeq,
      this.nextMeta(),
      targetMatchId,
    );
    if (result.ok) {
      this.state = result.state;
      this.events.push(result.event);
    }
    return result;
  }

  undo(targetSeq: number, targetMatchId?: string): SessionEvent {
    const result = this.tryUndo(targetSeq, targetMatchId);
    if (!result.ok) {
      throw new Error(
        `Undo of ${targetSeq} rejected: ${result.error.code} ${result.error.message}`,
      );
    }
    return result.event;
  }

  /** Starts a match on court `courtNumber` (1-based) and returns its id. */
  startMatch(
    courtNumber: number,
    teamA: ParticipantId[],
    teamB: ParticipantId[],
  ): string {
    const matchId = fixtureUuid("m", this.state.lastSeq + 1);
    this.apply("MatchStarted", {
      matchId,
      courtId: fixtureCourtId(courtNumber),
      teamA,
      teamB,
    });
    return matchId;
  }

  players(): PlayerMetrics[] {
    return playerMetrics(this.state, this.now);
  }

  player(participantId: ParticipantId): PlayerMetrics {
    const metrics = this.players().find(
      (candidate) => candidate.participantId === participantId,
    );
    if (!metrics) throw new Error(`No metrics for ${participantId}`);
    return metrics;
  }

  clock(): SessionClock {
    return sessionClock(this.state, this.now);
  }

  courts(): CourtMetrics[] {
    return courtMetrics(this.state, this.now);
  }

  participantIds(): ParticipantId[] {
    return this.config.participants.map(
      (participant) => participant.participantId,
    );
  }
}
