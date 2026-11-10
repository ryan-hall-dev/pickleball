"use server";

import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  ensureDeviceTokenHash,
  readClientIpHash,
  readDeviceTokenHash,
} from "./checkinDevice";
import {
  checkinDatabaseTimeoutSignal,
  fetchCheckinPage,
  loadCheckinPage,
  logCheckinFailure,
} from "./checkinPage";
import {
  checkinDatabaseErrorKind,
  nameMatchesFromRpc,
  submitCheckinOutcomeFromRpc,
  type CheckinFailure,
  type ReadCheckinPageResult,
  type SearchCheckinNamesResult,
  type SubmitCheckinResult,
} from "./checkinResults";
import {
  checkinSubmitInputSchema,
  checkinTagSchema,
  isSearchableQuery,
  searchQuerySchema,
} from "./checkinRules";

// The public check-in page's server actions (/t/<tag>, no login). They are
// the page's only way in: search, submit and the page read, each through a
// service_role check-in function that is scoped by the tag and rate-limited
// per phone, network and session (decision 0002, acceptance criteria 9,
// 16-19). Nothing here reaches a host, session-management or admin operation.
// Inputs come from the browser, so every one is validated here.

/** The page's read, also polled every 5 s while a request waits. */
export async function readCheckinPage(
  checkinTag: unknown,
): Promise<ReadCheckinPageResult> {
  const parsedTag = checkinTagSchema.safeParse(checkinTag);
  if (!parsedTag.success) return { ok: true, page: { status: "inactive" } };
  try {
    return await loadCheckinPage(parsedTag.data, await readDeviceTokenHash());
  } catch (error) {
    logCheckinFailure("Reading the check-in page failed", error);
    return { ok: false, failure: "unavailable" };
  }
}

/**
 * Gives a new phone its device cookie as soon as the page opens, before any
 * submit (the page render can't set cookies). Then a submit whose answer is
 * lost can be retried as the same phone, which returns the same request
 * (criterion 8). No database call.
 */
export async function ensureCheckinDevice(): Promise<void> {
  await ensureDeviceTokenHash();
}

/**
 * search_checkin_names and submit_checkin raise NO_OPEN_SESSION for both an
 * unknown tag and a social with nothing open; the page read tells them apart.
 * Open again already (a race): unavailable, so "Try again" re-reads the page.
 */
async function failureForClosedCheckin(
  checkinTag: string,
): Promise<CheckinFailure> {
  const page = await fetchCheckinPage(checkinTag, null);
  return page.status === "open" ? "unavailable" : page.status;
}

/**
 * "Find your name": at most 5 active members of the tag's social, names only.
 * Nothing (and no rate-limit cost) for fewer than 2 letters.
 */
export async function searchCheckinNames(
  checkinTag: unknown,
  nameQuery: unknown,
): Promise<SearchCheckinNamesResult> {
  const parsedTag = checkinTagSchema.safeParse(checkinTag);
  if (!parsedTag.success) return { ok: false, failure: "inactive" };
  const parsedQuery = searchQuerySchema.safeParse(nameQuery);
  // Too long to be anyone's name, or too short to search.
  if (!parsedQuery.success || !isSearchableQuery(parsedQuery.data)) {
    return { ok: true, matches: [] };
  }

  try {
    const { data, error } = await createSupabaseAdminClient()
      .rpc("search_checkin_names", {
        p_checkin_tag: parsedTag.data,
        p_name_query: parsedQuery.data,
        p_device_token_hash: await ensureDeviceTokenHash(),
        p_ip_hash: await readClientIpHash(),
      })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) {
      switch (checkinDatabaseErrorKind(error)) {
        case "rate_limited":
          return { ok: false, failure: "rate_limited" };
        case "no_open_session_or_unknown_tag":
          return {
            ok: false,
            failure: await failureForClosedCheckin(parsedTag.data),
          };
        case "invalid_input":
          // Our hashes are always well formed, so this is the query: something
          // other than letters, spaces, apostrophes, hyphens and dots can't be
          // in a name.
          return { ok: true, matches: [] };
        case "unexpected":
          throw new Error(`search_checkin_names failed: ${error.message}`);
      }
    }
    return { ok: true, matches: nameMatchesFromRpc(data) };
  } catch (error) {
    logCheckinFailure("Check-in search failed", error);
    return { ok: false, failure: "unavailable" };
  }
}

/**
 * Sends a check-in request for the host to approve (nobody is added without
 * one, criterion 19). A member picked from search or recognised on this
 * phone, or a guest with all three fields. A second submit from the same
 * phone returns its pending request (criterion 8).
 */
export async function submitCheckin(
  checkinTag: unknown,
  checkinInput: unknown,
): Promise<SubmitCheckinResult> {
  const parsedTag = checkinTagSchema.safeParse(checkinTag);
  if (!parsedTag.success) return { ok: false, failure: "inactive" };
  const parsedInput = checkinSubmitInputSchema.safeParse(checkinInput);
  if (!parsedInput.success) {
    // The browser checks the same schema first, so only a tampered or
    // outdated page gets here.
    const fieldErrors: Partial<Record<string, string[]>> = z.flattenError(
      parsedInput.error,
    ).fieldErrors;
    return {
      ok: false,
      failure: "invalid_input",
      fieldErrors: {
        firstName: fieldErrors.firstName?.[0],
        lastName: fieldErrors.lastName?.[0],
        skillLevel: fieldErrors.skillLevel?.[0],
      },
    };
  }
  const input = parsedInput.data;
  const skillLevel =
    input.kind === "guest" ? input.skillLevel : input.updatedSkillLevel;

  try {
    const { data, error } = await createSupabaseAdminClient()
      .rpc("submit_checkin", {
        p_checkin_tag: parsedTag.data,
        p_device_token_hash: await ensureDeviceTokenHash(),
        p_ip_hash: await readClientIpHash(),
        p_first_name: input.firstName,
        p_last_name: input.lastName,
        // Omitted means null: a member keeps their saved level.
        ...(skillLevel ? { p_skill_level: skillLevel } : {}),
        ...(input.kind === "member" ? { p_member_id: input.memberId } : {}),
      })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) {
      switch (checkinDatabaseErrorKind(error)) {
        case "rate_limited":
          return { ok: false, failure: "rate_limited" };
        case "no_open_session_or_unknown_tag":
          return {
            ok: false,
            failure: await failureForClosedCheckin(parsedTag.data),
          };
        // The input schema mirrors the database's rules, so a refusal
        // here is a bug, not something the player can fix.
        case "invalid_input":
        case "unexpected":
          throw new Error(`submit_checkin failed: ${error.message}`);
      }
    }
    return { ok: true, outcome: submitCheckinOutcomeFromRpc(data) };
  } catch (error) {
    logCheckinFailure("Check-in submit failed", error);
    return { ok: false, failure: "unavailable" };
  }
}
