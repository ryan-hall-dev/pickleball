import { z } from "zod";
import type { CheckinFormFieldErrors } from "./checkinRules";
import {
  rosterLabelFromRpc,
  rosterLabelRpcShape,
  type RosterLabel,
} from "@/server/roster/rosterLabels";

// What the public check-in functions return, parsed at the boundary, and the
// typed results the check-in server actions hand to the page. Pure (no
// server-only imports) so the page can use the types and tests can call it.
// Fields the SQL can leave null are nullable here even where the generated
// types say otherwise (migration 20261112090000_session_only_participants.sql).
//
const timestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp.");

const checkinRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "withdrawn",
]);

export type CheckinRequestStatus = z.infer<typeof checkinRequestStatusSchema>;

const checkinPageRpcSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("inactive") }),
  z.object({ status: z.literal("no_open_session"), social_name: z.string() }),
  z.object({
    status: z.literal("open"),
    social_name: z.string(),
    session: z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.enum(["draft", "live"]),
      planned_start: timestampSchema,
      planned_end: timestampSchema,
      // Null when the saved duration is unusable (under a minute or over 12 h):
      // the page then shows no duration or end rather than inventing one.
      duration_minutes: z.number().positive().max(720).nullable(),
      started_at: timestampSchema.nullable(),
      ends_at: timestampSchema.nullable(),
      courts_count: z.number().int().nonnegative(),
      checked_in_count: z.number().int().nonnegative(),
      has_roster: z.boolean(),
      walk_ins_open: z.boolean(),
    }),
    current_request: z
      .object({
        id: z.uuid(),
        status: checkinRequestStatusSchema,
        first_name: z.string(),
      })
      .nullable(),
    roster_claim: z
      .object({
        roster_entry_id: z.uuid(),
        first_name: z.string(),
        last_name: z.string(),
      })
      .nullable(),
    roster_transfer_request: z
      .object({
        id: z.uuid(),
        status: z.enum(["pending", "moved", "kept"]),
        roster_entry_id: z.uuid(),
        ...rosterLabelRpcShape,
      })
      .nullable(),
    now: timestampSchema,
  }),
]);

export interface CurrentCheckinRequest {
  checkinRequestId: string;
  status: CheckinRequestStatus;
  firstName: string;
}

export interface CheckinSessionHeader {
  sessionId: string;
  name: string;
  status: "draft" | "live";
  durationMinutes: number | null;
  startedAt: string | null;
  endsAt: string | null;
  plannedStart: string;
  plannedEnd: string;
  courtsCount: number;
  checkedInCount: number;
  /** The host pasted a list: players find their name instead of typing it. */
  hasRoster: boolean;
  /** People not on the list may ask to join (the host can close this). */
  walkInsOpen: boolean;
}

/** The roster name this phone checked in as. */
export interface RosterClaim {
  rosterEntryId: string;
  firstName: string;
  lastName: string;
}

/** This phone's latest "That's my name" request. */
export interface RosterTransferRequest {
  transferRequestId: string;
  status: "pending" | "moved" | "kept";
  rosterEntryId: string;
  label: RosterLabel;
}

export interface OpenCheckinPage {
  status: "open";
  socialName: string;
  session: CheckinSessionHeader;
  /** This phone's latest request in the open session, if any. */
  currentRequest: CurrentCheckinRequest | null;
  rosterClaim: RosterClaim | null;
  rosterTransferRequest: RosterTransferRequest | null;
  /** The database's clock when the page was read (ISO). */
  now: string;
}

export type CheckinPage =
  | { status: "inactive" }
  | { status: "no_open_session"; socialName: string }
  | OpenCheckinPage;

/** Parses get_checkin_page's JSON; throws (fail fast) on anything else. */
export function checkinPageFromRpc(rpcResult: unknown): CheckinPage {
  const parsed = checkinPageRpcSchema.parse(rpcResult);
  switch (parsed.status) {
    case "inactive":
      return { status: "inactive" };
    case "no_open_session":
      return { status: "no_open_session", socialName: parsed.social_name };
    case "open":
      return {
        status: "open",
        socialName: parsed.social_name,
        session: {
          sessionId: parsed.session.id,
          name: parsed.session.name,
          status: parsed.session.status,
          durationMinutes: parsed.session.duration_minutes,
          startedAt: parsed.session.started_at,
          endsAt: parsed.session.ends_at,
          plannedStart: parsed.session.planned_start,
          plannedEnd: parsed.session.planned_end,
          courtsCount: parsed.session.courts_count,
          checkedInCount: parsed.session.checked_in_count,
          hasRoster: parsed.session.has_roster,
          walkInsOpen: parsed.session.walk_ins_open,
        },
        currentRequest: parsed.current_request && {
          checkinRequestId: parsed.current_request.id,
          status: parsed.current_request.status,
          firstName: parsed.current_request.first_name,
        },
        rosterClaim: parsed.roster_claim && {
          rosterEntryId: parsed.roster_claim.roster_entry_id,
          firstName: parsed.roster_claim.first_name,
          lastName: parsed.roster_claim.last_name,
        },
        rosterTransferRequest: parsed.roster_transfer_request && {
          transferRequestId: parsed.roster_transfer_request.id,
          status: parsed.roster_transfer_request.status,
          rosterEntryId: parsed.roster_transfer_request.roster_entry_id,
          label: rosterLabelFromRpc(parsed.roster_transfer_request),
        },
        now: parsed.now,
      };
  }
}

const submitCheckinRpcSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    checkin_request_id: z.uuid(),
    was_already_pending: z.boolean(),
  }),
  z.object({ status: z.literal("already_checked_in") }),
]);

export type SubmitCheckinOutcome =
  | { status: "pending"; checkinRequestId: string }
  /** Only ever answered to the phone whose own request in this session was approved. */
  | { status: "already_checked_in" };

export function submitCheckinOutcomeFromRpc(
  rpcResult: unknown,
): SubmitCheckinOutcome {
  const parsed = submitCheckinRpcSchema.parse(rpcResult);
  return parsed.status === "pending"
    ? { status: "pending", checkinRequestId: parsed.checkin_request_id }
    : { status: parsed.status };
}

/**
 * Why a check-in call didn't succeed, as the page shows it:
 * rate_limited P10, inactive P11, no_open_session P12, unavailable P13.
 */
export type CheckinFailure =
  "rate_limited" | "inactive" | "no_open_session" | "unavailable";

export type ReadCheckinPageResult =
  { ok: true; page: CheckinPage } | { ok: false; failure: "unavailable" };

export type SubmitCheckinResult =
  | { ok: true; outcome: SubmitCheckinOutcome }
  | {
      ok: false;
      failure: CheckinFailure | "session_changed" | "walk_ins_closed";
    }
  | {
      ok: false;
      failure: "invalid_input";
      fieldErrors: CheckinFormFieldErrors;
    };

/**
 * How the check-in functions' raised errors read (migration error
 * convention): the exception name is the message.
 *   NO_OPEN_SESSION: an unknown tag and a social with nothing open look the
 *     same here; the caller re-reads the page to tell them apart.
 */
export type CheckinDatabaseErrorKind =
  | "session_changed"
  | "rate_limited"
  | "no_open_session_or_unknown_tag"
  | "invalid_input"
  | "walk_ins_closed"
  | "roster_entry_gone"
  | "unexpected";

export function checkinDatabaseErrorKind(error: {
  message: string;
}): CheckinDatabaseErrorKind {
  switch (error.message) {
    case "SESSION_CHANGED":
      return "session_changed";
    case "RATE_LIMITED":
      return "rate_limited";
    case "NO_OPEN_SESSION":
      return "no_open_session_or_unknown_tag";
    case "INVALID_INPUT":
    case "INVALID_NAME":
      return "invalid_input";
    case "WALK_INS_CLOSED":
      return "walk_ins_closed";
    case "ROSTER_ENTRY_NOT_FOUND":
      return "roster_entry_gone";
    default:
      return "unexpected";
  }
}

export type EnsureCheckinDeviceResult =
  { ok: true } | { ok: false; failure: CheckinFailure };

// ---------------------------------------------------------------------------
// Roster: find your name, claim it, "That's my name"
// ---------------------------------------------------------------------------

const rosterSearchRpcSchema = z.array(
  z.object({
    id: z.uuid(),
    host_note: z.string().nullable(),
    is_in_use: z.boolean(),
    ...rosterLabelRpcShape,
  }),
);

export interface RosterSearchResult {
  rosterEntryId: string;
  label: RosterLabel;
  hostNote: string | null;
  /** Only ever true for a numbered same-name entry already taken. */
  isInUse: boolean;
}

export function rosterSearchFromRpc(rpcResult: unknown): RosterSearchResult[] {
  return rosterSearchRpcSchema.parse(rpcResult).map((row) => ({
    rosterEntryId: row.id,
    label: rosterLabelFromRpc(row),
    hostNote: row.host_note,
    isInUse: row.is_in_use,
  }));
}

export type ClaimRosterOutcome =
  | "claimed"
  | "already_yours"
  | "in_use"
  | "phone_has_other_name"
  | "already_checked_in";

const claimRosterRpcSchema = z.object({
  status: z.enum([
    "claimed",
    "already_yours",
    "in_use",
    "phone_has_other_name",
    "already_checked_in",
  ]),
});

export function claimRosterOutcomeFromRpc(
  rpcResult: unknown,
): ClaimRosterOutcome {
  return claimRosterRpcSchema.parse(rpcResult).status;
}

export type RosterTransferOutcome =
  "requested" | "already_yours" | "not_in_use" | "phone_has_other_name";

const rosterTransferRpcSchema = z.object({
  status: z.enum([
    "requested",
    "already_yours",
    "not_in_use",
    "phone_has_other_name",
  ]),
});

export function rosterTransferOutcomeFromRpc(
  rpcResult: unknown,
): RosterTransferOutcome {
  return rosterTransferRpcSchema.parse(rpcResult).status;
}

/** Why a roster call failed: the page's failures, or the session or name changed. */
export type RosterCallFailure =
  CheckinFailure | "session_changed" | "roster_entry_gone" | "invalid_input";

export type SearchRosterResult =
  | { ok: true; results: RosterSearchResult[] }
  | { ok: false; failure: RosterCallFailure };

export type ClaimRosterResult =
  | { ok: true; outcome: ClaimRosterOutcome }
  | { ok: false; failure: RosterCallFailure };

export type RequestRosterTransferResult =
  | { ok: true; outcome: RosterTransferOutcome }
  | { ok: false; failure: RosterCallFailure };
