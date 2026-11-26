import "server-only";
import {
  applyEvent,
  replay,
  sessionError,
  type SessionEvent,
  type SessionState,
} from "@/engine/session";
import type { Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  loadSessionLog,
  PLAYER_ACTOR_PREFIX,
  SYSTEM_ACTOR_ID,
  type DatabaseClient,
} from "./sessionLog";
import type {
  NewSessionAction,
  SubmitSessionActionResult,
} from "./submitSessionAction";

// Log writes with no host behind them (docs/plans/reclub-to-court-v1.md,
// Phase 2): the app preparing, refilling or closing by itself, and a player's
// own action from their phone. Same steps as submitSessionAction: replay,
// duplicate check, sequence check, engine validation, then one Postgres
// function (append_session_event_without_host), which checks again who may
// do what. The caller has already established the session (the host's own
// social, or the check-in tag the player's page showed).

export type NonHostActor =
  { kind: "system" } | { kind: "player"; participantId: string };

export interface NonHostActionInput {
  sessionId: string;
  eventId: string;
  expectedLastSeq: number;
  action: NewSessionAction;
}

/** The log and its replayed state, read with the secret key (no host session). */
export async function loadReplayedState(
  sessionId: string,
  client: DatabaseClient = createSupabaseAdminClient(),
): Promise<{ events: SessionEvent[]; state: SessionState } | null> {
  const log = await loadSessionLog(client, sessionId);
  if (!log) return null;
  const replayed = replay(log.events);
  if (!replayed.ok) {
    throw new Error(
      `Session ${sessionId} log fails to replay at seq ${replayed.failedSeq}: ${replayed.error.code}`,
    );
  }
  return { events: log.events, state: replayed.state };
}

function actorIdOf(actor: NonHostActor): string {
  return actor.kind === "system"
    ? SYSTEM_ACTOR_ID
    : `${PLAYER_ACTOR_PREFIX}${actor.participantId}`;
}

/**
 * Validates and appends one non-host action. A stale sequence comes back as
 * UPDATED_BY_ANOTHER_HOST (the caller re-plans from the new log).
 */
export async function submitNonHostSessionAction(
  input: NonHostActionInput,
  actor: NonHostActor,
  options: {
    now?: () => number;
    loaded?: { events: SessionEvent[]; state: SessionState };
  } = {},
): Promise<SubmitSessionActionResult> {
  const loaded = options.loaded ?? (await loadReplayedState(input.sessionId));
  if (!loaded) throw new Error(`Session ${input.sessionId} not found.`);
  const { events, state } = loaded;
  const landed = events.find((event) => event.eventId === input.eventId);
  if (landed) {
    return landed.type === input.action.type
      ? { ok: true, seq: landed.seq, occurredAt: landed.at, wasDuplicate: true }
      : {
          ok: false,
          reason: "INVALID_ACTION",
          error: sessionError(
            "DUPLICATE_ID",
            `Action id ${input.eventId} was already used for ${landed.type}.`,
          ),
        };
  }
  if (input.expectedLastSeq !== state.lastSeq)
    return { ok: false, reason: "UPDATED_BY_ANOTHER_HOST" };
  const at = Math.max((options.now ?? Date.now)(), state.lastAt ?? 0);
  const event = {
    seq: state.lastSeq + 1,
    eventId: input.eventId,
    at,
    actorId: actorIdOf(actor),
    ...input.action,
  } as SessionEvent;
  const checked = applyEvent(state, event);
  if (!checked.ok)
    return { ok: false, reason: "INVALID_ACTION", error: checked.error };

  const { data, error } = await createSupabaseAdminClient().rpc(
    "append_session_event_without_host",
    {
      p_session_id: input.sessionId,
      p_event_id: input.eventId,
      p_expected_last_seq: input.expectedLastSeq,
      p_type: event.type,
      p_payload: event.payload as unknown as Json,
      p_occurred_at: new Date(at).toISOString(),
      p_actor_session_participant_id:
        actor.kind === "player" ? actor.participantId : undefined,
    },
  );
  if (error) {
    if (error.message === "STALE_EXPECTED_SEQ")
      return { ok: false, reason: "UPDATED_BY_ANOTHER_HOST" };
    throw new Error(
      `Saving ${event.type} to session ${input.sessionId} failed: ${error.message}`,
    );
  }
  const stored = data as { status: string; seq: number; occurred_at: string };
  return {
    ok: true,
    seq: stored.seq,
    occurredAt: Date.parse(stored.occurred_at),
    wasDuplicate: stored.status === "duplicate",
  };
}
