// Deterministic demo data for the LOCAL Supabase stack only.
//
//   pnpm seed --members 30 --courts 4 --attending 16
//
// Creates (or updates in place, so it is safe to re-run): a social managed by
// the local user host@example.test (sign in with the email code from Mailpit;
// an existing host keeps their social), courts, members and a draft session
// with attendees.
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY from the environment
// (.env.local is loaded automatically) and refuses any non-local URL.
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/database.types";

type DatabaseClient = SupabaseClient<Database>;
type SkillLevel = Database["public"]["Enums"]["skill_level"];

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SEED_HOST_EMAIL = "host@example.test";
const SEED_HOST_DISPLAY_NAME = "Local Manager";
const SEED_SOCIAL_NAME = "Riverside Pickleball Club";
const SEED_RANDOM_SEED = 20261107;
const LIMITS = {
  members: { min: 0, max: 5000, default: 30 },
  courts: { min: 0, max: 50, default: 4 },
  attending: { min: 0, max: 5000, default: 16 },
} as const;

const FIRST_NAMES = [
  "Ana",
  "Ben",
  "Cleo",
  "Dev",
  "Ella",
  "Finn",
  "Hana",
  "Ivy",
  "Jon",
  "Kai",
  "Lena",
  "Mia",
  "Nia",
  "Omar",
  "Priya",
  "Quinn",
  "Rosa",
  "Sam",
  "Theo",
  "Uma",
  "Vic",
  "Wren",
  "Xavi",
  "Yara",
  "Zoe",
  "Kofi",
  "Ravi",
  "Leo",
  "Maya",
  "Noor",
];
const LAST_NAMES = [
  "Brown",
  "Chen",
  "Dubois",
  "Evans",
  "Fischer",
  "Haddad",
  "Ito",
  "Jones",
  "Kowalski",
  "Lopez",
  "Mensah",
  "Novak",
  "Okafor",
  "Patel",
  "Rossi",
  "Silva",
  "Tanaka",
  "Usman",
  "Vargas",
  "Weber",
  "Young",
  "Zhang",
  "Moreau",
  "Nguyen",
];
const SKILL_LEVELS: SkillLevel[] = ["beginner", "intermediate", "advanced"];

function fail(message: string): never {
  console.error(`seed: ${message}`);
  process.exit(1);
}

function readCount(
  values: Record<string, string | undefined>,
  name: keyof typeof LIMITS,
): number {
  const { min, max, default: fallback } = LIMITS[name];
  const raw = values[name];
  if (raw === undefined) return fallback;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < min || count > max) {
    fail(
      `--${name} must be a whole number from ${min} to ${max} (got "${raw}").`,
    );
  }
  return count;
}

function readOptions() {
  const { values } = parseArgs({
    options: {
      members: { type: "string" },
      courts: { type: "string" },
      attending: { type: "string" },
    },
    strict: true,
  });
  const members = readCount(values, "members");
  const courts = readCount(values, "courts");
  const attending = readCount(values, "attending");
  if (attending > members) {
    fail(`--attending (${attending}) can't exceed --members (${members}).`);
  }
  return { members, courts, attending };
}

function readLocalConnection() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !secretKey) {
    fail(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (copy the local values from `pnpm exec supabase status` into .env.local).",
    );
  }
  let hostname: string;
  try {
    hostname = new URL(supabaseUrl).hostname;
  } catch {
    fail(`NEXT_PUBLIC_SUPABASE_URL is not a URL: "${supabaseUrl}".`);
  }
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    fail(
      `refusing to seed a non-local database (${hostname}). The seed only runs against the local stack.`,
    );
  }
  return { supabaseUrl, secretKey };
}

/** A stable UUID (v4 layout) derived from a key, so re-runs update the same rows. */
function seedUuid(key: string): string {
  const hex = createHash("sha256")
    .update(`pickleball-seed:${key}`)
    .digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Mulberry32, as in src/engine/schedule/seededRandom.ts (scripts can't import app modules at runtime). */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function check<T>(
  result: { data: T; error: { message: string } | null },
  what: string,
): T {
  if (result.error) fail(`${what} failed: ${result.error.message}`);
  return result.data;
}

async function findOrCreateHostUser(client: DatabaseClient): Promise<string> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) fail(`listing auth users failed: ${error.message}`);
    const existing = data.users.find((user) => user.email === SEED_HOST_EMAIL);
    if (existing) return existing.id;
    if (data.users.length < 1000) break;
  }
  // Passwordless: hosts sign in with an email code (local codes arrive in Mailpit).
  const { data, error } = await client.auth.admin.createUser({
    email: SEED_HOST_EMAIL,
    email_confirm: true,
  });
  if (error || !data.user)
    fail(`creating ${SEED_HOST_EMAIL} failed: ${error?.message}`);
  return data.user.id;
}

function nextFullHour(): Date {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  return start;
}

async function seed() {
  const options = readOptions();
  const { supabaseUrl, secretKey } = readLocalConnection();
  const client: DatabaseClient = createClient<Database>(
    supabaseUrl,
    secretKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  const hostUserId = await findOrCreateHostUser(client);
  const existingHost = check(
    await client
      .from("hosts")
      .select("social_id")
      .eq("user_id", hostUserId)
      .maybeSingle(),
    "reading the seed host",
  );
  const socialId =
    existingHost?.social_id ??
    check(
      await client.rpc("create_social_with_manager", {
        p_name: SEED_SOCIAL_NAME,
        p_manager_user_id: hostUserId,
        p_manager_display_name: SEED_HOST_DISPLAY_NAME,
      }),
      "creating the seed social",
    );
  if (!socialId) fail("creating the seed social returned no id.");
  check(
    await client
      .from("hosts")
      .update({ display_name: SEED_HOST_DISPLAY_NAME, role: "manager" })
      .eq("user_id", hostUserId),
    "saving the seed manager",
  );

  const courts = Array.from({ length: options.courts }, (_, index) => ({
    id: seedUuid(`court-${index + 1}`),
    name: `Court ${index + 1}`,
    sort_order: index + 1,
    is_active: true,
  }));
  if (courts.length > 0)
    check(await client.from("courts").upsert(courts), "saving courts");

  const random = createSeededRandom(SEED_RANDOM_SEED);
  const pick = <T,>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)];
  const members = Array.from({ length: options.members }, (_, index) => ({
    id: seedUuid(`member-${index + 1}`),
    first_name: pick(FIRST_NAMES),
    // The number keeps names unique so hosts can tell members apart in demos.
    last_name: `${pick(LAST_NAMES)} ${index + 1}`,
    skill_level: pick(SKILL_LEVELS),
    is_active: true,
  }));
  if (members.length > 0)
    check(await client.from("members").upsert(members), "saving members");

  const sessionId = seedUuid("draft-session");
  const existingSession = check(
    await client
      .from("sessions")
      .select("status")
      .eq("id", sessionId)
      .maybeSingle(),
    "reading the demo session",
  );
  if (existingSession && existingSession.status !== "draft") {
    fail(
      `the demo session is already ${existingSession.status}. Run \`pnpm db:reset\` for fresh demo data.`,
    );
  }
  const plannedStart = nextFullHour();
  check(
    await client.from("sessions").upsert({
      id: sessionId,
      host_id: hostUserId,
      name: "Evening social",
      location: "Riverside courts",
      host_name: SEED_HOST_DISPLAY_NAME,
      planned_start: plannedStart.toISOString(),
      planned_end: new Date(
        plannedStart.getTime() + 2 * 3_600_000,
      ).toISOString(),
    }),
    "saving the draft session (a host can have only one open session: cancel or end the other one first)",
  );

  const attendees = members.slice(0, options.attending).map((member) => ({
    id: seedUuid(`participant-${member.id}`),
    session_id: sessionId,
    member_id: member.id,
    is_guest: false,
    first_name: member.first_name,
    last_name: member.last_name,
    skill_level: member.skill_level,
  }));
  // Drop attendees from an earlier run with a larger --attending. The function
  // also withdraws a check-in approval that added one (a plain delete can't).
  const keptParticipantIds = new Set(attendees.map((attendee) => attendee.id));
  const existingParticipants = check(
    await client
      .from("session_participants")
      .select("id")
      .eq("session_id", sessionId),
    "reading earlier attendees",
  );
  for (const participant of existingParticipants ?? []) {
    if (keptParticipantIds.has(participant.id)) continue;
    check(
      await client.rpc("remove_draft_participant", {
        p_actor_user_id: hostUserId,
        p_session_participant_id: participant.id,
      }),
      "removing an earlier attendee",
    );
  }
  if (attendees.length > 0) {
    check(
      await client.from("session_participants").upsert(attendees),
      "saving attendees",
    );
  }

  const social = check(
    await client
      .from("socials")
      .select("name, checkin_tag")
      .eq("id", socialId)
      .single(),
    "reading the social's check-in tag",
  );
  if (!social) fail("the seed social is missing after saving it.");
  console.log(
    [
      `Seeded ${supabaseUrl}:`,
      `  social      "${social.name}"`,
      `  manager     ${SEED_HOST_EMAIL} (sign in with the email code from Mailpit)`,
      `  check-in    /t/${social.checkin_tag}`,
      `  courts      ${options.courts}`,
      `  members     ${options.members}`,
      `  session     "Evening social" (draft) with ${options.attending} attending`,
    ].join("\n"),
  );
}

await seed();
