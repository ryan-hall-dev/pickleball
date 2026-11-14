"use server";

import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { ensureDeviceTokenHash, readClientIpHash } from "./checkinDevice";
import {
  checkinDatabaseTimeoutSignal,
  fetchCheckinPage,
  loadCheckinPage,
  logCheckinFailure,
} from "./checkinPage";
import {
  checkinDatabaseErrorKind,
  submitCheckinOutcomeFromRpc,
  type CheckinFailure,
  type EnsureCheckinDeviceResult,
  type ReadCheckinPageResult,
  type SubmitCheckinResult,
} from "./checkinResults";
import { checkinSubmitInputSchema, checkinTagSchema } from "./checkinRules";

// The public check-in page's server actions (/t/<tag>, no login). They are
// the page's only way in: submit and the page read, each through a
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
    return await loadCheckinPage(parsedTag.data);
  } catch (error) {
    logCheckinFailure("Reading the check-in page failed", error);
    return { ok: false, failure: "unavailable" };
  }
}

/**
 * Gives a new phone its device cookie as soon as the page opens, before any
 * submit (the page render can't set cookies). Then a submit whose answer is
 * lost can be retried as the same phone, which returns the same request
 * (criterion 8). Resolves the current session before selecting its cookie.
 */
export async function ensureCheckinDevice(
  checkinTag: unknown,
): Promise<EnsureCheckinDeviceResult> {
  const parsedTag = checkinTagSchema.safeParse(checkinTag);
  if (!parsedTag.success) return { ok: false, failure: "inactive" };
  try {
    const page = await fetchCheckinPage(parsedTag.data, null);
    if (page.status !== "open") return { ok: false, failure: page.status };
    await ensureDeviceTokenHash(page.session.sessionId, parsedTag.data);
    return { ok: true };
  } catch (error) {
    logCheckinFailure("Preparing the check-in cookie failed", error);
    return { ok: false, failure: "unavailable" };
  }
}

/**
 * submit_checkin raises NO_OPEN_SESSION for both an
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
 * Sends a check-in request for the host to approve (nobody is added without
 * one, criterion 19): first name, last name and level. A second submit from
 * the same phone returns its pending request (criterion 8); a phone whose
 * request in this session was approved is told it's already checked in.
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

  try {
    const page = await fetchCheckinPage(parsedTag.data, null);
    if (page.status !== "open") return { ok: false, failure: page.status };
    if (page.session.sessionId !== input.sessionId)
      return { ok: false, failure: "session_changed" };
    const deviceHash = await ensureDeviceTokenHash(
      input.sessionId,
      parsedTag.data,
    );
    const { data, error } = await createSupabaseAdminClient()
      .rpc("submit_checkin", {
        p_checkin_tag: parsedTag.data,
        p_expected_session_id: input.sessionId,
        p_device_token_hash: deviceHash,
        p_ip_hash: await readClientIpHash(),
        p_first_name: input.firstName,
        p_last_name: input.lastName,
        p_skill_level: input.skillLevel,
      })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) {
      switch (checkinDatabaseErrorKind(error)) {
        case "session_changed":
          return { ok: false, failure: "session_changed" };
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
