import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashClientIp } from "@/server/checkin/clientIdentity";
import { clientIpFromHeaders } from "./clientIp";

export type LoginAttemptKind = "request_code" | "verify_code";

/** SHA-256 of the already-normalised (trimmed, lowercased) email. */
function hashLoginEmail(normalizedEmail: string): string {
  return createHash("sha256").update(normalizedEmail, "utf8").digest("hex");
}

/**
 * App-level sign-in throttle (record_login_attempt): per client IP and per
 * email, because Supabase's own per-IP limits only ever see this server's IP.
 * Records the attempt and returns true when it's within the limits. Applies to
 * invited and uninvited emails alike, so a refusal reveals nothing.
 */
export async function recordLoginAttempt(
  kind: LoginAttemptKind,
  normalizedEmail: string,
): Promise<boolean> {
  const clientIp = clientIpFromHeaders(await headers());
  if (!clientIp) {
    throw new Error(
      "No client IP: x-forwarded-for is missing, so the sign-in throttle can't key on the visitor.",
    );
  }
  const { data: isAllowed, error } = await createSupabaseAdminClient().rpc(
    "record_login_attempt",
    {
      p_kind: kind,
      p_ip_hash: hashClientIp(clientIp),
      p_email_hash: hashLoginEmail(normalizedEmail),
    },
  );
  if (error)
    throw new Error(`Recording a sign-in attempt failed: ${error.message}`);
  return isAllowed;
}
