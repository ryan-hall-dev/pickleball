import { createBrowserClient } from "@supabase/ssr";
import { readSupabasePublicEnv } from "./env";

/** Supabase client for Client Components. Uses the host's auth cookies. */
export function createSupabaseBrowserClient() {
  const { supabaseUrl, supabasePublishableKey } = readSupabasePublicEnv();
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
