// Copy-on-write working copy used while applying one event, so `applyEvent`
// never mutates its input and only copies the collections an event touches.
import type { SessionError } from "./errors";
import type {
  SessionEvent,
  SessionEventOf,
  SessionEventPayloads,
  SessionEventType,
} from "./events";
import {
  participantName,
  type HistoryBefore,
  type HistoryEntry,
  type SessionState,
} from "./state";

type CollectionKey = "participants" | "courts" | "matches";
type CollectionValue<TKey extends CollectionKey> =
  SessionState[TKey][keyof SessionState[TKey]];

export class StateDraft {
  readonly next: SessionState;
  /** What the event replaced, stored on its history entry for a later undo. */
  before: HistoryBefore = {};
  private readonly copiedCollections = new Set<CollectionKey>();

  constructor(base: SessionState) {
    this.next = { ...base };
  }

  set<TKey extends CollectionKey>(
    key: TKey,
    id: string,
    value: CollectionValue<TKey>,
  ): void {
    (this.writable(key) as Record<string, CollectionValue<TKey>>)[id] = value;
  }

  remove(key: CollectionKey, id: string): void {
    delete (this.writable(key) as Record<string, unknown>)[id];
  }

  /** "Grace Kim", or the id when unknown, for error messages. */
  participantLabel(participantId: string): string {
    const participantState = this.next.participants[participantId];
    return participantState
      ? participantName(participantState.participant)
      : `participant ${participantId}`;
  }

  courtLabel(courtId: string): string {
    return this.next.courts[courtId]?.court.name ?? `court ${courtId}`;
  }

  private writable<TKey extends CollectionKey>(key: TKey): SessionState[TKey] {
    if (!this.copiedCollections.has(key)) {
      this.next[key] = { ...this.next[key] };
      this.copiedCollections.add(key);
    }
    return this.next[key];
  }
}

/** Compensating types whose payload is only `{ targetSeq }`. */
export type PureCompensationType = {
  [TType in SessionEventType]: SessionEventPayloads[TType] extends {
    targetSeq: number;
  }
    ? TType
    : never;
}[SessionEventType];

/** Validates the event against `draft.next`, then writes its effects; returns an error instead of writing when invalid. */
export type EventHandler<TType extends SessionEventType> = (
  draft: StateDraft,
  event: SessionEventOf<TType>,
  target: TType extends PureCompensationType
    ? HistoryEntry
    : HistoryEntry | null,
) => SessionError | null;

/** Narrows a target entry's event; the dispatcher has already checked the type pairing. */
export function targetEvent<TType extends SessionEventType>(
  target: HistoryEntry,
  type: TType,
): SessionEventOf<TType> {
  if (target.event.type !== type) {
    throw new Error(
      `Target seq ${target.event.seq} is ${target.event.type}, expected ${type}`,
    );
  }
  return target.event as SessionEvent as SessionEventOf<TType>;
}
