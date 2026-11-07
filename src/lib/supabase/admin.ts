import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { readSupabasePublicEnv } from "./env";

/**
 * Supabase client with the SECRET key: bypasses RLS and can use the Auth admin API.
 * Server only (the "server-only" import breaks any client bundle that pulls it in).
 * Use it only after the caller's authorisation has been checked, and only for what
 * the host's own session can't do (creating/deleting auth users, counting hosts on
 * the signed-out login page).
 */
export function createSupabaseAdminClient() {
  const { supabaseUrl } = readSupabasePublicEnv();
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseSecretKey) {
    throw new Error(
      "Missing SUPABASE_SECRET_KEY (server only, never NEXT_PUBLIC_). " +
        "Add it to .env.local (local value: `pnpm exec supabase status`) or the hosting provider's server env.",
    );
  }
  return createClient<Database>(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
