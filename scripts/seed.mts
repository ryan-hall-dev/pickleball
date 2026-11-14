// Deterministic demo data for the LOCAL Supabase stack only.
//
//   pnpm seed --courts 4 --attending 16
//
// Creates (or updates in place, so it is safe to re-run) two independent socials:
//   1. "Riverside Pickleball Club", managed by host@example.test (an existing
//      host keeps their social), with courts and a draft session with players
//      (session participants: name and level, this session only). If that
//      social already has another open session, it is reused (a draft gets the
//      players, a live one is left alone).
//   2. "Riverside Morning Social", managed by manager2@example.test, with 2
//      courts and no session, for checking isolation by hand.
// Sign in with the email code from Mailpit. Every read and write is scoped by
// social_id, and the second social's seed ids are namespaced so they never
// collide with the first's. The demo draft is re-saved directly (dev only), so it
// does not bump draft_revision.
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY from the environment
// (.env.local is loaded automatically) and refuses any non-local URL.
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/database.types";

type DatabaseClient = SupabaseClient<Database>;
type SkillLevel = Database["public"]["Enums"]["skill_level"];

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SEED_RANDOM_SEED = 20261107;
const FIRST_MANAGER_EMAIL = "host@example.test";
const SECOND_MANAGER_EMAIL = "manager2@example.test";
const SECOND_SOCIAL_COURTS = 2;
const DEMO_SESSION_NAME = "Evening social";
const LIMITS = {
  courts: { min: 0, max: 50, default: 4 },
  attending: { min: 0, max: 500, default: 16 },
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
      courts: { type: "string" },
      attending: { type: "string" },
    },
    strict: true,
  });
  const courts = readCount(values, "courts");
  const attending = readCount(values, "attending");
  return { courts, attending };
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
function seedUuid(key: string, namespace: string | null): string {
  // The first social keeps its original keys, so re-runs on existing data update the same rows.
  const namespacedKey = namespace === null ? key : `${namespace}:${key}`;
  const hex = createHash("sha256")
    .update(`pickleball-seed:${namespacedKey}`)
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
  if (result.error)
    fail(`${what} failed: ${explainDatabaseFailure(result.error.message)}`);
  return result.data;
}

async function findUserIdByEmail(
  client: DatabaseClient,
  email: string,
): Promise<string | null> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) fail(`listing auth users failed: ${error.message}`);
    const existing = data.users.find((user) => user.email === email);
    if (existing) return existing.id;
    if (data.users.length < 1000) return null;
  }
}

async function findOrCreateHostUser(
  client: DatabaseClient,
  email: string,
): Promise<string> {
  const existingUserId = await findUserIdByEmail(client, email);
  if (existingUserId) return existingUserId;
  // Passwordless: hosts sign in with an email code (local codes arrive in Mailpit).
  const { data, error } = await client.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !data.user) fail(`creating ${email} failed: ${error?.message}`);
  return data.user.id;
}

/** The social a seed manager already hosts, or null. Read-only: creates and changes nothing. */
async function readExistingSocialId(
  client: DatabaseClient,
  email: string,
): Promise<string | null> {
  const userId = await findUserIdByEmail(client, email);
  if (!userId) return null;
  const host = check(
    await client
      .from("hosts")
      .select("social_id")
      .eq("user_id", userId)
      .maybeSingle(),
    `reading the host ${email}`,
  );
  return host?.social_id ?? null;
}

/** Turns a known database failure into advice; anything else is reported as is. */
function explainDatabaseFailure(message: string): string {
  if (message.includes("SOCIAL_ID_IMMUTABLE"))
    return `${message} (a seed row with that id already belongs to another social: remove the old seed rows or use a fresh database)`;
  if (message.includes("courts_social_name_lower_unique_idx"))
    return `${message} (the social already has a court with that name that isn't a seed court: rename or remove it)`;
  if (message.includes("session_participants_unique_name_per_session_idx"))
    return `${message} (the draft already has a player with a seed player's name who isn't a seed player: remove them in the app)`;
  return message;
}

function nextFullHour(): Date {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  return start;
}

interface SocialSeedPlan {
  /** Null for the first social (original ids); a label for any other. */
  namespace: string | null;
  socialName: string;
  managerEmail: string;
  managerDisplayName: string;
  courts: number;
  /** Null: no demo session for this social. */
  demoSession: { attending: number } | null;
  randomSeed: number;
}

interface SocialSeedSummary {
  socialId: string;
  socialName: string;
  managerEmail: string;
  checkinTag: string;
  courts: number;
  sessionLine: string;
}

interface SeedPlayer {
  /** Stable per player number; the participant id is derived from it. */
  playerKey: string;
  first_name: string;
  last_name: string;
  skill_level: SkillLevel;
}

/**
 * Seed player `n` (1-based): deterministic names and levels. The key is the
 * id the member-era seed gave player `n` ("member-n"), so re-running on a
 * database seeded before session-only participants updates the same
 * participant rows instead of adding clashing names.
 */
function seedPlayers(plan: SocialSeedPlan, count: number): SeedPlayer[] {
  const random = createSeededRandom(plan.randomSeed);
  const pick = <T,>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)];
  return Array.from({ length: count }, (_, index) => ({
    playerKey: seedUuid(`member-${index + 1}`, plan.namespace),
    first_name: pick(FIRST_NAMES),
    // The number keeps names unique (one name per session).
    last_name: `${pick(LAST_NAMES)} ${index + 1}`,
    skill_level: pick(SKILL_LEVELS),
  }));
}

async function findOrCreateSocial(
  client: DatabaseClient,
  plan: SocialSeedPlan,
): Promise<{ socialId: string; managerUserId: string }> {
  const managerUserId = await findOrCreateHostUser(client, plan.managerEmail);
  const existingHost = check(
    await client
      .from("hosts")
      .select("social_id")
      .eq("user_id", managerUserId)
      .maybeSingle(),
    `reading the host ${plan.managerEmail}`,
  );
  const socialId =
    existingHost?.social_id ??
    check(
      await client.rpc("create_social_with_manager", {
        p_name: plan.socialName,
        p_manager_user_id: managerUserId,
        p_manager_display_name: plan.managerDisplayName,
      }),
      `creating the social "${plan.socialName}"`,
    );
  if (!socialId) fail(`creating "${plan.socialName}" returned no id.`);
  check(
    await client
      .from("hosts")
      .update({ display_name: plan.managerDisplayName, role: "manager" })
      .eq("user_id", managerUserId)
      .eq("social_id", socialId),
    `saving the manager ${plan.managerEmail}`,
  );
  return { socialId, managerUserId };
}

/** Saves the demo draft (or reuses the social's open session). Returns what to tell the operator. */
async function seedDemoSession(
  client: DatabaseClient,
  plan: SocialSeedPlan,
  socialId: string,
  managerUserId: string,
  attending: number,
): Promise<string> {
  const demoSessionId = seedUuid("draft-session", plan.namespace);
  const participantKeyFor = (sessionIdForKey: string, playerKey: string) =>
    sessionIdForKey === demoSessionId
      ? `participant-${playerKey}`
      : `participant-${sessionIdForKey}-${playerKey}`;
  // One open session per social: reuse whichever one exists.
  const openSession = check(
    await client
      .from("sessions")
      .select("id, name, status")
      .eq("social_id", socialId)
      .in("status", ["draft", "live"])
      .maybeSingle(),
    "reading the social's open session",
  );
  if (openSession && openSession.status === "live") {
    return `"${openSession.name}" is live, so no demo draft was made (end it to get one)`;
  }
  const sessionId = openSession?.id ?? demoSessionId;
  if (!openSession) {
    const alreadyUsed = check(
      await client
        .from("sessions")
        .select("status")
        .eq("id", demoSessionId)
        .eq("social_id", socialId)
        .maybeSingle(),
      "reading the demo session",
    );
    if (alreadyUsed) {
      return `the demo session is already ${alreadyUsed.status} and the social has no open session, so no new draft was made (create one in the app)`;
    }
  }
  const sessionName = openSession?.name ?? DEMO_SESSION_NAME;
  if (!openSession || openSession.id === demoSessionId) {
    // First run, or a re-run: (re)save the demo draft with fresh times.
    const plannedStart = nextFullHour();
    check(
      await client.from("sessions").upsert({
        id: demoSessionId,
        social_id: socialId,
        host_id: managerUserId,
        name: DEMO_SESSION_NAME,
        location: "Riverside courts",
        host_name: plan.managerDisplayName,
        planned_start: plannedStart.toISOString(),
        planned_end: new Date(
          plannedStart.getTime() + 2 * 3_600_000,
        ).toISOString(),
      }),
      "saving the draft session",
    );
  }

  // Every player the seed could have added (up to the --attending limit), so
  // a re-run with a smaller --attending removes the extra ones.
  const allSeedPlayers = seedPlayers(plan, LIMITS.attending.max);
  const participantIdFor = (player: SeedPlayer) =>
    seedUuid(participantKeyFor(sessionId, player.playerKey), plan.namespace);
  const attendees = allSeedPlayers.slice(0, attending).map((player) => ({
    id: participantIdFor(player),
    session_id: sessionId,
    social_id: socialId,
    first_name: player.first_name,
    last_name: player.last_name,
    skill_level: player.skill_level,
  }));
  // Drop seeded players from an earlier run with a larger --attending. The
  // function also withdraws a check-in approval that added one (a plain
  // delete can't).
  const keptParticipantIds = new Set(attendees.map((attendee) => attendee.id));
  const seededParticipantIds = new Set(allSeedPlayers.map(participantIdFor));
  const existingParticipants = check(
    await client
      .from("session_participants")
      .select("id")
      .eq("session_id", sessionId)
      .eq("social_id", socialId),
    "reading earlier players",
  );
  for (const participant of existingParticipants ?? []) {
    // Only seeded players are touched: a reused draft may hold real ones.
    if (!seededParticipantIds.has(participant.id)) continue;
    if (keptParticipantIds.has(participant.id)) continue;
    check(
      await client.rpc("remove_draft_participant", {
        p_actor_user_id: managerUserId,
        p_session_participant_id: participant.id,
      }),
      "removing an earlier player",
    );
  }
  if (attendees.length > 0) {
    // By participant id: a re-run updates the same rows in place.
    check(
      await client.from("session_participants").upsert(attendees),
      "saving players",
    );
  }
  return `"${sessionName}" (draft) with ${attendees.length} seeded attending${openSession && openSession.id !== demoSessionId ? " (reused the social's existing draft)" : ""}`;
}

async function seedSocial(
  client: DatabaseClient,
  plan: SocialSeedPlan,
): Promise<SocialSeedSummary> {
  const { socialId, managerUserId } = await findOrCreateSocial(client, plan);

  const courts = Array.from({ length: plan.courts }, (_, index) => ({
    id: seedUuid(`court-${index + 1}`, plan.namespace),
    social_id: socialId,
    name: `Court ${index + 1}`,
    sort_order: index + 1,
    is_active: true,
  }));
  if (courts.length > 0)
    check(await client.from("courts").upsert(courts), "saving courts");

  const sessionLine = plan.demoSession
    ? await seedDemoSession(
        client,
        plan,
        socialId,
        managerUserId,
        plan.demoSession.attending,
      )
    : "none";

  const social = check(
    await client
      .from("socials")
      .select("name, checkin_tag")
      .eq("id", socialId)
      .single(),
    "reading the social's check-in tag",
  );
  if (!social) fail(`"${plan.socialName}" is missing after saving it.`);
  return {
    socialId,
    socialName: social.name,
    managerEmail: plan.managerEmail,
    checkinTag: social.checkin_tag,
    courts: plan.courts,
    sessionLine,
  };
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

  // Resolve both socials before changing anything: the two seed managers must
  // not share a social, or isolation couldn't be checked by hand.
  const firstExistingSocialId = await readExistingSocialId(
    client,
    FIRST_MANAGER_EMAIL,
  );
  const secondExistingSocialId = await readExistingSocialId(
    client,
    SECOND_MANAGER_EMAIL,
  );
  if (
    firstExistingSocialId !== null &&
    firstExistingSocialId === secondExistingSocialId
  ) {
    fail(
      `${FIRST_MANAGER_EMAIL} and ${SECOND_MANAGER_EMAIL} both host the same social (${firstExistingSocialId}). Nothing was changed. Remove one of the hosts rows first.`,
    );
  }

  const first = await seedSocial(client, {
    namespace: null,
    socialName: "Riverside Pickleball Club",
    managerEmail: FIRST_MANAGER_EMAIL,
    managerDisplayName: "Local Manager",
    courts: options.courts,
    demoSession: { attending: options.attending },
    randomSeed: SEED_RANDOM_SEED,
  });
  const second = await seedSocial(client, {
    namespace: "morning-social",
    socialName: "Riverside Morning Social",
    managerEmail: SECOND_MANAGER_EMAIL,
    managerDisplayName: "Morning Manager",
    courts: SECOND_SOCIAL_COURTS,
    demoSession: null,
    randomSeed: SEED_RANDOM_SEED + 1,
  });
  const describe = (summary: SocialSeedSummary) =>
    [
      `  social      "${summary.socialName}" (${summary.socialId})`,
      `  manager     ${summary.managerEmail} (sign in with the email code from Mailpit)`,
      `  check-in    /t/${summary.checkinTag}`,
      `  courts      ${summary.courts}`,
      `  session     ${summary.sessionLine}`,
    ].join("\n");
  console.log(
    `Seeded ${supabaseUrl}:\n${describe(first)}\n\n${describe(second)}`,
  );
}

await seed();
