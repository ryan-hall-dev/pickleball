// @vitest-environment node
// Integration test against the LOCAL Supabase stack (`pnpm db:start`). Skips
// with a message when the stack isn't running (e.g. CI's quality job), unless
// REQUIRE_LOCAL_SUPABASE=1, which makes a missing stack a failure.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionConfig } from "@/engine/session";
import type { Database } from "@/lib/database.types";
import type { DatabaseClient } from "./sessionLog";
import {
  submitSessionAction,
  type SubmitSessionActionInput,
} from "./submitSessionAction";

// Next.js resolves "server-only" itself; plain Vitest has no such module.
vi.mock("server-only", () => ({}));

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

function requireData<T>(
  result: { data: T; error: { message: string } | null },
  what: string,
): NonNullable<T> {
  if (result.error || result.data === null || result.data === undefined) {
    throw new Error(`${what} failed: ${result.error?.message ?? "no data"}`);
  }
  return result.data;
}

/** Creates a user and returns a client signed in as them. */
async function signedInClient(
  stack: LocalStack,
  admin: DatabaseClient,
): Promise<{ client: DatabaseClient; userId: string }> {
  const email = `integration-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = requireData(
    { data: created.data.user, error: created.error },
    "Creating a test user",
  ).id;
  const client = createClient<Database>(stack.apiUrl, stack.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`Sign-in failed: ${signIn.error.message}`);
  return { client, userId };
}

const PLAYER_NAMES: Array<[string, string]> = [
  ["Ines", "Tester"],
  ["Otto", "Tester"],
  ["Uma", "Tester"],
  ["Elio", "Tester"],
];

describe.skipIf(!localStack)("submitSessionAction (local Supabase)", () => {
  let admin: DatabaseClient;
  let host: DatabaseClient;
  let outsider: DatabaseClient;
  let sessionId: string;
  let config: SessionConfig;
  const courtId = randomUUID();
  const matchId = randomUUID();

  /** Submits as `client`, writing through the secret-key client like production code. */
  const submit = (client: DatabaseClient, input: SubmitSessionActionInput) =>
    submitSessionAction(client, input, { serviceRoleClient: admin });

  beforeAll(async () => {
    const stack = localStack!;
    admin = createClient<Database>(stack.apiUrl, stack.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const hostUser = await signedInClient(stack, admin);
    host = hostUser.client;
    outsider = (await signedInClient(stack, admin)).client;

    requireData(
      await admin
        .from("hosts")
        .insert({ user_id: hostUser.userId, display_name: "Integration Host" })
        .select()
        .single(),
      "Adding the host",
    );
    sessionId = requireData(
      await admin
        .from("sessions")
        .insert({
          host_id: hostUser.userId,
          name: "Integration social",
          host_name: "Integration Host",
          planned_start: new Date().toISOString(),
          planned_end: new Date(Date.now() + 2 * 3_600_000).toISOString(),
        })
        .select("id")
        .single(),
      "Creating the draft session",
    ).id;
    const members = requireData(
      await admin
        .from("members")
        .insert(
          PLAYER_NAMES.map(([firstName, lastName]) => ({
            first_name: firstName,
            last_name: lastName,
            skill_level: "intermediate" as const,
          })),
        )
        .select("id, first_name, last_name"),
      "Creating members",
    );
    const participants = requireData(
      await admin
        .from("session_participants")
        .insert(
          members.map((member) => ({
            session_id: sessionId,
            member_id: member.id,
            first_name: member.first_name,
            last_name: member.last_name,
            skill_level: "intermediate" as const,
          })),
        )
        .select("id, first_name, last_name"),
      "Adding participants",
    );

    config = {
      courts: [{ courtId, name: "Court 1", format: "doubles" }],
      targetMatchMinutes: 15,
      changeoverMinutes: 2,
      plannedDurationMinutes: 120,
      rotation: {
        objectiveOrder: [
          "equalGames",
          "shortestWaits",
          "playingTime",
          "fullCourts",
          "noBackToBack",
          "mixPartners",
        ],
        rules: {
          preventConsecutive: true,
          fewerGamesFirst: true,
          longestWaitFirst: true,
          mixPartners: true,
          minimiseRepeatOpponents: true,
          allowManualAssignments: true,
        },
      },
      participants: participants.map((participant) => ({
        participantId: participant.id,
        firstName: participant.first_name,
        lastName: participant.last_name,
        skill: "intermediate",
        isGuest: false,
      })),
    };
  });

  it("starts the session with its initial match atomically", async () => {
    const ids = config.participants.map(
      (participant) => participant.participantId,
    );
    const result = await submit(host, {
      sessionId,
      eventId: randomUUID(),
      expectedLastSeq: 0,
      request: {
        kind: "action",
        action: {
          type: "SessionStarted",
          payload: {
            config,
            initialAttendeeIds: ids,
            initialMatches: [
              { matchId, courtId, teamA: ids.slice(0, 2), teamB: ids.slice(2) },
            ],
          },
        },
      },
    });
    expect(result).toMatchObject({ ok: true, seq: 1, wasDuplicate: false });

    const session = requireData(
      await host
        .from("sessions")
        .select("status, last_seq")
        .eq("id", sessionId)
        .single(),
      "Reading the session",
    );
    expect(session).toEqual({ status: "live", last_seq: 1 });
  });

  it("returns the engine's error for an invalid action and writes nothing", async () => {
    const result = await submit(host, {
      sessionId,
      eventId: randomUUID(),
      expectedLastSeq: 1,
      request: {
        kind: "action",
        action: { type: "MatchCompleted", payload: { matchId: randomUUID() } },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "INVALID_ACTION",
      error: { code: "UNKNOWN_MATCH" },
    });
  });

  it("rejects malformed input before touching the database", async () => {
    const result = await submit(host, {
      sessionId: "not-a-uuid",
      eventId: randomUUID(),
      expectedLastSeq: 1,
      request: { kind: "undo", targetSeq: 1 },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "INVALID_ACTION",
      error: { code: "MALFORMED_EVENT" },
    });
  });

  let completionEventId: string;

  it("completes a match and writes its matches row in the same transaction", async () => {
    completionEventId = randomUUID();
    const result = await submit(host, {
      sessionId,
      eventId: completionEventId,
      expectedLastSeq: 1,
      request: {
        kind: "action",
        action: { type: "MatchCompleted", payload: { matchId } },
      },
    });
    expect(result).toMatchObject({ ok: true, seq: 2, wasDuplicate: false });

    const match = requireData(
      await host
        .from("matches")
        .select("status, court_name, team_a, team_b, ended_at")
        .eq("id", matchId)
        .single(),
      "Reading the match",
    );
    expect(match.status).toBe("completed");
    expect(match.court_name).toBe("Court 1");
    expect(match.team_a).toHaveLength(2);
    expect(match.team_b).toHaveLength(2);
    expect(match.ended_at).not.toBeNull();
  });

  it("returns the original result when the same event_id is retried with a stale seq", async () => {
    const result = await submit(host, {
      sessionId,
      eventId: completionEventId,
      expectedLastSeq: 1,
      request: {
        kind: "action",
        action: { type: "MatchCompleted", payload: { matchId } },
      },
    });
    expect(result).toMatchObject({ ok: true, seq: 2, wasDuplicate: true });
  });

  it("refuses an event_id reused for a different action", async () => {
    const result = await submit(host, {
      sessionId,
      eventId: completionEventId,
      expectedLastSeq: 2,
      request: { kind: "action", action: { type: "Paused", payload: {} } },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "INVALID_ACTION",
      error: { code: "DUPLICATE_ID" },
    });
  });

  it("reports UPDATED_BY_ANOTHER_HOST for a stale expected seq", async () => {
    const result = await submit(host, {
      sessionId,
      eventId: randomUUID(),
      expectedLastSeq: 1,
      request: { kind: "action", action: { type: "Paused", payload: {} } },
    });
    expect(result).toEqual({ ok: false, reason: "UPDATED_BY_ANOTHER_HOST" });
  });

  let undoEventId: string;

  it("undoes the completion and marks the matches row reverted", async () => {
    undoEventId = randomUUID();
    const result = await submit(host, {
      sessionId,
      eventId: undoEventId,
      expectedLastSeq: 2,
      request: { kind: "undo", targetSeq: 2 },
    });
    expect(result).toMatchObject({ ok: true, seq: 3, wasDuplicate: false });

    const match = requireData(
      await host
        .from("matches")
        .select("status, ended_at")
        .eq("id", matchId)
        .single(),
      "Reading the match",
    );
    expect(match).toEqual({ status: "reverted", ended_at: null });
  });

  it("treats a retried undo as a duplicate, but not the same id undoing another action", async () => {
    const retry = await submit(host, {
      sessionId,
      eventId: undoEventId,
      expectedLastSeq: 2,
      request: { kind: "undo", targetSeq: 2 },
    });
    expect(retry).toMatchObject({ ok: true, seq: 3, wasDuplicate: true });

    const otherTarget = await submit(host, {
      sessionId,
      eventId: undoEventId,
      expectedLastSeq: 3,
      request: { kind: "undo", targetSeq: 1 },
    });
    expect(otherTarget).toMatchObject({
      ok: false,
      reason: "INVALID_ACTION",
      error: { code: "DUPLICATE_ID" },
    });
  });

  it("lets exactly one of two simultaneous actions on the same seq win", async () => {
    const results = await Promise.all(
      [0, 1].map(() =>
        submit(host, {
          sessionId,
          eventId: randomUUID(),
          expectedLastSeq: 3,
          request: {
            kind: "action",
            action: { type: "SuggestionsShuffled", payload: { seed: 7 } },
          },
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "UPDATED_BY_ANOTHER_HOST" },
    ]);
  });

  it("refuses a signed-in user who is not a host", async () => {
    await expect(
      submit(outsider, {
        sessionId,
        eventId: randomUUID(),
        expectedLastSeq: 4,
        request: { kind: "action", action: { type: "Paused", payload: {} } },
      }),
    ).rejects.toThrow(/not found \(or you are not a host\)/);
  });

  it("refuses to end while a match is in progress, then ends after it completes", async () => {
    const blocked = await submit(host, {
      sessionId,
      eventId: randomUUID(),
      expectedLastSeq: 4,
      request: {
        kind: "action",
        action: { type: "SessionEnded", payload: {} },
      },
    });
    expect(blocked).toMatchObject({
      ok: false,
      reason: "INVALID_ACTION",
      error: { code: "MATCHES_IN_PROGRESS" },
    });

    const abandoned = await submit(host, {
      sessionId,
      eventId: randomUUID(),
      expectedLastSeq: 4,
      request: {
        kind: "action",
        action: { type: "MatchAbandoned", payload: { matchId } },
      },
    });
    expect(abandoned).toMatchObject({ ok: true, seq: 5 });

    const ended = await submit(host, {
      sessionId,
      eventId: randomUUID(),
      expectedLastSeq: 5,
      request: {
        kind: "action",
        action: { type: "SessionEnded", payload: {} },
      },
    });
    expect(ended).toMatchObject({ ok: true, seq: 6 });

    const session = requireData(
      await host
        .from("sessions")
        .select("status, last_seq")
        .eq("id", sessionId)
        .single(),
      "Reading the session",
    );
    expect(session).toEqual({ status: "ended", last_seq: 6 });
    const match = requireData(
      await host.from("matches").select("status").eq("id", matchId).single(),
      "Reading the match",
    );
    expect(match.status).toBe("abandoned");
  });
});
