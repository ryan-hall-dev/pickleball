import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type AdminClient = SupabaseClient<Database>;

const AUTH_USERS_PAGE_SIZE = 1000;

async function findAuthUserIdByEmail(
  adminClient: AdminClient,
  email: string,
): Promise<string | null> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await adminClient.auth.admin.listUsers({
      page,
      perPage: AUTH_USERS_PAGE_SIZE,
    });
    if (error) throw new Error(`Listing auth users failed: ${error.message}`);
    const existingUser = data.users.find(
      (user) => user.email?.toLowerCase() === email,
    );
    if (existingUser) return existingUser.id;
    if (data.users.length < AUTH_USERS_PAGE_SIZE) return null;
  }
}

/**
 * Returns the auth user for `email`, creating a confirmed, passwordless one if
 * needed (invites are the only way users are created). Reusing an existing user
 * covers re-inviting someone and retrying an invite that half-failed.
 */
export async function findOrCreateAuthUser(
  adminClient: AdminClient,
  email: string,
): Promise<string> {
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (!error) return data.user.id;
  if (error.code !== "email_exists" && error.code !== "user_already_exists") {
    throw new Error(`Creating the auth user failed: ${error.message}`);
  }
  const existingUserId = await findAuthUserIdByEmail(adminClient, email);
  if (!existingUserId) {
    throw new Error("The auth user exists but could not be found by email.");
  }
  return existingUserId;
}
