import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { HostRole } from "@/server/auth/hostAccess";

export interface HostListEntry {
  userId: string;
  displayName: string;
  role: HostRole;
}

// One social has a handful of hosts; the cap only guards against runaway lists.
const HOST_LIST_LIMIT = 200;

/**
 * The caller's social's hosts, managers first, read with the caller's session
 * (RLS: a host reads only their own social's rows).
 */
export async function listHosts(): Promise<HostListEntry[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("hosts")
    .select("user_id, display_name, role")
    .order("role")
    .order("display_name")
    .limit(HOST_LIST_LIMIT);
  if (error) throw new Error(`Listing hosts failed: ${error.message}`);
  return data.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
  }));
}

/**
 * Whether anyone at all, in any social, is on the hosts list. Used by the
 * signed-out login page (which RLS gives no read access) to explain how to
 * create the first social. Reveals one bit and nothing else.
 */
export async function installationHasAnyHost(): Promise<boolean> {
  const { count, error } = await createSupabaseAdminClient()
    .from("hosts")
    .select("user_id", { count: "exact", head: true });
  if (error) throw new Error(`Counting hosts failed: ${error.message}`);
  return (count ?? 0) > 0;
}
