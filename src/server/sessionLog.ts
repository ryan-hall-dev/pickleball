import { PLAYER_ACTOR_PREFIX, SYSTEM_ACTOR_ID } from "./actorIds";
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionEvent, SessionEventType } from "@/engine/session";
import type { Database } from "@/lib/database.types";

/** A Supabase client typed with the generated schema, acting as the signed-in host. */
export type DatabaseClient = SupabaseClient<Database>;

export type SessionStatus = Database["public"]["Enums"]["session_status"];

export interface LoadedSessionLog {
  sessionId: string;
  status: SessionStatus;
  /** Every event in seq order, as the engine expects them. */
  events: SessionEvent[];
}

// PostgREST returns at most `max_rows` (supabase/config.toml) rows per request.
const EVENTS_PAGE_SIZE = 1000;

type SessionEventRow = Pick<
  Database["public"]["Tables"]["session_events"]["Row"],
  | "seq"
  | "event_id"
  | "type"
  | "payload"
  | "occurred_at"
  | "actor_user_id"
  | "actor_session_participant_id"
>;

export { PLAYER_ACTOR_PREFIX, SYSTEM_ACTOR_ID };

function actorIdFromRow(row: SessionEventRow): string {
  if (row.actor_user_id) return row.actor_user_id;
  if (row.actor_session_participant_id) {
    return `${PLAYER_ACTOR_PREFIX}${row.actor_session_participant_id}`;
  }
  // The database allows no person only for the app's own preparation.
  return SYSTEM_ACTOR_ID;
}

function sessionEventFromRow(row: SessionEventRow): SessionEvent {
  // Typed assignment: fails to compile if the database enum and the engine's
  // event types ever drift apart (the reverse direction is checked where
  // events are written).
  const type: SessionEventType = row.type;
  // The payload was validated by the engine before it was stored; replay re-checks it.
  return {
    seq: row.seq,
    eventId: row.event_id,
    at: Date.parse(row.occurred_at),
    actorId: actorIdFromRow(row),
    type,
    payload: row.payload,
  } as SessionEvent;
}

/**
 * Loads a session's status and its whole action log (paged, in seq order).
 * Returns null when the session doesn't exist, belongs to another social or
 * the caller isn't a host (RLS: a host reads only their own social's sessions
 * and their logs).
 */
export async function loadSessionLog(
  client: DatabaseClient,
  sessionId: string,
  /** Only events after this seq (the log is append-only; see nonHostSessionAction). */
  afterSeq = 0,
): Promise<LoadedSessionLog | null> {
  const { data: session, error: sessionError } = await client
    .from("sessions")
    .select("id, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) {
    throw new Error(
      `Loading session ${sessionId} failed: ${sessionError.message}`,
    );
  }
  if (!session) return null;

  const events: SessionEvent[] = [];
  for (let offset = 0; ; offset += EVENTS_PAGE_SIZE) {
    const { data: rows, error: eventsError } = await client
      .from("session_events")
      .select(
        "seq, event_id, type, payload, occurred_at, actor_user_id, actor_session_participant_id",
      )
      .eq("session_id", sessionId)
      .gt("seq", afterSeq)
      .order("seq", { ascending: true })
      .range(offset, offset + EVENTS_PAGE_SIZE - 1);
    if (eventsError) {
      throw new Error(
        `Loading the action log of session ${sessionId} failed: ${eventsError.message}`,
      );
    }
    events.push(...rows.map(sessionEventFromRow));
    if (rows.length < EVENTS_PAGE_SIZE) break;
  }
  return { sessionId: session.id, status: session.status, events };
}
