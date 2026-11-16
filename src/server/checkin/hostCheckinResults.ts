import { z } from "zod";
import { genderSchema, type Gender } from "@/server/participantRules";
import { SKILL_LEVELS, type SkillLevel } from "@/server/skillLevels";
import type { DraftParticipant } from "@/server/setup/setupDraft";

// What the host tray's check-in functions return, parsed at the boundary, and
// the typed results the host check-in actions hand to the tray. Pure (no
// server-only imports) so the tray can use the types and tests can call it.
// Migration 20261112090000_session_only_participants.sql defines the
// functions.

const skillLevelSchema = z.enum(SKILL_LEVELS);

const pendingCheckinRowsSchema = z.array(
  z.object({
    id: z.uuid(),
    created_at: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp."),
    first_name: z.string(),
    last_name: z.string(),
    skill_level: skillLevelSchema.nullable(),
    gender: genderSchema.nullable(),
    is_name_already_in_session: z.boolean(),
  }),
);

/** One pending request of the social's open session, as the tray shows it. */
export interface PendingCheckinRequest {
  checkinRequestId: string;
  /** ISO timestamp the player sent it. */
  createdAt: string;
  firstName: string;
  lastName: string;
  skillLevel: SkillLevel | null;
  gender: Gender | null;
  /**
   * Someone with this name is already in the session: the request can't be
   * approved (names are unique per session); the host rejects it.
   */
  isNameAlreadyInSession: boolean;
}

/** Parses list_checkin_requests_for_open_session's rows; throws (fail fast) on anything else. */
export function pendingCheckinRequestsFromRpc(
  rpcResult: unknown,
): PendingCheckinRequest[] {
  return pendingCheckinRowsSchema.parse(rpcResult).map((row) => ({
    checkinRequestId: row.id,
    createdAt: row.created_at,
    firstName: row.first_name,
    lastName: row.last_name,
    skillLevel: row.skill_level,
    gender: row.gender,
    isNameAlreadyInSession: row.is_name_already_in_session,
  }));
}

const approveCheckinRpcSchema = z.object({
  status: z.enum(["approved", "already_approved"]),
  session_participant_id: z.uuid(),
});

/**
 * approve_checkin's answer: the attendee's id, and whether the request was
 * approved before this call (by this host's earlier try or another host).
 */
export function approvedCheckinFromRpc(rpcResult: unknown): {
  participantId: string;
  wasApprovedBefore: boolean;
} {
  const parsed = approveCheckinRpcSchema.parse(rpcResult);
  return {
    participantId: parsed.session_participant_id,
    wasApprovedBefore: parsed.status === "already_approved",
  };
}

const rejectCheckinRpcSchema = z.object({
  status: z.enum(["rejected", "already_rejected"]),
});

/** reject_checkin's answer: whether the request was rejected before this call. */
export function wasRejectedBeforeFromRpc(rpcResult: unknown): boolean {
  return rejectCheckinRpcSchema.parse(rpcResult).status === "already_rejected";
}

export type ListPendingCheckinsResult =
  { ok: true; requests: PendingCheckinRequest[] } | { ok: false };

/**
 * What a host decision came to:
 *   approved: the attendee (null when it was added but couldn't be read back);
 *   rejected: done (also when it already was, e.g. a retry);
 *   name_already_in_session: approve refused, someone with this name is
 *     already in the session;
 *   already_decided: another host decided it first (or it isn't this social's);
 *   session_changed: a live approval was refused because the session's log
 *     moved on since the host's screen was read (stale expected sequence).
 *     Nothing was written; the host approves again on the refreshed state;
 *   failed: the outcome is not known (it may or may not have been saved); the
 *     host retries, on Live with the same event id.
 */
export type HostCheckinDecisionResult =
  | { kind: "approved"; participant: DraftParticipant | null }
  | { kind: "rejected" }
  | { kind: "name_already_in_session" }
  | { kind: "already_decided" }
  | { kind: "session_changed" }
  | { kind: "failed" };

export type HostCheckinRefusal = Extract<
  HostCheckinDecisionResult,
  { kind: "name_already_in_session" | "already_decided" | "session_changed" }
>["kind"];

/**
 * The decision functions' raised errors that the tray answers (migration
 * error convention: the exception name is the message). Anything else is a
 * failure the host can retry: e.g. SESSION_CLOSED, or EVENT_REQUIRED when
 * the session went live meanwhile (approving into a live session is M7).
 */
export function hostCheckinRefusalFromError(error: {
  message: string;
}): HostCheckinRefusal | null {
  switch (error.message) {
    case "NAME_ALREADY_IN_SESSION":
      return "name_already_in_session";
    case "CHECKIN_REQUEST_NOT_PENDING":
    // Another social's request looks the same as none at all.
    case "CHECKIN_REQUEST_NOT_FOUND":
      return "already_decided";
    // The live log gained an action between the host's read and this write.
    case "STALE_EXPECTED_SEQ":
      return "session_changed";
    default:
      return null;
  }
}
