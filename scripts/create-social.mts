// Operator script: creates a social and its first social manager, or adds a
// manager to an existing social. Nobody can sign in until a social exists.
// Usage: see USAGE below (`pnpm create-social --help`). docs/auth.md has the
// full steps.
import { parseArgs } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/database.types";

type DatabaseClient = SupabaseClient<Database>;

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const AUTH_USERS_PAGE_SIZE = 1000;
// Mirrors the `short_label` domain (social and host names).
const SHORT_LABEL_MAX_LENGTH = 80;
const USAGE = `Usage:
  pnpm create-social --name "Riverside Social" --manager-email you@example.com --manager-name "Your name"
      Creates a social and its first social manager (one transaction).
  pnpm create-social --social-id <uuid> --manager-email co@example.com [--manager-name "Co Manager"]
      Adds a social manager to an existing social, or promotes one of its hosts.

Options:
  --manager-name  Required when the login isn't a host yet. Optional when it
                  already hosts the social (a promotion or a re-run): the
                  existing display name is kept and a given name is ignored.
  --production    Allow a non-local NEXT_PUBLIC_SUPABASE_URL (a hosted
                  project: only with Ryan's OK). Refused otherwise.
  --help          Show this help.

Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (.env.local is loaded
automatically). Safe to re-run: it reuses an existing login, and a manager who
already manages the social is reported, not duplicated. One login belongs to
one social, so a login that hosts another social is refused. Prints the
social's id and its check-in link /t/<tag>.`;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  console.error(`create-social: ${message}`);
  process.exit(1);
}

function readShortLabel(value: string | undefined, optionName: string) {
  const label = value?.replace(/\s+/g, " ").trim() ?? "";
  if (
    label.length < 1 ||
    label.length > SHORT_LABEL_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(label)
  ) {
    fail(`${optionName} must be 1-${SHORT_LABEL_MAX_LENGTH} characters.`);
  }
  return label;
}

function readOptions() {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      "social-id": { type: "string" },
      "manager-email": { type: "string" },
      "manager-name": { type: "string" },
      production: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const existingSocialId = values["social-id"]?.trim();
  if (existingSocialId !== undefined && !UUID_PATTERN.test(existingSocialId)) {
    fail("--social-id must be a social's id (a UUID).");
  }
  if (existingSocialId !== undefined && values.name !== undefined) {
    fail("give either --name (a new social) or --social-id (an existing one).");
  }
  const managerEmail = values["manager-email"]?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(managerEmail)) {
    fail(
      "--manager-email must be an email address, e.g. --manager-email you@example.com.",
    );
  }
  return {
    socialName:
      existingSocialId === undefined
        ? readShortLabel(values.name, "--name")
        : null,
    existingSocialId: existingSocialId?.toLowerCase() ?? null,
    managerEmail,
    // Null when not given: only needed for a login that isn't a host yet.
    managerDisplayName:
      values["manager-name"] === undefined
        ? null
        : readShortLabel(values["manager-name"], "--manager-name"),
    allowProduction: values.production,
  };
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
async function findUserIdByEmail(
  client: DatabaseClient,
  email: string,
): Promise<string | null> {
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
    if (data.users.length < AUTH_USERS_PAGE_SIZE) return null;
  }
}

async function createUser(
  client: DatabaseClient,
  email: string,
): Promise<string> {
  // Passwordless: hosts sign in with an emailed 6-digit code.
  const { data, error } = await client.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !data.user) fail(`creating the login failed: ${error?.message}`);
  return data.user.id;
}

function requireManagerName(managerDisplayName: string | null): string {
  if (managerDisplayName === null) {
    fail(
      'this login isn\'t a host yet, so --manager-name is required, e.g. --manager-name "Sam Lee".',
    );
  }
  return managerDisplayName;
}

interface SocialSummary {
  id: string;
  name: string;
  checkin_tag: string;
}

interface ManagerOutcome {
  social: SocialSummary;
  displayName: string;
  outcome: string;
}

async function readSocial(
  client: DatabaseClient,
  socialId: string,
): Promise<SocialSummary | null> {
  const { data, error } = await client
    .from("socials")
    .select("id, name, checkin_tag")
    .eq("id", socialId)
    .maybeSingle();
  if (error) fail(`reading the social failed: ${error.message}`);
  return data;
}

async function readExistingHost(client: DatabaseClient, userId: string) {
  const { data, error } = await client
    .from("hosts")
    .select("role, social_id, display_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) fail(`reading the hosts list failed: ${error.message}`);
  return data;
}

async function warnOnDuplicateSocialName(
  client: DatabaseClient,
  socialName: string,
) {
  const escapedName = socialName.replace(/[\\%_]/g, "\\$&");
  const { data, error } = await client
    .from("socials")
    .select("id")
    .ilike("name", escapedName);
  if (error) fail(`checking for duplicate names failed: ${error.message}`);
  if (data.length > 0) {
    console.warn(
      `create-social: warning: ${data.length} social(s) already named "${socialName}" (${data.map((social) => social.id).join(", ")}). Creating another one anyway.`,
    );
  }
}

/** Adds the manager to an existing social (or promotes its host). */
async function addManagerToSocial(
  client: DatabaseClient,
  socialId: string,
  existingUserId: string | null,
  managerEmail: string,
  managerDisplayName: string | null,
): Promise<ManagerOutcome> {
  const social = await readSocial(client, socialId);
  if (!social) fail(`no social has the id ${socialId}.`);
  const existingHost = existingUserId
    ? await readExistingHost(client, existingUserId)
    : null;
  if (existingHost && existingHost.social_id !== socialId) {
    fail(
      `that login already hosts another social (${existingHost.social_id}); one login belongs to one social.`,
    );
  }
  if (existingHost?.role === "manager") {
    return {
      social,
      displayName: existingHost.display_name,
      outcome: "was already a social manager of",
    };
  }
  if (existingHost) {
    const userId = existingUserId!;
    const { error } = await client
      .from("hosts")
      .update({ role: "manager" })
      .eq("user_id", userId)
      .eq("social_id", socialId);
    if (error) fail(`promoting the host failed: ${error.message}`);
    return {
      social,
      displayName: existingHost.display_name,
      outcome: "was promoted to social manager of",
    };
  }
  const displayName = requireManagerName(managerDisplayName);
  const userId = existingUserId ?? (await createUser(client, managerEmail));
  const { error } = await client.from("hosts").insert({
    user_id: userId,
    display_name: displayName,
    role: "manager",
    social_id: socialId,
  });
  if (error) fail(`adding the manager failed: ${error.message}`);
  return { social, displayName, outcome: "is now a social manager of" };
}

/** Creates the social with its first manager (one transaction). */
async function createSocialWithManager(
  client: DatabaseClient,
  socialName: string,
  existingUserId: string | null,
  managerEmail: string,
  managerDisplayName: string | null,
): Promise<ManagerOutcome> {
  const existingHost = existingUserId
    ? await readExistingHost(client, existingUserId)
    : null;
  if (existingHost) {
    const existingSocial = await readSocial(client, existingHost.social_id);
    // A re-run of the same command: report it instead of failing.
    if (
      existingHost.role === "manager" &&
      existingSocial?.name === socialName
    ) {
      return {
        social: existingSocial,
        displayName: existingHost.display_name,
        outcome: "was already a social manager of",
      };
    }
    fail(
      `that login already hosts the social "${existingSocial?.name}" (${existingHost.social_id}); one login belongs to one social. To make them a manager there, use --social-id ${existingHost.social_id}.`,
    );
  }
  const displayName = requireManagerName(managerDisplayName);
  await warnOnDuplicateSocialName(client, socialName);
  const userId = existingUserId ?? (await createUser(client, managerEmail));
  const { data: socialId, error } = await client.rpc(
    "create_social_with_manager",
    {
      p_name: socialName,
      p_manager_user_id: userId,
      p_manager_display_name: displayName,
    },
  );
  if (error) fail(`creating the social failed: ${error.message}`);
  const social = await readSocial(client, socialId);
  if (!social) fail("the new social is missing after creating it.");
  return { social, displayName, outcome: "is now the social manager of" };
}

async function createSocial() {
  const {
    socialName,
    existingSocialId,
    managerEmail,
    managerDisplayName,
    allowProduction,
  } = readOptions();
  const { supabaseUrl, secretKey } = readConnection(allowProduction);
  const client: DatabaseClient = createClient<Database>(
    supabaseUrl,
    secretKey,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // The login is only created once the hosts row is sure to follow.
  const existingUserId = await findUserIdByEmail(client, managerEmail);
  const { social, displayName, outcome } =
    existingSocialId === null
      ? await createSocialWithManager(
          client,
          socialName!,
          existingUserId,
          managerEmail,
          managerDisplayName,
        )
      : await addManagerToSocial(
          client,
          existingSocialId,
          existingUserId,
          managerEmail,
          managerDisplayName,
        );

  console.log(
    [
      `${displayName} ${outcome} "${social.name}" on ${new URL(supabaseUrl).host}.`,
      `  sign in     /login with ${managerEmail}`,
      `  social id   ${social.id}`,
      `  check-in    /t/${social.checkin_tag}`,
    ].join("\n"),
  );
}

await createSocial();
