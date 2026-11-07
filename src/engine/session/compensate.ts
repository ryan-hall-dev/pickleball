// Undo: build the compensating event for one earlier action.
import { applyEvent } from "./applyEvent";
import { restorableQueueOrder } from "./sessionHandlers";
import { sessionError, type SessionError } from "./errors";
import {
  COMPENSATING_EVENT_TYPE,
  compensationTargetSeq,
  isReversibleEventType,
  type EventMeta,
  type SessionEvent,
} from "./events";
import {
  findHistoryEntry,
  type HistoryEntry,
  type SessionState,
} from "./state";

export type CompensateResult =
  | {
      ok: true;
      /** The compensating event to append to the log. */
      event: SessionEvent;
      /** The state after applying it. */
      state: SessionState;
    }
  | { ok: false; error: SessionError };

function buildCompensatingEvent(
  state: SessionState,
  target: HistoryEntry,
  meta: EventMeta,
): SessionEvent | SessionError {
  const targetEvent = target.event;
  if (!isReversibleEventType(targetEvent.type)) {
    return sessionError(
      "NOT_REVERSIBLE",
      `${targetEvent.type} can't be undone.`,
    );
  }
  if (compensationTargetSeq(targetEvent) !== null) {
    return sessionError("NOT_REVERSIBLE", "Undo actions can't be undone.");
  }
  const targetSeq = targetEvent.seq;
  switch (targetEvent.type) {
    // Manual ranks are a host preference, not fairness data. An undone
    // reorder brings back the previous order minus players who have started a
    // match since (a rank lasts until they next start one) and anyone no longer
    // in the session. An undone match start re-inserts the ranks it cleared,
    // even into a newer order (see handleMatchStartReverted). Undoing the
    // latest action is always an exact restore.
    case "QueueReordered":
      return {
        ...meta,
        type: "QueueReordered",
        payload: {
          participantIds: restorableQueueOrder(state, target),
          targetSeq,
        },
      };
    case "SuggestionsShuffled":
      return {
        ...meta,
        type: "SuggestionsShuffled",
        payload: { seed: target.before.suggestionSeed ?? 0, targetSeq },
      };
    default:
      return {
        ...meta,
        type: COMPENSATING_EVENT_TYPE[targetEvent.type],
        payload: { targetSeq },
      } as SessionEvent;
  }
}

/**
 * Builds the event that undoes action `targetSeq` and checks it with
 * `applyEvent` against the current state. Any earlier action can be undone,
 * not only the newest, as long as it is reversible, not already undone, and
 * nothing later depends on it (the error says what to undo first).
 */
export function compensate(
  state: SessionState,
  targetSeq: number,
  meta: EventMeta,
): CompensateResult {
  const target = findHistoryEntry(state, targetSeq);
  if (!target) {
    return {
      ok: false,
      error: sessionError("UNKNOWN_TARGET", `There is no action ${targetSeq}.`),
    };
  }
  const built = buildCompensatingEvent(state, target, meta);
  if ("code" in built) return { ok: false, error: built };
  const result = applyEvent(state, built);
  if (!result.ok) return result;
  return { ok: true, event: built, state: result.state };
}
