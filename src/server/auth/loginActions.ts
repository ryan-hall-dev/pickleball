"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  HIDDEN_EMAIL_SEND_LIMIT_ERROR_CODE,
  normalizeLoginCode,
  requestLoginCodeOutcomeFromError,
  verifyLoginCodeFailureFromError,
  type RequestLoginCodeOutcome,
  type VerifyLoginCodeFailure,
} from "./loginCodeErrors";
import { recordLoginAttempt, type LoginAttemptKind } from "./loginThrottle";

const loginEmailSchema = z.email().max(254);

function parseLoginEmail(rawEmail: unknown): string | null {
  const parsed = loginEmailSchema.safeParse(
    typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : rawEmail,
  );
  return parsed.success ? parsed.data : null;
}

/** Applies the app-level throttle; null when allowed, otherwise the refusal to return. */
async function throttleLoginAttempt(
  kind: LoginAttemptKind,
  email: string,
): Promise<"RATE_LIMITED" | "UNAVAILABLE" | null> {
  try {
    return (await recordLoginAttempt(kind, email)) ? null : "RATE_LIMITED";
  } catch (error) {
    console.error("Sign-in throttle failed", {
      kind,
      cause: error instanceof Error ? error.message : String(error),
    });
    return "UNAVAILABLE";
  }
}

/** Emails a 6-digit sign-in code. Never creates users: hosts are invited by an admin. */
export async function requestLoginCode(
  rawEmail: string,
): Promise<RequestLoginCodeOutcome> {
  const email = parseLoginEmail(rawEmail);
  if (!email) return "INVALID_EMAIL";
  const throttleRefusal = await throttleLoginAttempt("request_code", email);
  if (throttleRefusal) return throttleRefusal;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  const outcome = requestLoginCodeOutcomeFromError(error);
  if (error?.code === HIDDEN_EMAIL_SEND_LIMIT_ERROR_CODE) {
    // Shown to the visitor as "code sent" so it can't reveal who is invited.
    console.warn("Supabase's per-email send limit hit; no code was sent");
  }
  if (outcome === "UNAVAILABLE") {
    // Never log the email address.
    console.error("Sending a sign-in code failed", {
      code: error?.code,
      status: error?.status,
    });
  }
  return outcome;
}

/** Checks the code; on success the session cookie is set and the host goes home. */
export async function verifyLoginCode(
  rawEmail: string,
  rawCode: string,
): Promise<{ ok: false; reason: VerifyLoginCodeFailure }> {
  const email = parseLoginEmail(rawEmail);
  const code = normalizeLoginCode(rawCode);
  if (!email || !code) return { ok: false, reason: "INVALID_CODE_FORMAT" };
  const throttleRefusal = await throttleLoginAttempt("verify_code", email);
  if (throttleRefusal) return { ok: false, reason: throttleRefusal };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    email,
    token: code,
    type: "email",
  });
  if (error) {
    const reason = verifyLoginCodeFailureFromError(error);
    if (reason === "UNAVAILABLE") {
      console.error("Verifying a sign-in code failed", {
        code: error.code,
        status: error.status,
      });
    }
    return { ok: false, reason };
  }
  // The host layout decides between the host area and "not a host here".
  redirect("/");
}

export async function signOut(): Promise<never> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signOut();
  if (error) {
    // Still send them to /login; log so a failing Auth server is visible.
    console.error("Sign-out failed on the Auth server", {
      code: error.code,
      status: error.status,
    });
  }
  redirect("/login");
}
