export type SupabasePublicEnv = {
  supabaseUrl: string;
  supabasePublishableKey: string;
};

// NEXT_PUBLIC_* vars must be read with literal `process.env.NAME` so Next.js inlines them into the browser bundle.
export function readSupabasePublicEnv(): SupabasePublicEnv {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. " +
        "Copy .env.example to .env.local and fill them in (local values come from `pnpm exec supabase status`).",
    );
  }
  return { supabaseUrl, supabasePublishableKey };
}
