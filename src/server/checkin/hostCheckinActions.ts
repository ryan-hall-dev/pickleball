"use server";

import { genderSchema } from "@/server/participantRules";
import { applyEvent, replay } from "@/engine/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadSessionLog } from "@/server/sessionLog";
import { onlyNonHostsActedSince } from "@/server/live/hostTapStillApplies";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import type { SignedInHost } from "@/server/auth/hostAccess";
import {
  DRAFT_PARTICIPANT_COLUMNS,
  draftParticipantFromRow,
  type DraftParticipant,
} from "@/server/setup/setupDraft";
import { checkinDatabaseTimeoutSignal } from "./checkinPage";
import {
  approvedCheckinFromRpc,
  hostCheckinRefusalFromError,
  pendingCheckinRequestsFromRpc,
  type HostCheckinDecisionResult,
  type ListPendingCheckinsResult,
  wasRejectedBeforeFromRpc,
} from "./hostCheckinResults";

// The host pending check-in tray's server actions (Setup screen; M7 reuses
// them on Live). Each verifies the caller as a host of a social with
// getUser() first, then calls a service_role check-in function with
// p_actor_user_id (decision 0002). The functions derive the social from the
// actor, so no social id is ever passed: a request of another social is
// "not found". Draft approval needs no event; live approval needs client
// event metadata and engine prevalidation before the atomic database write.

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

const checkinRequestIdSchema = z.uuid();

/** Logs a failed tray call with ids only (no names or other personal data). */
function logHostCheckinFailure(
  label: string,
  host: SignedInHost,
  error: unknown,
) {
  console.error(label, {
    actorUserId: host.userId,
    cause: error instanceof Error ? error.message : String(error),
  });
}

/**
 * The pending requests of the social's open session, oldest first, each
 * flagged when its name is already in the session. Polled every 5 s.
 */
export async function listPendingCheckins(): Promise<ListPendingCheckinsResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) return { ok: false };
  const { host } = authorization;
  try {
    const { data, error } = await createSupabaseAdminClient()
      .rpc("list_checkin_requests_for_open_session", {
        p_actor_user_id: host.userId,
      })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) {
      throw new Error(
        `list_checkin_requests_for_open_session failed: ${error.message}`,
      );
    }
    return { ok: true, requests: pendingCheckinRequestsFromRpc(data) };
  } catch (error) {
    logHostCheckinFailure("Listing pending check-ins failed", host, error);
    return { ok: false };
  }
}

/**
 * Runs one decision function for the signed-in host. `decide` returns the
 * success result from the function's data, or throws; refusals the tray
 * answers come back as their kind, anything else as `failed`.
 */
async function decideCheckin(
  checkinRequestId: unknown,
  failureLabel: string,
  decide: (
    adminClient: AdminClient,
    host: SignedInHost,
    checkinRequestId: string,
  ) => Promise<HostCheckinDecisionResult>,
): Promise<HostCheckinDecisionResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) return { kind: "failed" };
  const { host } = authorization;
  const parsedRequestId = checkinRequestIdSchema.safeParse(checkinRequestId);
  if (!parsedRequestId.success) return { kind: "failed" };
  try {
    return await decide(
      createSupabaseAdminClient(),
      host,
      parsedRequestId.data,
    );
  } catch (error) {
    logHostCheckinFailure(failureLabel, host, error);
    return { kind: "failed" };
  }
}

/** A function error: the refusal it means, or a thrown failure. */
function refusalOrThrow(
  functionName: string,
  error: { message: string },
): HostCheckinDecisionResult {
  const refusal = hostCheckinRefusalFromError(error);
  if (refusal) return { kind: refusal };
  throw new Error(`${functionName} failed: ${error.message}`);
}

/**
 * Approves a request into the social's draft: a new attendee with the
 * request's name and level (one transaction, approve_checkin). The attendee
 * id is made here. Approving again after a lost answer returns the same
 * attendee; a request another host approved first is already_decided. A
 * name already in the session is refused (name_already_in_session) and the
 * request stays pending.
 */
export async function approveCheckin(
  checkinRequestId: unknown,
  missingGender?: unknown,
  liveMetadata?: { eventId: string; expectedLastSeq: number },
): Promise<HostCheckinDecisionResult> {
  const parsedGender = genderSchema.optional().safeParse(missingGender);
  if (!parsedGender.success) return { kind: "failed" };
  const parsedLive = z
    .object({
      eventId: z.uuid(),
      expectedLastSeq: z.number().int().nonnegative(),
    })
    .optional()
    .safeParse(liveMetadata);
  if (!parsedLive.success) return { kind: "failed" };
  return decideCheckin(
    checkinRequestId,
    "Approving a check-in failed",
    async (adminClient, host, requestId) => {
      const { data: request, error: requestError } = await adminClient
        .from("checkin_requests")
        .select(
          "session_id, first_name, last_name, skill_level, gender, status",
        )
        .eq("social_id", host.socialId)
        .eq("id", requestId)
        .abortSignal(checkinDatabaseTimeoutSignal())
        .maybeSingle();
      if (requestError)
        throw new Error(`Reading check-in failed: ${requestError.message}`);
      if (!request) return { kind: "already_decided" };
      const participantId = randomUUID();
      const { data: session, error: sessionError } = await adminClient
        .from("sessions")
        .select("status")
        .eq("social_id", host.socialId)
        .eq("id", request.session_id)
        .abortSignal(checkinDatabaseTimeoutSignal())
        .single();
      if (sessionError)
        throw new Error(
          `Reading check-in session failed: ${sessionError.message}`,
        );
      let occurredAt: string | undefined;
      let expectedLastSeq = parsedLive.data?.expectedLastSeq;
      if (session.status === "live" && request.status === "pending") {
        if (!parsedLive.data) return { kind: "failed" };
        const log = await loadSessionLog(
          await createSupabaseServerClient(),
          request.session_id,
        );
        if (!log) return { kind: "failed" };
        const replayed = replay(log.events);
        if (!replayed.ok) return { kind: "failed" };
        // Stale screen: nothing is written. The request is still pending, so
        // no earlier try of this approval landed either.
        // Players' replies and the app's own actions don't count.
        if (
          !onlyNonHostsActedSince(log.events, parsedLive.data.expectedLastSeq)
        )
          return { kind: "session_changed" };
        expectedLastSeq = replayed.state.lastSeq;
        const gender = request.gender ?? parsedGender.data;
        const checkedGender = genderSchema.safeParse(gender);
        if (!checkedGender.success) return { kind: "failed" };
        const at = Math.max(Date.now(), replayed.state.lastAt ?? 0);
        const result = applyEvent(replayed.state, {
          type: "PlayerJoined",
          seq: replayed.state.lastSeq + 1,
          eventId: parsedLive.data.eventId,
          at,
          actorId: host.userId,
          payload: {
            participant: {
              participantId,
              firstName: request.first_name,
              lastName: request.last_name,
              skill: request.skill_level,
              gender: checkedGender.data,
            },
          },
        });
        if (!result.ok) return { kind: "failed" };
        occurredAt = new Date(at).toISOString();
      }
      const { data, error } = await adminClient
        .rpc("approve_checkin", {
          p_actor_user_id: host.userId,
          p_checkin_request_id: requestId,
          p_session_participant_id: participantId,
          ...(parsedGender.data ? { p_gender: parsedGender.data } : {}),
          ...(parsedLive.data
            ? {
                p_event_id: parsedLive.data.eventId,
                p_expected_last_seq: expectedLastSeq,
                p_occurred_at: occurredAt,
              }
            : {}),
        })
        .abortSignal(checkinDatabaseTimeoutSignal());
      if (error) return refusalOrThrow("approve_checkin", error);
      const { participantId: approvedParticipantId, wasApprovedBefore } =
        approvedCheckinFromRpc(data);
      if (
        wasApprovedBefore &&
        (await isDecidedByAnotherHost(adminClient, host, requestId))
      ) {
        return { kind: "already_decided" };
      }
      try {
        return {
          kind: "approved",
          participant: await readParticipant(
            adminClient,
            host,
            approvedParticipantId,
          ),
        };
      } catch (readError) {
        // Approved all the same: the tray says so and Who's playing re-reads.
        logHostCheckinFailure(
          "Reading an approved attendee failed",
          host,
          readError,
        );
        return { kind: "approved", participant: null };
      }
    },
  );
}

/**
 * Whether the social's request (already decided when asked) was decided by
 * someone else: the decision functions answer "already ..." to any host, but
 * only this host's own retry is its success. Null decided_by (that login was
 * removed) counts as someone else.
 */
async function isDecidedByAnotherHost(
  adminClient: AdminClient,
  host: SignedInHost,
  checkinRequestId: string,
): Promise<boolean> {
  const { data, error } = await adminClient
    .from("checkin_requests")
    .select("decided_by")
    .eq("social_id", host.socialId)
    .eq("id", checkinRequestId)
    .abortSignal(checkinDatabaseTimeoutSignal())
    .single();
  if (error) throw new Error(`Reading the request failed: ${error.message}`);
  return data.decided_by !== host.userId;
}

async function readParticipant(
  adminClient: AdminClient,
  host: SignedInHost,
  participantId: string,
): Promise<DraftParticipant> {
  const { data, error } = await adminClient
    .from("session_participants")
    .select(DRAFT_PARTICIPANT_COLUMNS)
    .eq("social_id", host.socialId)
    .eq("id", participantId)
    .abortSignal(checkinDatabaseTimeoutSignal())
    .single();
  if (error) throw new Error(`Reading attendee failed: ${error.message}`);
  return draftParticipantFromRow(data);
}

/**
 * Rejects a request: the player's phone shows the neutral message. This
 * host's own retry counts as done; one another host decided first is
 * already_decided.
 */
export async function rejectCheckin(
  checkinRequestId: unknown,
): Promise<HostCheckinDecisionResult> {
  return decideCheckin(
    checkinRequestId,
    "Rejecting a check-in failed",
    async (adminClient, host, requestId) => {
      const { data, error } = await adminClient
        .rpc("reject_checkin", {
          p_actor_user_id: host.userId,
          p_checkin_request_id: requestId,
        })
        .abortSignal(checkinDatabaseTimeoutSignal());
      if (error) return refusalOrThrow("reject_checkin", error);
      return wasRejectedBeforeFromRpc(data) &&
        (await isDecidedByAnotherHost(adminClient, host, requestId))
        ? { kind: "already_decided" }
        : { kind: "rejected" };
    },
  );
}
