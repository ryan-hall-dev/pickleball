// Test-only cleanup (integration and e2e), run with the secret key. The app
// itself never deletes socials, members, courts or sessions.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../lib/database.types";

type AdminClient = SupabaseClient<Database>;

/**
 * Deletes what it can of the social's sessions: drafts with their attendees
 * (attendees are deletable only while a draft), then every session nothing
 * else references. A session with a log, or a closed one that kept
 * attendees, stays: the log is append-only. Returns whether any session is
 * left, so the caller keeps the social (its rows still point at it).
 */
async function deleteTestSessions(
  adminClient: AdminClient,
  socialId: string,
  failures: string[],
): Promise<boolean> {
  const { data: sessions, error } = await adminClient
    .from("sessions")
    .select("id, status")
    .eq("social_id", socialId);
  if (error) {
    failures.push(`sessions of social ${socialId}: ${error.message}`);
    return true;
  }
  const sessionIds = sessions.map((session) => session.id);
  if (sessionIds.length === 0) return false;
  for (const table of ["checkin_requests", "checkin_attempts"] as const) {
    const { error: deleteError } = await adminClient
      .from(table)
      .delete()
      .in("session_id", sessionIds);
    if (deleteError) {
      failures.push(`${table} of social ${socialId}: ${deleteError.message}`);
    }
  }
  const draftIds = sessions
    .filter((session) => session.status === "draft")
    .map((session) => session.id);
  if (draftIds.length > 0) {
    const { error: deleteError } = await adminClient
      .from("session_participants")
      .delete()
      .in("session_id", draftIds);
    if (deleteError) {
      failures.push(
        `draft attendees of social ${socialId}: ${deleteError.message}`,
      );
    }
  }
  let isAnySessionLeft = false;
  // One at a time: a session that is still referenced (expected for logs)
  // must not keep the others.
  for (const sessionId of sessionIds) {
    const { error: deleteError } = await adminClient
      .from("sessions")
      .delete()
      .eq("id", sessionId);
    if (deleteError) isAnySessionLeft = true;
  }
  return isAnySessionLeft;
}

/**
 * Deletes each social one at a time, after its saved setups, the sessions it
 * can delete, courts and members (which keep a social from being deleted;
 * their phones go with the members), so one leftover can't block the others.
 * A social that still has sessions (append-only logs) is kept on purpose,
 * with its members and courts, which those sessions reference. Warns about
 * every other failure and returns them, e.g. a social that still has hosts.
 */
export async function deleteTestSocials(
  adminClient: AdminClient,
  socialIds: readonly string[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const socialId of socialIds) {
    const { error: setupsError } = await adminClient
      .from("saved_setups")
      .delete()
      .eq("social_id", socialId);
    if (setupsError) {
      failures.push(
        `saved setups of social ${socialId}: ${setupsError.message}`,
      );
    }
    if (await deleteTestSessions(adminClient, socialId, failures)) continue;
    for (const table of ["courts", "members"] as const) {
      const { error } = await adminClient
        .from(table)
        .delete()
        .eq("social_id", socialId);
      if (error)
        failures.push(`${table} of social ${socialId}: ${error.message}`);
    }
    const { error } = await adminClient
      .from("socials")
      .delete()
      .eq("id", socialId);
    if (error) failures.push(`social ${socialId}: ${error.message}`);
  }
  for (const failure of failures) {
    console.warn(`Couldn't delete test data: ${failure}`);
  }
  return failures;
}
