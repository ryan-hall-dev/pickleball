// Creates (or promotes) the club's first admin host. Needed once per database,
// because nobody can sign in while the hosts list is empty.
//
//   pnpm create-admin --email you@example.com --name "Your name"
//   pnpm create-admin --email you@example.com --name "Your name" --production
//
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY from the environment
// (.env.local is loaded automatically). Refuses any non-local URL unless
// --production is given, so it can't touch a hosted project by accident.
// Safe to re-run: it reuses an existing login and upserts the hosts row.
import { parseArgs } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/database.types";

type DatabaseClient = SupabaseClient<Database>;

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const AUTH_USERS_PAGE_SIZE = 1000;
const DISPLAY_NAME_MAX_LENGTH = 80;

function fail(message: string): never {
  console.error(`create-admin: ${message}`);
  process.exit(1);
}

function readOptions() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      production: { type: "boolean", default: false },
    },
    strict: true,
  });
  const email = values.email?.trim().toLowerCase() ?? "";
  const displayName = values.name?.trim() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("--email must be an email address, e.g. --email you@example.com.");
  }
  if (
    displayName.length < 1 ||
    displayName.length > DISPLAY_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    fail(
      `--name must be 1-${DISPLAY_NAME_MAX_LENGTH} characters, e.g. --name "Sam Lee".`,
    );
  }
  return { email, displayName, allowProduction: values.production };
}

function readConnection(allowProduction: boolean) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !secretKey) {
    fail(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (local values: `pnpm exec supabase status`, copied into .env.local).",
    );
  }
  let hostname: string;
  try {
    hostname = new URL(supabaseUrl).hostname;
  } catch {
    fail(`NEXT_PUBLIC_SUPABASE_URL is not a URL: "${supabaseUrl}".`);
  }
  if (!LOCAL_HOSTNAMES.has(hostname) && !allowProduction) {
    fail(
      `refusing to write to a non-local database (${hostname}). Re-run with --production if you really mean that project.`,
    );
  }
  return { supabaseUrl, secretKey };
}

// Twin of findOrCreateAuthUser in src/server/hosts/authUsers.ts (scripts can't
// import server-only app modules); keep the two in step.
async function findOrCreateUser(
  client: DatabaseClient,
  email: string,
): Promise<string> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: AUTH_USERS_PAGE_SIZE,
    });
    if (error) fail(`listing auth users failed: ${error.message}`);
    const existing = data.users.find(
      (user) => user.email?.toLowerCase() === email,
    );
    if (existing) return existing.id;
    if (data.users.length < AUTH_USERS_PAGE_SIZE) break;
  }
  // Passwordless: hosts sign in with an emailed 6-digit code.
  const { data, error } = await client.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !data.user) fail(`creating the login failed: ${error?.message}`);
  return data.user.id;
}

async function createAdmin() {
  const { email, displayName, allowProduction } = readOptions();
  const { supabaseUrl, secretKey } = readConnection(allowProduction);
  const client: DatabaseClient = createClient<Database>(
    supabaseUrl,
    secretKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  const userId = await findOrCreateUser(client, email);
  const { error } = await client
    .from("hosts")
    .upsert(
      { user_id: userId, display_name: displayName, role: "admin" },
      { onConflict: "user_id" },
    );
  if (error) fail(`saving the admin host failed: ${error.message}`);

  console.log(
    `${displayName} is an admin on ${new URL(supabaseUrl).host}. Sign in at /login with ${email}.`,
  );
}

await createAdmin();
