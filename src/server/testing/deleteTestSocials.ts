// Test-only cleanup (integration and e2e), run with the secret key. The app
// itself never deletes socials, members or courts.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../lib/database.types";

/**
 * Deletes each social one at a time, after its courts and members (which keep
 * a social from being deleted; their phones go with the members), so one
 * leftover can't block the others. Warns about every failure and returns
 * them, e.g. a member still referenced by a session's attendees, or a social
 * that still has hosts.
 */
export async function deleteTestSocials(
  adminClient: SupabaseClient<Database>,
  socialIds: readonly string[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const socialId of socialIds) {
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
