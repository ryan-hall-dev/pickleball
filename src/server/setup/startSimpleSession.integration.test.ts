// @vitest-environment node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { replay, sessionClock } from "@/engine/session";
import type { Database, Json } from "@/lib/database.types";
import type { DatabaseClient } from "@/server/sessionLog";
import { loadSessionLog } from "@/server/sessionLog";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import { DEFAULT_SESSION_DRAFT_CONFIG } from "./setupRules";
import { startSimpleSession } from "./startSimpleSession";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
let actingClient: DatabaseClient;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => actingClient),
}));
let beforeSubmit: (() => Promise<void>) | null = null;
vi.mock("@/server/submitSessionAction", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/submitSessionAction")>();
  return {
    ...actual,
    submitSessionAction: async (
      ...args: Parameters<typeof actual.submitSessionAction>
    ) => {
      if (beforeSubmit) {
        const run = beforeSubmit;
        beforeSubmit = null;
        await run();
      }
      return actual.submitSessionAction(...args);
    },
  };
});

interface LocalStack {
  apiUrl: string;
  publishableKey: string;
  secretKey: string;
}

function findLocalStack(): LocalStack | null {
  try {
    const output = execFileSync(
      "node_modules/.bin/supabase",
      ["status", "-o", "json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 20_000,
      },
    );
    const status = JSON.parse(output.slice(output.indexOf("{"))) as Record<
      string,
      string
    >;
    const apiUrl = status.API_URL;
    if (
      !apiUrl ||
      !["127.0.0.1", "localhost"].includes(new URL(apiUrl).hostname)
    ) {
      return null;
    }
    return {
      apiUrl,
      publishableKey: status.PUBLISHABLE_KEY,
      secretKey: status.SECRET_KEY,
    };
  } catch {
    return null;
  }
}

const localStack = findLocalStack();
if (!localStack && process.env.REQUIRE_LOCAL_SUPABASE === "1") {
  throw new Error(
    "REQUIRE_LOCAL_SUPABASE=1 but the local Supabase stack is not reachable (`pnpm exec supabase status` failed).",
  );
}
if (!localStack) {
  console.warn(
    "Skipping submitSessionAction integration tests: the local Supabase stack is not running (start it with `pnpm db:start`).",
  );
}

describe.skipIf(!localStack)("hidden simple session start", () => {
  let admin: DatabaseClient;
  let host: DatabaseClient;
  let otherHost: DatabaseClient;
  let signedOut: DatabaseClient;
  let nonHost: DatabaseClient;
  let sessionId: string;
  let socialId: string;
  let participantId: string;
  let userId: string;
  const users: string[] = [];
  const socials: string[] = [];
  const eventId = randomUUID();
  const courtId = randomUUID();
  const plannedStart = "2026-11-14T10:00:00.000Z";
  const plannedEnd = "2026-11-14T11:15:00.000Z";
  const input = () => ({ sessionId, eventId, expectedDraftRevision: 0 });
  async function user(hostSocialId?: string) {
    const email = `simple-start-${randomUUID()}@example.test`;
    const password = `pw-${randomUUID()}`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    const id = created.data.user.id;
    users.push(id);
    if (hostSocialId) {
      const result = await admin.from("hosts").insert({
        user_id: id,
        social_id: hostSocialId,
        display_name: "Start tester",
        role: "host",
      });
      if (result.error) throw result.error;
    }
    const client = createClient<Database>(
      localStack!.apiUrl,
      localStack!.publishableKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const login = await client.auth.signInWithPassword({ email, password });
    if (login.error) throw login.error;
    return { client, id };
  }
  beforeAll(async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", localStack!.apiUrl);
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      localStack!.publishableKey,
    );
    vi.stubEnv("SUPABASE_SECRET_KEY", localStack!.secretKey);
    admin = createClient<Database>(localStack!.apiUrl, localStack!.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const name of [
      "Integration hidden simple start",
      "Integration hidden other start",
    ]) {
      const result = await admin
        .from("socials")
        .insert({ name })
        .select("id")
        .single();
      if (result.error) throw result.error;
      socials.push(result.data.id);
    }
    socialId = socials[0];
    const account = await user(socialId);
    host = account.client;
    userId = account.id;
    otherHost = (await user(socials[1])).client;
    nonHost = (await user()).client;
    signedOut = createClient<Database>(
      localStack!.apiUrl,
      localStack!.publishableKey,
    );
    const draft = await admin
      .from("sessions")
      .insert({
        social_id: socialId,
        host_id: userId,
        name: "Simple start",
        host_name: "Start tester",
        planned_start: plannedStart,
        planned_end: plannedEnd,
        config_snapshot: {
          ...DEFAULT_SESSION_DRAFT_CONFIG,
          courts: [{ courtId, name: "Court 1", format: "doubles" }],
        } as unknown as Json,
      })
      .select("id")
      .single();
    if (draft.error) throw draft.error;
    sessionId = draft.data.id;
    const participant = await admin
      .from("session_participants")
      .insert({
        session_id: sessionId,
        social_id: socialId,
        first_name: "First",
        last_name: "Player",
        gender: null,
        skill_level: null,
      })
      .select("id")
      .single();
    if (participant.error) throw participant.error;
    participantId = participant.data.id;
  });
  afterAll(async () => {
    await admin.from("hosts").delete().in("user_id", users);
    for (const id of users) await admin.auth.admin.deleteUser(id);
    const failures = await deleteTestSocials(admin, socials);
    vi.unstubAllEnvs();
    expect(failures).toEqual([]);
  });
  it("rejects non-hosts, signed-out users, another social and stale revisions", async () => {
    for (const client of [signedOut, nonHost, otherHost]) {
      actingClient = client;
      expect(await startSimpleSession(input())).toMatchObject({ ok: false });
    }
    actingClient = host;
    expect(
      await startSimpleSession({ ...input(), expectedDraftRevision: 1 }),
    ).toMatchObject({ ok: false, isConflict: true });
    expect((await loadSessionLog(host, sessionId))?.events).toEqual([]);
  });
  it("requires explicit gender and level before start", async () => {
    actingClient = host;
    expect(await startSimpleSession(input())).toMatchObject({
      ok: false,
      message: expect.stringContaining("gender and level"),
    });
    const updated = await admin
      .from("session_participants")
      .update({ gender: "male", skill_level: "intermediate" })
      .eq("id", participantId)
      .eq("social_id", socialId);
    expect(updated.error).toBeNull();
  });
  it("rejects a roster change between read and the atomic start", async () => {
    actingClient = host;
    beforeSubmit = async () => {
      const updated = await admin
        .from("session_participants")
        .update({ skill_level: "advanced" })
        .eq("id", participantId)
        .eq("social_id", socialId);
      expect(updated.error).toBeNull();
    };
    expect(await startSimpleSession(input())).toMatchObject({
      ok: false,
      isConflict: true,
    });
    expect((await loadSessionLog(host, sessionId))?.events).toEqual([]);
  });
  it("starts at the actual clock with a duration deadline and retries the stored result", async () => {
    actingClient = host;
    const before = Date.now();
    const started = await startSimpleSession(input());
    expect(started).toMatchObject({ ok: true, seq: 1, wasDuplicate: false });
    if (!started.ok) throw new Error(started.message);
    expect(started.occurredAt).toBeGreaterThanOrEqual(before);
    expect(started.occurredAt).toBeLessThanOrEqual(Date.now());
    const log = await loadSessionLog(host, sessionId);
    const result = replay(log!.events);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.state.config).toMatchObject({
      policyVersion: "simple-social-v1",
      plannedDurationMinutes: 75,
      courts: [{ courtId, name: "Court 1", format: "doubles" }],
    });
    expect(Object.keys(result.state.participants)).toHaveLength(1);
    expect(Object.keys(result.state.matches)).toHaveLength(0);
    expect(sessionClock(result.state, started.occurredAt).remainingMs).toBe(
      75 * 60_000,
    );
    const row = await admin
      .from("sessions")
      .select("started_at, planned_start, planned_end")
      .eq("id", sessionId)
      .single();
    expect(row.error).toBeNull();
    expect(Date.parse(row.data!.started_at!)).toBe(started.occurredAt);
    expect(Date.parse(row.data!.planned_start)).toBe(Date.parse(plannedStart));
    expect(Date.parse(row.data!.planned_end)).toBe(Date.parse(plannedEnd));
    expect(
      await startSimpleSession({ ...input(), expectedDraftRevision: 999 }),
    ).toEqual({ ...started, wasDuplicate: true });
    expect((await loadSessionLog(host, sessionId))?.events).toHaveLength(1);
  });
});
