// `applyEvent` validates one event against the current state and returns the
// next state; `replay` folds a whole log. Neither throws on invalid input.
import { StateDraft, type EventHandler } from "./draft";
import {
  handleNextGroupCalled,
  handleNextGroupChanged,
  handleNextGroupMoved,
  handleNextGroupReleased,
  handleNextGroupSeatConfirmed,
} from "./calledGroupHandlers";
import { isSimpleSocial, simpleSessionTimeIsUp } from "./simplePolicy";
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
  handleCourtCloseCancelled,
  handleCourtCloseScheduled,
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
  findHistoryIndex,
  type HistoryEntry,
  type SessionState,
} from "./state";

export type ApplyEventResult =
  { ok: true; state: SessionState } | { ok: false; error: SessionError };

const HANDLERS: { [TType in SessionEventType]: EventHandler<TType> } = {
  NextGroupCalled: handleNextGroupCalled,
  NextGroupChanged: handleNextGroupChanged,
  NextGroupReleased: handleNextGroupReleased,
  NextGroupSeatConfirmed: handleNextGroupSeatConfirmed,
  NextGroupMoved: handleNextGroupMoved,
  CourtCloseScheduled: handleCourtCloseScheduled,
  CourtCloseCancelled: handleCourtCloseCancelled,
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
const LEGACY_ONLY_CONTROLS: ReadonlySet<SessionEventType> = new Set([
  "Paused",
  "Resumed",
  "SuggestionsShuffled",
  "QueueReordered",
  "PlayerLocked",
  "PlayerUnlocked",
  "PlayerRemovedMidMatch",
  "PlayerRemovalReverted",
  "PlayerReplacementReverted",
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
  if (isSimpleSocial(state.config) && LEGACY_ONLY_CONTROLS.has(event.type)) {
    return sessionError(
      "POLICY_ACTION_NOT_ALLOWED",
      "This control is not part of a simple social.",
    );
  }
  if (
    event.type === "NextGroupCalled" ||
    event.type === "NextGroupChanged" ||
    event.type === "NextGroupReleased" ||
    event.type === "NextGroupSeatConfirmed" ||
    event.type === "NextGroupMoved"
  ) {
    if (!isSimpleSocial(state.config)) {
      return sessionError(
        "INVALID_CONFIG",
        "Called groups require the simple-social policy.",
      );
    }
    if (
      (event.type === "NextGroupCalled" || event.type === "NextGroupChanged") &&
      simpleSessionTimeIsUp(state, event.at)
    ) {
      return sessionError(
        "SESSION_TIME_UP",
        "Session time is up; no new groups can be called.",
      );
    }
  }
  if (state.pausedBySeq !== null && BLOCKED_WHILE_PAUSED.has(event.type)) {
    return sessionError(
      "SESSION_PAUSED",
      "The session is paused; resume it first.",
    );
  }
  return null;
}

/** An undo of one match started with the session; the SessionStarted itself stays in force. */
function isInitialMatchUndo(
  event: SessionEvent,
  target: HistoryEntry,
): boolean {
  return (
    event.type === "MatchStartReverted" &&
    target.event.type === "SessionStarted"
  );
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
    !isInitialMatchUndo(event, target) &&
    (!isReversibleEventType(targetType) ||
      COMPENSATING_EVENT_TYPE[targetType] !== event.type)
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
  writeInPlace: boolean,
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

  const draft = new StateDraft(state, writeInPlace);
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
  const entry: HistoryEntry = {
    event,
    compensatedBySeq: null,
    before: draft.before,
  };
  next.history = writeInPlace ? state.history : [...state.history];
  if (target && !isInitialMatchUndo(event, target)) {
    const targetIndex = findHistoryIndex(next, target.event.seq);
    next.history[targetIndex] = { ...target, compensatedBySeq: event.seq };
  }
  next.history.push(entry);
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
  return applyEventWithMode(state, event, false);
}

/**
 * `writeInPlace` (replay only) may modify `state`'s collections and history,
 * even when the event is then rejected, so the caller must own `state` and
 * throw it away afterwards.
 */
function applyEventWithMode(
  state: SessionState,
  event: SessionEvent,
  writeInPlace: boolean,
): ApplyEventResult {
  const envelopeError = validateEnvelope(state, event);
  if (envelopeError) return { ok: false, error: envelopeError };
  try {
    return applyValidEnvelope(state, event, writeInPlace);
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

/**
 * Folds a log from the initial state; stops at and reports the first rejected
 * event. Same result as calling `applyEvent` event by event, but it writes into
 * one private state so a 1,000-action log replays in a few milliseconds.
 */
export function replay(events: readonly SessionEvent[]): ReplayResult {
  let state = createInitialSessionState();
  for (const event of events) {
    const result = applyEventWithMode(state, event, true);
    if (!result.ok) {
      // A rejected handler may have half-written the private state, so rebuild
      // the exact state before the rejected event the safe way (rare path).
      return replayCopyOnWrite(events);
    }
    state = result.state;
  }
  return { ok: true, state };
}

function replayCopyOnWrite(events: readonly SessionEvent[]): ReplayResult {
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
