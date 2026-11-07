// `applyEvent` validates one event against the current state and returns the
// next state; `replay` folds a whole log. Neither throws on invalid input.
import { StateDraft, type EventHandler } from "./draft";
import { sessionError, type SessionError } from "./errors";
import {
  COMPENSATING_EVENT_TYPE,
  compensationTargetSeq,
  isReversibleEventType,
  type SessionEvent,
  type SessionEventType,
} from "./events";
import {
  handleMatchAbandoned,
  handleMatchAbandonReverted,
  handleMatchCompleted,
  handleMatchCompletionReverted,
  handleMatchStarted,
  handleMatchStartReverted,
  handlePlayerRemovalReverted,
  handlePlayerRemovedMidMatch,
  handlePlayerReplaced,
  handlePlayerReplacementReverted,
} from "./matchHandlers";
import {
  handlePlayerJoined,
  handlePlayerJoinReverted,
  handlePlayerLeaveReverted,
  handlePlayerLeft,
  handlePlayerLocked,
  handlePlayerSkipped,
  handlePlayerUnlocked,
  handlePlayerUnskipped,
} from "./playerHandlers";
import {
  handleCourtAdded,
  handleCourtAddReverted,
  handleCourtClosed,
  handleCourtReopened,
  handlePaused,
  handleQueueReordered,
  handleResumed,
  handleSessionEnded,
  handleSessionStarted,
  handleSuggestionsShuffled,
} from "./sessionHandlers";
import {
  createInitialSessionState,
  findHistoryEntry,
  type HistoryEntry,
  type SessionState,
} from "./state";

export type ApplyEventResult =
  { ok: true; state: SessionState } | { ok: false; error: SessionError };

const HANDLERS: { [TType in SessionEventType]: EventHandler<TType> } = {
  SessionStarted: handleSessionStarted,
  PlayerJoined: handlePlayerJoined,
  PlayerJoinReverted: handlePlayerJoinReverted,
  PlayerLeft: handlePlayerLeft,
  PlayerLeaveReverted: handlePlayerLeaveReverted,
  PlayerSkipped: handlePlayerSkipped,
  PlayerUnskipped: handlePlayerUnskipped,
  PlayerLocked: handlePlayerLocked,
  PlayerUnlocked: handlePlayerUnlocked,
  CourtAdded: handleCourtAdded,
  CourtAddReverted: handleCourtAddReverted,
  CourtClosed: handleCourtClosed,
  CourtReopened: handleCourtReopened,
  MatchStarted: handleMatchStarted,
  MatchStartReverted: handleMatchStartReverted,
  MatchCompleted: handleMatchCompleted,
  MatchCompletionReverted: handleMatchCompletionReverted,
  PlayerReplaced: handlePlayerReplaced,
  PlayerReplacementReverted: handlePlayerReplacementReverted,
  PlayerRemovedMidMatch: handlePlayerRemovedMidMatch,
  PlayerRemovalReverted: handlePlayerRemovalReverted,
  MatchAbandoned: handleMatchAbandoned,
  MatchAbandonReverted: handleMatchAbandonReverted,
  QueueReordered: handleQueueReordered,
  SuggestionsShuffled: handleSuggestionsShuffled,
  Paused: handlePaused,
  Resumed: handleResumed,
  SessionEnded: handleSessionEnded,
};

/**
 * Event types rejected while paused, because they would stamp match times
 * inside a pause. Everything else (roster changes, undos, resume, end) is allowed.
 */
const BLOCKED_WHILE_PAUSED: ReadonlySet<SessionEventType> = new Set([
  "MatchStarted",
  "MatchCompleted",
  "PlayerReplaced",
  "PlayerRemovedMidMatch",
  "MatchAbandoned",
]);

function validateEnvelope(
  state: SessionState,
  event: SessionEvent,
): SessionError | null {
  if (
    typeof event !== "object" ||
    event === null ||
    !Object.prototype.hasOwnProperty.call(HANDLERS, event.type) ||
    typeof event.payload !== "object" ||
    event.payload === null
  ) {
    return sessionError("MALFORMED_EVENT", "Unknown event type or no payload.");
  }
  if (!Number.isInteger(event.seq) || event.seq <= state.lastSeq) {
    return sessionError(
      "SEQ_NOT_INCREASING",
      `Seq ${event.seq} must be greater than the last seq ${state.lastSeq}.`,
    );
  }
  if (
    typeof event.at !== "number" ||
    !Number.isFinite(event.at) ||
    (state.lastAt !== null && event.at < state.lastAt)
  ) {
    return sessionError(
      "TIME_WENT_BACKWARDS",
      `Event time ${event.at} is before the previous event time ${state.lastAt}.`,
    );
  }
  if (state.phase === "notStarted" && event.type !== "SessionStarted") {
    return sessionError(
      "SESSION_NOT_STARTED",
      "The session must start before anything else happens.",
    );
  }
  if (state.phase === "live" && event.type === "SessionStarted") {
    return sessionError(
      "SESSION_ALREADY_STARTED",
      "The session has already started.",
    );
  }
  if (state.phase === "ended") {
    return sessionError("SESSION_ENDED", "The session has ended.");
  }
  if (state.pausedBySeq !== null && BLOCKED_WHILE_PAUSED.has(event.type)) {
    return sessionError(
      "SESSION_PAUSED",
      "The session is paused; resume it first.",
    );
  }
  return null;
}

/** Finds and checks the action a compensating event undoes. */
function resolveTarget(
  state: SessionState,
  event: SessionEvent,
  targetSeq: number,
): SessionError | HistoryEntry {
  const target = findHistoryEntry(state, targetSeq);
  if (!target) {
    return sessionError("UNKNOWN_TARGET", `There is no action ${targetSeq}.`);
  }
  if (compensationTargetSeq(target.event) !== null) {
    return sessionError("NOT_REVERSIBLE", "Undo actions can't be undone.");
  }
  const targetType = target.event.type;
  if (
    !isReversibleEventType(targetType) ||
    COMPENSATING_EVENT_TYPE[targetType] !== event.type
  ) {
    return sessionError(
      "TARGET_MISMATCH",
      `${event.type} can't undo action ${targetSeq} (${targetType}).`,
    );
  }
  if (target.compensatedBySeq !== null) {
    return sessionError(
      "ALREADY_COMPENSATED",
      `Action ${targetSeq} was already undone by action ${target.compensatedBySeq}.`,
    );
  }
  return target;
}

function applyValidEnvelope(
  state: SessionState,
  event: SessionEvent,
): ApplyEventResult {
  const targetSeq = compensationTargetSeq(event);
  let target: HistoryEntry | null = null;
  if (targetSeq !== null) {
    const resolved = resolveTarget(state, event, targetSeq);
    if ("code" in resolved) return { ok: false, error: resolved };
    target = resolved;
  } else if ("targetSeq" in event.payload) {
    return {
      ok: false,
      error: sessionError("MALFORMED_EVENT", "targetSeq must be a number."),
    };
  }

  const draft = new StateDraft(state);
  // The handler map pairs each type with its handler, which TS can't see through the union.
  const handler = HANDLERS[event.type] as EventHandler<SessionEventType>;
  if (target === null && isPureCompensation(event.type)) {
    return {
      ok: false,
      error: sessionError(
        "MALFORMED_EVENT",
        `${event.type} needs a targetSeq.`,
      ),
    };
  }
  const handlerError = handler(draft, event, target as HistoryEntry);
  if (handlerError) return { ok: false, error: handlerError };

  const next = draft.next;
  next.lastSeq = event.seq;
  next.lastAt = event.at;
  next.history = [
    ...state.history,
    { event, compensatedBySeq: null, before: draft.before },
  ];
  if (target) {
    const targetIndex = next.history.indexOf(target);
    next.history[targetIndex] = { ...target, compensatedBySeq: event.seq };
  }
  return { ok: true, state: next };
}

const PURE_COMPENSATION_TYPES: ReadonlySet<SessionEventType> = new Set(
  Object.values(COMPENSATING_EVENT_TYPE).filter(
    (type) => !isReversibleEventType(type),
  ),
);

function isPureCompensation(type: SessionEventType): boolean {
  return PURE_COMPENSATION_TYPES.has(type);
}

/**
 * Validates `event` against `state` and returns the next state, or the reason
 * it is rejected. Never mutates `state` and never throws for invalid input.
 */
export function applyEvent(
  state: SessionState,
  event: SessionEvent,
): ApplyEventResult {
  const envelopeError = validateEnvelope(state, event);
  if (envelopeError) return { ok: false, error: envelopeError };
  try {
    return applyValidEnvelope(state, event);
  } catch (unexpected) {
    // Only structurally broken payloads (e.g. a missing field in a DB row) reach here.
    return {
      ok: false,
      error: sessionError(
        "MALFORMED_EVENT",
        `Event ${event.seq} (${event.type}) could not be applied: ${unexpected instanceof Error ? unexpected.message : String(unexpected)}`,
      ),
    };
  }
}

export type ReplayResult =
  | { ok: true; state: SessionState }
  | {
      ok: false;
      error: SessionError;
      /** Seq of the first rejected event. */
      failedSeq: number;
      /** The state just before the rejected event. */
      state: SessionState;
    };

/** Folds a log from the initial state; stops at and reports the first rejected event. */
export function replay(events: readonly SessionEvent[]): ReplayResult {
  let state = createInitialSessionState();
  for (const event of events) {
    const result = applyEvent(state, event);
    if (!result.ok) {
      return { ok: false, error: result.error, failedSeq: event.seq, state };
    }
    state = result.state;
  }
  return { ok: true, state };
}
