// Whole-session simulator for simulations, calibration and benchmarks. It
// drives the real action log (`applyEvent`) with `recommend`, so every
// suggested match is validated exactly as a host action would be.
// Test support only: not exported from the scheduler's public API.
import {
  applyEvent,
  compensate,
  playerMetrics,
  createInitialSessionState,
  type CourtConfig,
  type CourtFormat,
  type EventMeta,
  type Participant,
  type ParticipantId,
  type PlayerMetrics,
  type RotationPreferences,
  type SessionEvent,
  type SessionEventPayloads,
  type SessionEventType,
  type SessionState,
  type SkillLevel,
} from "../../session";
import {
  PLAYERS_PER_MATCH,
  PLAYERS_PER_TEAM,
  RECOMMENDED_ROTATION_PREFERENCES,
} from "../../session";
import { recommend } from "../recommend";
import { scheduleInputFromSession } from "../scheduleInputFromSession";
import { createSeededRandom } from "../seededRandom";
import type { Recommendation, ScheduleInput } from "../types";
import type { ScoringWeights } from "../weights";

export const SIMULATION_START_AT = Date.UTC(2026, 10, 7, 18, 0, 0);
const MINUTE_MS = 60_000;
const SIMULATION_ACTOR_ID = "00000000-0000-4000-8000-00000000a001";

export const DEFAULT_SIMULATION_PREFERENCES: RotationPreferences =
  RECOMMENDED_ROTATION_PREFERENCES;

/** Who picks the groups: the engine, or uniform random groups (the baseline). */
export type SimulationPolicy = "engine" | "random";

export interface SessionSimulationOptions {
  seed: number;
  courtFormats: CourtFormat[];
  /** Players present when the session starts. */
  initialPlayerCount: number;
  /** Players who check in later, at random times in the first 60% of the session. */
  lateArrivalCount?: number;
  /** Players who leave at a random time (after finishing any match they are in). */
  departureCount?: number;
  /** Chance that a player who left comes back later. */
  rejoinProbability?: number;
  /** Pauses of 3-10 minutes at random times. */
  pauseCount?: number;
  targetMatchMinutes?: number;
  changeoverMinutes?: number;
  durationMinutes?: number;
  /** Match lengths are uniform in target × [1 − v, 1 + v]. */
  matchLengthVariation?: number;
  preferences?: RotationPreferences;
  policy?: SimulationPolicy;
  weights?: ScoringWeights;
  /**
   * Chance, after each match start or completion, of undoing it, recording
   * the derived state before and after (they must be equal), then redoing it.
   */
  undoCheckProbability?: number;
  /**
   * Chance, before each recommendation, of one random host action: lock a
   * player (to a court or any court), skip or un-skip, reorder the queue,
   * close or reopen a court, or shuffle the suggestions.
   */
  hostActionProbability?: number;
  /** Forecast busy courts too (default true). Benchmarks turn it off: the simulator never reads Up next. */
  includeUpNext?: boolean;
  /** Called with every recommendation the simulator acts on. */
  onRecommendation?: (observation: RecommendationObservation) => void;
}

export interface RecommendationObservation {
  at: number;
  input: ScheduleInput;
  recommendation: Recommendation;
}

/** What hosts see, derived from state: used to prove an undo restores it exactly. */
export interface DerivedView {
  players: PlayerMetrics[];
  recommendation: Recommendation;
}

export interface UndoCheck {
  undoneType: SessionEventType;
  before: DerivedView;
  afterUndo: DerivedView;
}

export interface SessionSimulationResult {
  /** The final, ended state (after the last matches finished). */
  state: SessionState;
  /**
   * The state at the planned end, before the overrunning matches finished;
   * measure it at `plannedEndAt` for in-session utilisation.
   */
  stateAtPlannedEnd: SessionState;
  plannedEndAt: number;
  events: SessionEvent[];
  /** Longest single wait seen by any player, in active ms. */
  maxObservedWaitMs: number;
  /** Participant ids of the late arrivals. */
  lateArrivalIds: ParticipantId[];
  undoChecks: UndoCheck[];
}

const SKILLS: Array<SkillLevel | null> = [
  "beginner",
  "intermediate",
  "advanced",
  null,
];

function simulationUuid(kind: number, number: number): string {
  return `0000000${kind}-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
}

function makeParticipant(number: number, random: () => number): Participant {
  return {
    participantId: simulationUuid(1, number),
    firstName: `Player`,
    lastName: `${number}`,
    skill: SKILLS[Math.floor(random() * SKILLS.length)],
    isGuest: false,
  };
}

type Happening =
  | { at: number; kind: "arrival"; participant: Participant }
  | { at: number; kind: "departure"; participantId: ParticipantId }
  | { at: number; kind: "pause"; lengthMs: number };

/** Applies events through `applyEvent`, throwing on any rejection (a broken invariant). */
class SimulatedLog {
  state: SessionState = createInitialSessionState();
  readonly events: SessionEvent[] = [];

  nextMeta(at: number): EventMeta {
    const seq = this.state.lastSeq + 1;
    return {
      seq,
      eventId: simulationUuid(3, seq),
      at,
      actorId: SIMULATION_ACTOR_ID,
    };
  }

  apply<TType extends SessionEventType>(
    at: number,
    type: TType,
    payload: SessionEventPayloads[TType],
  ): SessionEvent {
    const event = { ...this.nextMeta(at), type, payload } as SessionEvent;
    const result = applyEvent(this.state, event);
    if (!result.ok) {
      throw new Error(
        `Simulation: ${type} rejected at seq ${event.seq}: ${result.error.code} ${result.error.message}`,
      );
    }
    this.state = result.state;
    this.events.push(event);
    return event;
  }

  undo(at: number, targetSeq: number): void {
    const result = compensate(this.state, targetSeq, this.nextMeta(at));
    if (!result.ok) {
      throw new Error(
        `Simulation: undo of ${targetSeq} rejected: ${result.error.code} ${result.error.message}`,
      );
    }
    this.state = result.state;
    this.events.push(result.event);
  }
}

/** Uniform random groups on every free court: the baseline the engine is compared to. */
function randomRecommendation(
  input: ScheduleInput,
  random: () => number,
): Recommendation {
  const waiting = input.players
    .filter((player) => player.status === "waiting")
    .map((player) => player.participantId);
  for (let index = waiting.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [waiting[index], waiting[swapIndex]] = [waiting[swapIndex], waiting[index]];
  }
  const readyNow: Recommendation["readyNow"] = [];
  for (const court of input.courts) {
    if (court.currentMatchElapsedMs !== null) continue;
    const seatCount = PLAYERS_PER_MATCH[court.format];
    if (waiting.length < seatCount) break;
    const group = waiting.splice(0, seatCount);
    const teamSize = PLAYERS_PER_TEAM[court.format];
    readyNow.push({
      courtId: court.courtId,
      courtName: court.name,
      format: court.format,
      isReadyNow: true,
      expectedFreeInMs: 0,
      teamA: group.slice(0, teamSize),
      teamB: group.slice(teamSize),
      reasons: [],
      otherFairGroupCount: 0,
    });
  }
  return { readyNow, upNext: [], unfilledCourts: [], waitingQueue: [] };
}

const pick = <TValue>(values: readonly TValue[], random: () => number) =>
  values[Math.floor(random() * values.length)];

/**
 * One random but valid host action, the way a host might use the live
 * screen. Locks never target a closed court, and a court with locks pointing
 * at it is not closed, so every lock can eventually be seated.
 */
function performRandomHostAction(
  log: SimulatedLog,
  at: number,
  random: () => number,
): void {
  const state = log.state;
  const present = Object.values(state.participants).filter(
    (participant) => participant.presence.at(-1)?.to === null,
  );
  const isSkipped = (participant: (typeof present)[number]) =>
    participant.skips.at(-1)?.to === null;
  const waiting = present.filter(
    (participant) =>
      participant.activeMatchId === null && !isSkipped(participant),
  );
  const courts = Object.values(state.courts);
  const isClosed = (court: (typeof courts)[number]) =>
    court.closures.at(-1)?.to === null;
  const openCourts = courts.filter((court) => !isClosed(court));
  const lockedCourtIds = new Set(
    present.map((participant) => participant.lock?.courtId ?? null),
  );
  const action = Math.floor(random() * 6);
  if (action === 0) {
    const unlocked = waiting.filter((participant) => participant.lock === null);
    if (unlocked.length === 0 || openCourts.length === 0) return;
    const participantId = pick(unlocked, random).participant.participantId;
    const court = pick(openCourts, random);
    const lockedToCourt = present.filter(
      (participant) => participant.lock?.courtId === court.court.courtId,
    ).length;
    const toCourt =
      random() < 0.5 && lockedToCourt < PLAYERS_PER_MATCH[court.court.format];
    log.apply(at, "PlayerLocked", {
      participantId,
      ...(toCourt ? { courtId: court.court.courtId } : {}),
    });
  } else if (action === 1) {
    const skippable = waiting.filter(
      (participant) => participant.lock === null,
    );
    if (skippable.length === 0) return;
    log.apply(at, "PlayerSkipped", {
      participantId: pick(skippable, random).participant.participantId,
    });
  } else if (action === 2) {
    const skipped = present.filter(isSkipped);
    if (skipped.length === 0) return;
    log.apply(at, "PlayerUnskipped", {
      targetSeq: pick(skipped, random).skips.at(-1)!.skippedBySeq,
    });
  } else if (action === 3) {
    const order = waiting
      .map((participant) => participant.participant.participantId)
      .sort(() => random() - 0.5)
      .slice(0, 4);
    log.apply(at, "QueueReordered", { participantIds: order });
  } else if (action === 4) {
    const closable = openCourts.filter(
      (court) =>
        court.activeMatchId === null &&
        !lockedCourtIds.has(court.court.courtId) &&
        openCourts.length > 1,
    );
    const closed = courts.filter(isClosed);
    if (closed.length > 0 && (closable.length === 0 || random() < 0.5)) {
      log.apply(at, "CourtReopened", {
        targetSeq: pick(closed, random).closures.at(-1)!.closedBySeq,
      });
    } else if (closable.length > 0) {
      log.apply(at, "CourtClosed", {
        courtId: pick(closable, random).court.courtId,
      });
    }
  } else {
    log.apply(at, "SuggestionsShuffled", {
      seed: Math.floor(random() * 2 ** 31),
    });
  }
}

export function simulateSession(
  options: SessionSimulationOptions,
): SessionSimulationResult {
  const random = createSeededRandom(options.seed);
  const targetMatchMinutes = options.targetMatchMinutes ?? 15;
  const changeoverMinutes = options.changeoverMinutes ?? 2;
  const durationMinutes = options.durationMinutes ?? 120;
  const matchLengthVariation = options.matchLengthVariation ?? 0.2;
  const policy = options.policy ?? "engine";
  const undoCheckProbability = options.undoCheckProbability ?? 0;
  const plannedEndAt = SIMULATION_START_AT + durationMinutes * MINUTE_MS;

  const courts: CourtConfig[] = options.courtFormats.map((format, index) => ({
    courtId: simulationUuid(2, index + 1),
    name: `Court ${index + 1}`,
    format,
  }));
  const initialParticipants = Array.from(
    { length: options.initialPlayerCount },
    (_, index) => makeParticipant(index + 1, random),
  );
  const lateParticipants = Array.from(
    { length: options.lateArrivalCount ?? 0 },
    (_, index) =>
      makeParticipant(options.initialPlayerCount + index + 1, random),
  );

  const happenings: Happening[] = [];
  const randomTimeBetween = (fromFraction: number, toFraction: number) =>
    SIMULATION_START_AT +
    Math.round(
      (fromFraction + random() * (toFraction - fromFraction)) *
        durationMinutes *
        MINUTE_MS,
    );
  const arrivalAt = new Map<ParticipantId, number>();
  for (const participant of lateParticipants) {
    const at = randomTimeBetween(0.02, 0.6);
    arrivalAt.set(participant.participantId, at);
    happenings.push({ at, kind: "arrival", participant });
  }
  const everyone = [...initialParticipants, ...lateParticipants];
  for (let index = 0; index < (options.departureCount ?? 0); index += 1) {
    if (everyone.length === 0) break;
    const participant = everyone[Math.floor(random() * everyone.length)];
    const earliest =
      (arrivalAt.get(participant.participantId) ?? SIMULATION_START_AT) +
      MINUTE_MS;
    const at = Math.max(earliest, randomTimeBetween(0.1, 0.9));
    happenings.push({
      at,
      kind: "departure",
      participantId: participant.participantId,
    });
    if (random() < (options.rejoinProbability ?? 0)) {
      happenings.push({
        at: at + Math.round((5 + random() * 30) * MINUTE_MS),
        kind: "arrival",
        participant,
      });
    }
  }
  for (let index = 0; index < (options.pauseCount ?? 0); index += 1) {
    happenings.push({
      at: randomTimeBetween(0.1, 0.8),
      kind: "pause",
      lengthMs: Math.round((3 + random() * 7) * MINUTE_MS),
    });
  }
  happenings.sort((left, right) => left.at - right.at);

  const log = new SimulatedLog();
  log.apply(SIMULATION_START_AT, "SessionStarted", {
    config: {
      courts,
      targetMatchMinutes,
      changeoverMinutes,
      plannedDurationMinutes: durationMinutes,
      rotation: options.preferences ?? DEFAULT_SIMULATION_PREFERENCES,
      participants: initialParticipants,
    },
    initialAttendeeIds: initialParticipants.map(
      (participant) => participant.participantId,
    ),
  });

  /** matchId → expected end time (wall clock; pauses push it back). */
  const matchEndAt = new Map<string, number>();
  const leavingAfterMatch = new Set<ParticipantId>();
  let maxObservedWaitMs = 0;
  let nextMatchNumber = 1;
  const undoChecks: UndoCheck[] = [];

  const recommendOptions = {
    baseWeights: options.weights,
    includeUpNext: options.includeUpNext ?? true,
  };
  const derivedView = (at: number): DerivedView => ({
    players: playerMetrics(log.state, at),
    recommendation: recommend(
      scheduleInputFromSession(log.state, at),
      recommendOptions,
    ),
  });

  /** Undo the event just applied, record before/after, then redo it. */
  const checkUndo = (
    at: number,
    stateBefore: SessionState,
    redo: () => void,
  ) => {
    if (random() >= undoCheckProbability) return;
    const undone = log.events[log.events.length - 1];
    const before: DerivedView = {
      players: playerMetrics(stateBefore, at),
      recommendation: recommend(
        scheduleInputFromSession(stateBefore, at),
        recommendOptions,
      ),
    };
    log.undo(at, undone.seq);
    undoChecks.push({
      undoneType: undone.type,
      before,
      afterUndo: derivedView(at),
    });
    redo();
  };

  const startMatch = (
    at: number,
    courtId: string,
    teamA: ParticipantId[],
    teamB: ParticipantId[],
  ) => {
    const matchId = simulationUuid(4, nextMatchNumber);
    nextMatchNumber += 1;
    log.apply(at, "MatchStarted", { matchId, courtId, teamA, teamB });
    const lengthFactor =
      1 - matchLengthVariation + random() * 2 * matchLengthVariation;
    matchEndAt.set(
      matchId,
      at + Math.round(targetMatchMinutes * lengthFactor * MINUTE_MS),
    );
    return matchId;
  };

  const fillFreeCourts = (at: number) => {
    if (at >= plannedEndAt || log.state.pausedBySeq !== null) return;
    if (random() < (options.hostActionProbability ?? 0)) {
      performRandomHostAction(log, at, random);
    }
    const input = scheduleInputFromSession(log.state, at);
    for (const player of input.players) {
      maxObservedWaitMs = Math.max(maxObservedWaitMs, player.currentWaitMs);
    }
    const recommendation =
      policy === "engine"
        ? recommend(input, recommendOptions)
        : randomRecommendation(input, random);
    options.onRecommendation?.({ at, input, recommendation });
    for (const suggestion of recommendation.readyNow) {
      const stateBefore = log.state;
      const matchId = startMatch(
        at,
        suggestion.courtId,
        suggestion.teamA,
        suggestion.teamB,
      );
      checkUndo(at, stateBefore, () => {
        const endAt = matchEndAt.get(matchId)!;
        matchEndAt.delete(matchId);
        const redoneId = startMatch(
          at,
          suggestion.courtId,
          suggestion.teamA,
          suggestion.teamB,
        );
        matchEndAt.set(redoneId, endAt);
      });
    }
  };

  const completeMatch = (at: number, matchId: string) => {
    matchEndAt.delete(matchId);
    const stateBefore = log.state;
    log.apply(at, "MatchCompleted", { matchId });
    checkUndo(at, stateBefore, () =>
      log.apply(at, "MatchCompleted", { matchId }),
    );
    const match = log.state.matches[matchId];
    for (const segment of match.segments) {
      if (leavingAfterMatch.delete(segment.participantId)) {
        log.apply(at, "PlayerLeft", { participantId: segment.participantId });
      }
    }
  };

  const handleHappening = (happening: Happening) => {
    const { at } = happening;
    if (happening.kind === "arrival") {
      const existing =
        log.state.participants[happening.participant.participantId];
      const isPresentNow =
        existing !== undefined && existing.presence.at(-1)?.to === null;
      leavingAfterMatch.delete(happening.participant.participantId);
      if (!isPresentNow) {
        log.apply(at, "PlayerJoined", { participant: happening.participant });
      }
      return;
    }
    if (happening.kind === "departure") {
      const participantState = log.state.participants[happening.participantId];
      if (!participantState || participantState.presence.at(-1)?.to !== null) {
        return;
      }
      if (participantState.activeMatchId !== null) {
        leavingAfterMatch.add(happening.participantId);
      } else {
        log.apply(at, "PlayerLeft", { participantId: happening.participantId });
      }
      return;
    }
    log.apply(at, "Paused", {});
    log.apply(at + happening.lengthMs, "Resumed", {});
    for (const [matchId, endAt] of matchEndAt) {
      matchEndAt.set(matchId, endAt + happening.lengthMs);
    }
  };

  fillFreeCourts(SIMULATION_START_AT);
  let happeningIndex = 0;
  let stateAtPlannedEnd: SessionState | null = null;
  for (;;) {
    let nextMatchId: string | null = null;
    let nextMatchAt = Infinity;
    for (const [matchId, endAt] of matchEndAt) {
      if (endAt < nextMatchAt) {
        nextMatchAt = endAt;
        nextMatchId = matchId;
      }
    }
    const nextHappening = happenings[happeningIndex];
    const happeningIsNext =
      nextHappening !== undefined &&
      nextHappening.at < plannedEndAt &&
      nextHappening.at <= nextMatchAt;
    if (happeningIsNext) {
      happeningIndex += 1;
      // Pauses are applied back to back, so they must not land before the last event.
      const at = Math.max(nextHappening.at, log.state.lastAt ?? 0);
      handleHappening({ ...nextHappening, at });
      fillFreeCourts(log.state.lastAt ?? at);
      continue;
    }
    if (nextMatchId === null) break;
    const at = Math.max(nextMatchAt, log.state.lastAt ?? 0);
    if (stateAtPlannedEnd === null && at >= plannedEndAt) {
      stateAtPlannedEnd = log.state;
    }
    completeMatch(at, nextMatchId);
    fillFreeCourts(at);
  }
  stateAtPlannedEnd ??= log.state;
  const endAt = Math.max(plannedEndAt, log.state.lastAt ?? plannedEndAt);
  log.apply(endAt, "SessionEnded", {});

  return {
    state: log.state,
    stateAtPlannedEnd,
    plannedEndAt,
    events: log.events,
    maxObservedWaitMs,
    lateArrivalIds: lateParticipants.map(
      (participant) => participant.participantId,
    ),
    undoChecks,
  };
}
