import { z } from "zod";
import { SKILL_LEVELS } from "@/server/members/memberSearch";
import { MAX_SEARCH_MATCHES, type GuestFormFieldErrors } from "./checkinRules";

// What the public check-in functions return, parsed at the boundary, and the
// typed results the check-in server actions hand to the page. Pure (no
// server-only imports) so the page can use the types and tests can call it.
// Fields the SQL can leave null are nullable here even where the generated
// types say otherwise (migration 20261111090000_m5_checkin.sql).

const timestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp.");

const skillLevelSchema = z.enum(SKILL_LEVELS);

const checkinRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "already_checked_in",
]);

export type CheckinRequestStatus = z.infer<typeof checkinRequestStatusSchema>;

const checkinPageRpcSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("inactive") }),
  z.object({ status: z.literal("no_open_session"), social_name: z.string() }),
  z.object({
    status: z.literal("open"),
    social_name: z.string(),
    session: z.object({
      name: z.string(),
      status: z.enum(["draft", "live"]),
      planned_start: timestampSchema,
      planned_end: timestampSchema,
      courts_count: z.number().int().nonnegative(),
      checked_in_count: z.number().int().nonnegative(),
    }),
    recognised_member: z
      .object({
        member_id: z.uuid(),
        first_name: z.string(),
        last_name: z.string(),
        skill_level: skillLevelSchema.nullable(),
      })
      .nullable(),
    current_request: z
      .object({
        id: z.uuid(),
        status: checkinRequestStatusSchema,
        first_name: z.string(),
        member_id: z.uuid().nullable(),
      })
      .nullable(),
    now: timestampSchema,
  }),
]);

export interface RecognisedMember {
  memberId: string;
  firstName: string;
  lastName: string;
  skillLevel: z.infer<typeof skillLevelSchema> | null;
}

export interface CurrentCheckinRequest {
  checkinRequestId: string;
  status: CheckinRequestStatus;
  firstName: string;
  memberId: string | null;
}

export interface CheckinSessionHeader {
  name: string;
  plannedStart: string;
  plannedEnd: string;
  courtsCount: number;
  checkedInCount: number;
}

export interface OpenCheckinPage {
  status: "open";
  socialName: string;
  session: CheckinSessionHeader;
  /** The member this phone is linked to in this social, if any. */
  recognisedMember: RecognisedMember | null;
  /** This phone's latest request in the open session, if any. */
  currentRequest: CurrentCheckinRequest | null;
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
          name: parsed.session.name,
          plannedStart: parsed.session.planned_start,
          plannedEnd: parsed.session.planned_end,
          courtsCount: parsed.session.courts_count,
          checkedInCount: parsed.session.checked_in_count,
        },
        recognisedMember: parsed.recognised_member && {
          memberId: parsed.recognised_member.member_id,
          firstName: parsed.recognised_member.first_name,
          lastName: parsed.recognised_member.last_name,
          skillLevel: parsed.recognised_member.skill_level,
        },
        currentRequest: parsed.current_request && {
          checkinRequestId: parsed.current_request.id,
          status: parsed.current_request.status,
          firstName: parsed.current_request.first_name,
          memberId: parsed.current_request.member_id,
        },
        now: parsed.now,
      };
  }
}

const nameMatchesRpcSchema = z
  .array(
    z.object({
      member_id: z.uuid(),
      first_name: z.string(),
      last_name: z.string(),
    }),
  )
  .max(MAX_SEARCH_MATCHES);

/** A search result: names only, never a status or a level. */
export interface NameMatch {
  memberId: string;
  firstName: string;
  lastName: string;
}

export function nameMatchesFromRpc(rpcResult: unknown): NameMatch[] {
  return nameMatchesRpcSchema.parse(rpcResult).map((row) => ({
    memberId: row.member_id,
    firstName: row.first_name,
    lastName: row.last_name,
  }));
}

const submitCheckinRpcSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    checkin_request_id: z.uuid(),
    was_already_pending: z.boolean(),
  }),
  z.object({ status: z.literal("already_checked_in") }),
  z.object({ status: z.literal("member_not_found") }),
]);

export type SubmitCheckinOutcome =
  | { status: "pending"; checkinRequestId: string }
  /** Only ever answered to the member's own linked phone. */
  | { status: "already_checked_in" }
  /** The member was deactivated (or never belonged here) since the search. */
  | { status: "member_not_found" };

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

export type SearchCheckinNamesResult =
  { ok: true; matches: NameMatch[] } | { ok: false; failure: CheckinFailure };

export type SubmitCheckinResult =
  | { ok: true; outcome: SubmitCheckinOutcome }
  | { ok: false; failure: CheckinFailure }
  | { ok: false; failure: "invalid_input"; fieldErrors: GuestFormFieldErrors };

/**
 * How the check-in functions' raised errors read (migration error
 * convention): the exception name is the message.
 *   NO_OPEN_SESSION: an unknown tag and a social with nothing open look the
 *     same here; the caller re-reads the page to tell them apart.
 */
export type CheckinDatabaseErrorKind =
  | "rate_limited"
  | "no_open_session_or_unknown_tag"
  | "invalid_input"
  | "unexpected";

export function checkinDatabaseErrorKind(error: {
  message: string;
}): CheckinDatabaseErrorKind {
  switch (error.message) {
    case "RATE_LIMITED":
      return "rate_limited";
    case "NO_OPEN_SESSION":
      return "no_open_session_or_unknown_tag";
    case "INVALID_INPUT":
    case "INVALID_NAME":
      return "invalid_input";
    default:
      return "unexpected";
  }
}
