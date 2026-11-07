import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  authorizeHostAccess,
  type HostAccess,
  type HostAuthorization,
  type HostRole,
} from "./hostAccess";

/**
 * Reads the caller's access level, verified with the Auth server (getUser, not
 * the unverified cookie). Cached per request so the layout and page share it.
 */
export const readHostAccess = cache(async (): Promise<HostAccess> => {
  // Request time only: supabase-js reads the clock while loading the session,
  // which Next refuses during (partial) prerendering.
  await connection();
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed_out" };

  // RLS lets only hosts read `hosts`, so a non-host simply gets no row.
  const { data: hostRow, error } = await supabase
    .from("hosts")
    .select("display_name, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    throw new Error(`Reading the host record failed: ${error.message}`);
  }
  if (!hostRow) return { status: "not_a_host", email: user.email ?? null };

  return {
    status: "host",
    host: {
      userId: user.id,
      email: user.email ?? null,
      displayName: hostRow.display_name,
      role: hostRow.role,
    },
  };
});

/** Server-side authorisation for server actions: call it first in every action. */
export async function authorizeCurrentHost(
  requiredRole: HostRole,
): Promise<HostAuthorization> {
  return authorizeHostAccess(await readHostAccess(), requiredRole);
}
