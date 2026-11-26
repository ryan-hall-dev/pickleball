import "server-only";
import { z } from "zod";
import {
  applyEvent,
  COMPENSATING_EVENT_TYPE,
  compensate,
  compensationTargetSeq,
  findHistoryEntry,
  isReversibleEventType,
  isSimpleSocial,
  matchRecords,
  replay,
  sessionError,
  type EventMeta,
  type MatchRecord,
  type SessionError,
  type SessionEvent,
  type SessionEventPayloads,
  type SessionEventType,
  type SessionState,
} from "@/engine/session";
import type { Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadSessionLog, type DatabaseClient } from "./sessionLog";

/** One host action, before the server stamps its seq, time and actor. */
export type NewSessionAction = {
  [TType in SessionEventType]: {
    type: TType;
    payload: SessionEventPayloads[TType];
  };
}[SessionEventType];

export interface SubmitSessionActionInput {
  sessionId: string;
  /** Client-generated UUID, reused on retry so a repeat returns the original result. */
  eventId: string;
  /** The session's last seq the host's screen was showing (0 before the start). */
  expectedLastSeq: number;
  expectedDraftRevision?: number;
  request:
    | { kind: "action"; action: NewSessionAction }
    /**
     * Undo appends the compensating action for `targetSeq`. To undo one of the
     * matches started with the session, pass the SessionStarted seq and that
     * match's `matchId`.
     */
    | { kind: "undo"; targetSeq: number; matchId?: string };
}

export type SubmitSessionActionResult =
  | {
      ok: true;
      seq: number;
      /** Server time of the stored event, epoch ms. */
      occurredAt: number;
      /** True when `eventId` had already landed (a double click or a retry). */
      wasDuplicate: boolean;
    }
  /** Another host acted first: reload the log and show "Updated by another host". */
  | { ok: false; reason: "UPDATED_BY_ANOTHER_HOST" }
  /** The engine (or input validation) rejected the action; `error.message` is host-readable. */
  | { ok: false; reason: "INVALID_ACTION"; error: SessionError };

export interface SubmitSessionActionOptions {
  /**
   * Secret-key client used ONLY for the write (docs/decisions/0002-server-only-writes.md).
   * Defaults to createSupabaseAdminClient(); injected by tests.
   */
  serviceRoleClient?: DatabaseClient;
  /** Server clock, epoch ms. Injected by tests. */
  now?: () => number;
}

const submitInputSchema = z.object({
  sessionId: z.uuid(),
  eventId: z.uuid(),
  expectedLastSeq: z.int().nonnegative(),
  expectedDraftRevision: z.int().nonnegative().optional(),
  request: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("action"),
      action: z.object({
        type: z.string(),
        payload: z.record(z.string(), z.unknown()),
      }),
    }),
    z.object({
      kind: z.literal("undo"),
      targetSeq: z.int().positive(),
      matchId: z.uuid().optional(),
    }),
  ]),
});

const functionResultSchema = z.object({
  status: z.enum(["appended", "duplicate"]),
  seq: z.int().positive(),
  occurred_at: z.string(),
});

/** Postgres function error that means another host appended first. */
const STALE_EXPECTED_SEQ = "STALE_EXPECTED_SEQ";

type EngineOutcome =
  | { ok: true; event: SessionEvent; state: SessionState }
  | { ok: false; error: SessionError };

function runEngine(
  state: SessionState,
  request: SubmitSessionActionInput["request"],
  meta: EventMeta,
): EngineOutcome {
  if (request.kind === "undo") {
    return compensate(state, request.targetSeq, meta, request.matchId);
  }
  // The engine validates the payload of every event type.
  const event = { ...meta, ...request.action } as SessionEvent;
  const result = applyEvent(state, event);
  return result.ok ? { ok: true, event, state: result.state } : result;
}

/**
 * The `matches` row the event writes, if any: the one match whose
 * `matchesRowStatus` the event changed (a completion, an abandonment or an undo
 * of one). The database refuses a row for any other event type.
 */
function changedMatchRow(
  before: SessionState,
  after: SessionState,
  at: number,
): Json | null {
  const statusBefore = new Map(
    matchRecords(before, at).map((record) => [
      record.matchId,
      record.matchesRowStatus,
    ]),
  );
  const changed = matchRecords(after, at).filter(
    (record) =>
      record.matchesRowStatus !== null &&
      record.matchesRowStatus !== statusBefore.get(record.matchId),
  );
  if (changed.length > 1) {
    throw new Error(
      `One action changed ${changed.length} matches rows; the log writes at most one per action.`,
    );
  }
  return changed.length === 1 ? matchRowJson(changed[0]) : null;
}

function matchRowJson(record: MatchRecord): Json {
  return {
    id: record.matchId,
    court_id: record.courtId,
    court_name: record.courtName,
    team_a: record.teamA,
    team_b: record.teamB,
    started_at: new Date(record.startedAt).toISOString(),
    ended_at:
      record.endedAt === null ? null : new Date(record.endedAt).toISOString(),
    duration_seconds: Math.round(record.activeDurationMs / 1000),
    status: record.matchesRowStatus,
  };
}

/** Writes the validated event through the one Postgres function for its type. */
async function persistEvent(
  serviceRoleClient: DatabaseClient,
  actorUserId: string,
  sessionId: string,
  expectedLastSeq: number,
  event: SessionEvent,
  matchRow: Json | null,
  expectedDraftRevision?: number,
) {
  const occurredAt = new Date(event.at).toISOString();
  // Engine payloads are plain JSON objects; interfaces just lack Json's index signature.
  const payload = event.payload as unknown as Json;
  switch (event.type) {
    case "SessionStarted":
      return serviceRoleClient.rpc("start_session", {
        p_actor_user_id: actorUserId,
        p_session_id: sessionId,
        p_event_id: event.eventId,
        p_occurred_at: occurredAt,
        p_payload: payload,
        ...(isSimpleSocial(event.payload.config)
          ? { p_expected_draft_revision: expectedDraftRevision }
          : {}),
      });
    case "SessionEnded":
      return serviceRoleClient.rpc("end_session", {
        p_actor_user_id: actorUserId,
        p_session_id: sessionId,
        p_event_id: event.eventId,
        p_expected_last_seq: expectedLastSeq,
        p_occurred_at: occurredAt,
      });
    default:
      return serviceRoleClient.rpc("append_session_event", {
        p_actor_user_id: actorUserId,
        p_session_id: sessionId,
        p_event_id: event.eventId,
        p_expected_last_seq: expectedLastSeq,
        // Engine -> database direction of the event type sync check.
        p_type: event.type,
        p_payload: payload,
        p_occurred_at: occurredAt,
        p_match_row: matchRow ?? undefined,
      });
  }
}

/** The signed-in user, verified with the Auth server (not just decoded from the cookie). */
async function requireVerifiedUserId(
  userClient: DatabaseClient,
): Promise<string> {
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) {
    throw new Error(
      `A signed-in host is required to change a session${error ? `: ${error.message}` : "."}`,
    );
  }
  return data.user.id;
}

/** The event type a request produces: the action's type, or the target's compensating type. */
function requestedEventType(
  state: SessionState,
  request: SubmitSessionActionInput["request"],
): SessionEventType | null {
  if (request.kind === "action") return request.action.type;
  const target = findHistoryEntry(state, request.targetSeq);
  if (!target) return null;
  // One of the session's first matches is undone against the SessionStarted seq.
  if (target.event.type === "SessionStarted" && request.matchId !== undefined) {
    return "MatchStartReverted";
  }
  return isReversibleEventType(target.event.type)
    ? COMPENSATING_EVENT_TYPE[target.event.type]
    : null;
}

/** Whether an event that already landed with this eventId is the same request (a retry). */
function isSameRequest(
  landed: SessionEvent,
  state: SessionState,
  request: SubmitSessionActionInput["request"],
): boolean {
  if (landed.type !== requestedEventType(state, request)) return false;
  if (request.kind === "action") return true;
  const landedMatchId = (landed.payload as { matchId?: string }).matchId;
  return (
    compensationTargetSeq(landed) === request.targetSeq &&
    landedMatchId === request.matchId
  );
}

/**
 * Validates one host action against the replayed log with the engine, then
 * appends it in one Postgres transaction. Every action carries a client
 * `eventId` (idempotency) and the `expectedLastSeq` the host was looking at.
 *
 * `userClient` is the signed-in host's cookie client: it identifies the actor
 * and reads the log under RLS, so only a session of the host's own social is
 * found. The write goes through the service-role client with that verified
 * actor id; the database derives the actor's social from `hosts` and refuses
 * another social's session (SESSION_NOT_FOUND). Any host of the social may act.
 *
 * Expected outcomes are returned (duplicate, conflict, rejected action);
 * anything else (not a host, unknown session, corrupt log, database failure)
 * throws with context.
 */
export async function submitSessionAction(
  userClient: DatabaseClient,
  input: SubmitSessionActionInput,
  options: SubmitSessionActionOptions = {},
): Promise<SubmitSessionActionResult> {
  const parsed = submitInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "INVALID_ACTION",
      error: sessionError("MALFORMED_EVENT", z.prettifyError(parsed.error)),
    };
  }
  const { sessionId, eventId, expectedLastSeq, request } = input;
  const actorId = await requireVerifiedUserId(userClient);

  const log = await loadSessionLog(userClient, sessionId);
  if (!log) {
    throw new Error(
      `Session ${sessionId} not found (or it isn't your social's, or you are not a host).`,
    );
  }
  const replayed = replay(log.events);
  if (!replayed.ok) {
    throw new Error(
      `Session ${sessionId} log fails to replay at seq ${replayed.failedSeq}: ${replayed.error.code} ${replayed.error.message}`,
    );
  }
  const state = replayed.state;

  // Same order as the database: a retry of an action that already landed
  // returns its original result instead of a false conflict or rejection.
  const landed = log.events.find((event) => event.eventId === eventId);
  if (landed) {
    if (!isSameRequest(landed, state, request)) {
      return {
        ok: false,
        reason: "INVALID_ACTION",
        error: sessionError(
          "DUPLICATE_ID",
          `Action id ${eventId} was already used for a different action (${landed.type}); send a new id.`,
        ),
      };
    }
    return {
      ok: true,
      seq: landed.seq,
      occurredAt: landed.at,
      wasDuplicate: true,
    };
  }
  if (expectedLastSeq !== state.lastSeq) {
    return { ok: false, reason: "UPDATED_BY_ANOTHER_HOST" };
  }

  const now = options.now ?? Date.now;
  // Server clocks can differ slightly; the log's time must never go backwards.
  const at = Math.max(now(), state.lastAt ?? 0);
  const outcome = runEngine(state, request, {
    seq: state.lastSeq + 1,
    eventId,
    at,
    actorId,
  });
  if (!outcome.ok) {
    return { ok: false, reason: "INVALID_ACTION", error: outcome.error };
  }

  const matchRow = changedMatchRow(state, outcome.state, at);
  const { data, error } = await persistEvent(
    options.serviceRoleClient ?? createSupabaseAdminClient(),
    actorId,
    sessionId,
    expectedLastSeq,
    outcome.event,
    matchRow,
    input.expectedDraftRevision,
  );
  if (error) {
    if (
      error.message === STALE_EXPECTED_SEQ ||
      error.message === "DRAFT_CHANGED_ELSEWHERE" ||
      error.message === "STALE_DRAFT_ROSTER"
    ) {
      return { ok: false, reason: "UPDATED_BY_ANOTHER_HOST" };
    }
    throw new Error(
      `Saving ${outcome.event.type} to session ${sessionId} failed: ${error.message}${error.details ? ` (${error.details})` : ""}`,
    );
  }
  const stored = functionResultSchema.parse(data);
  return {
    ok: true,
    seq: stored.seq,
    occurredAt: Date.parse(stored.occurred_at),
    wasDuplicate: stored.status === "duplicate",
  };
}
