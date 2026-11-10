import { z } from "zod";
import { SKILL_LEVELS, type SkillLevel } from "@/server/members/memberSearch";
import type { DraftParticipant } from "@/server/setup/setupDraft";

// What the host tray's check-in functions return, parsed at the boundary, and
// the typed results the host check-in actions hand to the tray. Pure (no
// server-only imports) so the tray can use the types and tests can call it.
// Migration 20261111090000_m5_checkin.sql defines the functions; columns the
// SQL can leave null are nullable here even where the generated types say
// otherwise.

const skillLevelSchema = z.enum(SKILL_LEVELS);

const pendingCheckinRowsSchema = z.array(
  z.object({
    id: z.uuid(),
    created_at: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp."),
    member_id: z.uuid().nullable(),
    first_name: z.string(),
    last_name: z.string(),
    skill_level: skillLevelSchema.nullable(),
    saved_skill_level: skillLevelSchema.nullable(),
    is_already_attending: z.boolean(),
    is_possible_duplicate: z.boolean(),
  }),
);

/** One pending request of the social's open session, as the tray shows it. */
export interface PendingCheckinRequest {
  checkinRequestId: string;
  /** ISO timestamp the player sent it. */
  createdAt: string;
  /** Null for a new player (guest). */
  memberId: string | null;
  firstName: string;
  lastName: string;
  /** The level the player chose; null when a member kept their saved level. */
  requestedSkillLevel: SkillLevel | null;
  /** The member's saved level (null for a new player, or none saved). */
  savedSkillLevel: SkillLevel | null;
  /** The member is already attending: the request can't be approved. */
  isAlreadyAttending: boolean;
  /** A new player named like someone attending (D-D): a hint for the host. */
  isPossibleDuplicate: boolean;
}

/** Parses list_checkin_requests_for_open_session's rows; throws (fail fast) on anything else. */
export function pendingCheckinRequestsFromRpc(
  rpcResult: unknown,
): PendingCheckinRequest[] {
  return pendingCheckinRowsSchema.parse(rpcResult).map((row) => ({
    checkinRequestId: row.id,
    createdAt: row.created_at,
    memberId: row.member_id,
    firstName: row.first_name,
    lastName: row.last_name,
    requestedSkillLevel: row.skill_level,
    savedSkillLevel: row.saved_skill_level,
    isAlreadyAttending: row.is_already_attending,
    isPossibleDuplicate: row.is_possible_duplicate,
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

const closeCheckinRpcSchema = z.object({
  status: z.enum(["closed", "already_closed"]),
});

/** close_checkin_already_checked_in's answer: whether it was closed before this call. */
export function wasClosedBeforeFromRpc(rpcResult: unknown): boolean {
  return closeCheckinRpcSchema.parse(rpcResult).status === "already_closed";
}

export type ListPendingCheckinsResult =
  { ok: true; requests: PendingCheckinRequest[] } | { ok: false };

/**
 * What a host decision came to:
 *   approved: the attendee (null when it was added but couldn't be read back);
 *   rejected / closed: done (also when it already was, e.g. a retry);
 *   already_in_session: approve refused, the member is already attending;
 *   not_already_in_session: close refused, the member isn't attending;
 *   already_decided: another host decided it first (or it isn't this social's);
 *   failed: nothing is known to have changed; the host can retry.
 */
export type HostCheckinDecisionResult =
  | { kind: "approved"; participant: DraftParticipant | null }
  | { kind: "rejected" }
  | { kind: "closed" }
  | { kind: "already_in_session" }
  | { kind: "not_already_in_session" }
  | { kind: "already_decided" }
  | { kind: "failed" };

export type HostCheckinRefusal = Extract<
  HostCheckinDecisionResult,
  { kind: "already_in_session" | "not_already_in_session" | "already_decided" }
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
    case "ALREADY_IN_SESSION":
      return "already_in_session";
    case "NOT_ALREADY_IN_SESSION":
      return "not_already_in_session";
    case "CHECKIN_REQUEST_NOT_PENDING":
    // Another social's request looks the same as none at all.
    case "CHECKIN_REQUEST_NOT_FOUND":
      return "already_decided";
    default:
      return null;
  }
}
