import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  checkinPageFromRpc,
  type ReadCheckinPageResult,
} from "./checkinResults";
import { checkinTagSchema } from "./checkinRules";

// Reads for the public check-in page, with the secret key: the check-in
// functions are executable by service_role only (decision 0002). They answer
// only what the page shows to this phone.

/** Every check-in database call gives up after this long (P13 on the phone). */
export const CHECKIN_DATABASE_TIMEOUT_MS = 8_000;

export function checkinDatabaseTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(CHECKIN_DATABASE_TIMEOUT_MS);
}

/** Logs a failed check-in call without personal data (no names, tags or hashes). */
export function logCheckinFailure(label: string, error: unknown) {
  console.error(label, {
    cause: error instanceof Error ? error.message : String(error),
  });
}

/**
 * get_checkin_page for this tag and phone. A malformed tag is answered as
 * inactive without asking the database (it can't match any social).
 * `deviceTokenHash` is null before the phone's first search or submit: then
 * nothing is recognised and there is no request.
 */
export async function fetchCheckinPage(
  checkinTag: string,
  deviceTokenHash: string | null,
) {
  if (!checkinTagSchema.safeParse(checkinTag).success) {
    return checkinPageFromRpc({ status: "inactive" });
  }
  const { data, error } = await createSupabaseAdminClient()
    .rpc("get_checkin_page", {
      p_checkin_tag: checkinTag,
      // The SQL accepts null (no cookie yet); the generated types can't say so.
      p_device_token_hash: deviceTokenHash as string,
    })
    .abortSignal(checkinDatabaseTimeoutSignal());
  if (error) throw new Error(`get_checkin_page failed: ${error.message}`);
  return checkinPageFromRpc(data);
}

/** The page read as a result for the page: never throws. */
export async function loadCheckinPage(
  checkinTag: string,
  deviceTokenHash: string | null,
): Promise<ReadCheckinPageResult> {
  try {
    return {
      ok: true,
      page: await fetchCheckinPage(checkinTag, deviceTokenHash),
    };
  } catch (error) {
    logCheckinFailure("Reading the check-in page failed", error);
    return { ok: false, failure: "unavailable" };
  }
}
