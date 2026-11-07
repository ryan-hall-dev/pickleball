import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/database.types";
import { readSupabasePublicEnv } from "./env";

/**
 * Refreshes the host's Supabase session for this request and copies any rotated
 * auth cookies onto the response (Server Components can't write cookies).
 * Returns whether a valid session exists; this is only an optimistic check, so
 * pages and server actions still verify the host themselves.
 */
export async function refreshSupabaseSession(request: NextRequest) {
  const { supabaseUrl, supabasePublishableKey } = readSupabasePublicEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    supabaseUrl,
    supabasePublishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getClaims() validates the JWT (refreshing it first when expired). Nothing
  // may run between creating the client and this call, or sessions drop randomly.
  const { data } = await supabase.auth.getClaims();
  return { response, isSignedIn: Boolean(data?.claims.sub) };
}
