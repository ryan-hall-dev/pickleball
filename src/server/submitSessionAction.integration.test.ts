// @vitest-environment node
// Integration test against the LOCAL Supabase stack (`pnpm db:start`). Skips
// with a message when the stack isn't running (e.g. CI's quality job), unless
// REQUIRE_LOCAL_SUPABASE=1, which makes a missing stack a failure.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { replay, type SessionConfig } from "@/engine/session";
import type { Database } from "@/lib/database.types";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import { loadSessionLog, type DatabaseClient } from "./sessionLog";
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

/** Auth users this run created; deleted (with their hosts rows) after all tests. */
const createdAuthUserIds: string[] = [];

/**
 * Fixed test socials, reused by every run (upserted by id): sessions with a
 * log can never be deleted, so a fresh social per run would pile up. The
 * hosts are new each run. Each social has at most one open session, and
 * this file uses each one sequentially.
 */
const TEST_SOCIAL = {
  id: "7e570000-0000-4000-8000-000000000001",
  name: "Integration social (tests)",
} as const;
const OTHER_TEST_SOCIAL = {
  id: "7e570000-0000-4000-8000-000000000002",
  name: "Integration other social (tests)",
} as const;
type TestSocial = typeof TEST_SOCIAL | typeof OTHER_TEST_SOCIAL;
const POSTGRES_UNIQUE_VIOLATION = "23505";

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
  createdAuthUserIds.push(userId);
  const client = createClient<Database>(stack.apiUrl, stack.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`Sign-in failed: ${signIn.error.message}`);
  return { client, userId };
}

// The players are guests: rows referenced by a session log can never be
// deleted, and guests add no members (and so nothing to a social's directory)
// on every run.
const PLAYER_FIRST_NAMES = [
  "Ines",
  "Otto",
  "Uma",
  "Elio",
  "Ada",
  "Ivo",
  "Ula",
  "Emil",
];

const ROTATION: SessionConfig["rotation"] = {
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
};

interface HostedDraftSession {
  host: DatabaseClient;
  hostUserId: string;
  socialId: string;
  sessionId: string;
  config: SessionConfig;
}

/** Another signed-in host of `socialId` (a co-host). */
async function addCoHost(
  stack: LocalStack,
  admin: DatabaseClient,
  socialId: string,
): Promise<{ client: DatabaseClient; userId: string }> {
  const coHost = await signedInClient(stack, admin);
  requireData(
    await admin
      .from("hosts")
      .insert({
        user_id: coHost.userId,
        display_name: "Integration Co-host",
        social_id: socialId,
      })
      .select()
      .single(),
    "Adding the co-host",
  );
  return coHost;
}

/**
 * Ends a live session the way a host would, through the engine: abandons any
 * match still in progress, then ends. `host` reads the log under RLS.
 */
async function endLiveSessionThroughEngine(
  host: DatabaseClient,
  admin: DatabaseClient,
  sessionId: string,
): Promise<void> {
  const submitAsHost = (input: SubmitSessionActionInput) =>
    submitSessionAction(host, input, { serviceRoleClient: admin });
  const log = await loadSessionLog(host, sessionId);
  if (!log) throw new Error(`Session ${sessionId} isn't readable by the host.`);
  const replayed = replay(log.events);
  if (!replayed.ok) throw new Error(replayed.error.message);
  let lastSeq = replayed.state.lastSeq;
  if (replayed.state.pausedBySeq !== null) {
    const resumed = await submitAsHost({
      sessionId,
      eventId: randomUUID(),
      expectedLastSeq: lastSeq,
      request: { kind: "action", action: { type: "Resumed", payload: {} } },
    });
    if (!resumed.ok) throw new Error(`Resuming failed: ${resumed.reason}`);
    lastSeq = resumed.seq;
  }
  for (const match of Object.values(replayed.state.matches)) {
    if (match.status !== "active") continue;
    const abandoned = await submitAsHost({
      sessionId,
      eventId: randomUUID(),
      expectedLastSeq: lastSeq,
      request: {
        kind: "action",
        action: { type: "MatchAbandoned", payload: { matchId: match.matchId } },
      },
    });
    if (!abandoned.ok)
      throw new Error(`Abandoning failed: ${abandoned.reason}`);
    lastSeq = abandoned.seq;
  }
  const ended = await submitAsHost({
    sessionId,
    eventId: randomUUID(),
    expectedLastSeq: lastSeq,
    request: { kind: "action", action: { type: "SessionEnded", payload: {} } },
  });
  if (!ended.ok) throw new Error(`Ending failed: ${ended.reason}`);
}

/**
 * Closes the social's open session left by an earlier run that stopped
 * early: a draft is cancelled, a live session is ended through the engine.
 */
async function closeStaleOpenSession(
  host: { client: DatabaseClient; userId: string },
  admin: DatabaseClient,
  socialId: string,
): Promise<void> {
  const stale = requireData(
    await admin
      .from("sessions")
      .select("id, status")
      .eq("social_id", socialId)
      .in("status", ["draft", "live"])
      .single(),
    "Reading the stale open session",
  );
  if (stale.status === "draft") {
    const { error } = await admin.rpc("cancel_draft_session", {
      p_actor_user_id: host.userId,
      p_session_id: stale.id,
    });
    if (error)
      throw new Error(`Cancelling the stale draft failed: ${error.message}`);
    return;
  }
  await endLiveSessionThroughEngine(host.client, admin, stale.id);
}

/**
 * A new host of `social` with the social's draft session of `playerCount`
 * attending guests on `courtCount` doubles courts.
 */
async function createHostedDraftSession(
  stack: LocalStack,
  admin: DatabaseClient,
  playerCount: number,
  courtCount: number,
  social: TestSocial = TEST_SOCIAL,
): Promise<HostedDraftSession> {
  const hostUser = await signedInClient(stack, admin);
  const socialId = requireData(
    await admin
      .from("socials")
      .upsert({ id: social.id, name: social.name }, { onConflict: "id" })
      .select("id")
      .single(),
    "Upserting the test social",
  ).id;
  requireData(
    await admin
      .from("hosts")
      .insert({
        user_id: hostUser.userId,
        display_name: "Integration Host",
        social_id: socialId,
      })
      .select()
      .single(),
    "Adding the host",
  );
  const insertDraft = () =>
    admin
      .from("sessions")
      .insert({
        social_id: socialId,
        host_id: hostUser.userId,
        name: "Integration social",
        host_name: "Integration Host",
        planned_start: new Date().toISOString(),
        planned_end: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      })
      .select("id")
      .single();
  let draftInsert = await insertDraft();
  if (draftInsert.error?.code === POSTGRES_UNIQUE_VIOLATION) {
    // One open session per social: an earlier run left one open.
    await closeStaleOpenSession(hostUser, admin, socialId);
    draftInsert = await insertDraft();
  }
  const sessionId = requireData(draftInsert, "Creating the draft session").id;
  const participants = requireData(
    await admin
      .from("session_participants")
      .insert(
        PLAYER_FIRST_NAMES.slice(0, playerCount).map((firstName) => ({
          session_id: sessionId,
          social_id: socialId,
          first_name: firstName,
          last_name: "Tester",
          skill_level: "intermediate" as const,
        })),
      )
      .select("id, first_name, last_name"),
    "Adding participants",
  );
  const config: SessionConfig = {
    courts: Array.from({ length: courtCount }, (_, index) => ({
      courtId: randomUUID(),
      name: `Court ${index + 1}`,
      format: "doubles" as const,
    })),
    targetMatchMinutes: 15,
    changeoverMinutes: 2,
    plannedDurationMinutes: 120,
    rotation: ROTATION,
    participants: participants.map((participant) => ({
      participantId: participant.id,
      firstName: participant.first_name,
      lastName: participant.last_name,
      skill: "intermediate",
    })),
  };
  return {
    host: hostUser.client,
    hostUserId: hostUser.userId,
    socialId,
    sessionId,
    config,
  };
}

function createAdminClient(stack: LocalStack): DatabaseClient {
  return createClient<Database>(stack.apiUrl, stack.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Deleting the auth users also deletes their hosts rows (on delete cascade);
// their sessions keep the history with host_id set to null. Then whatever of
// the fixed test socials can go (a social keeping logged sessions stays, to
// be reused by the next run).
afterAll(async () => {
  if (!localStack || createdAuthUserIds.length === 0) return;
  const admin = createAdminClient(localStack);
  const failures: string[] = [];
  for (const userId of createdAuthUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) failures.push(`${userId}: ${error.message}`);
  }
  failures.push(
    ...(await deleteTestSocials(admin, [TEST_SOCIAL.id, OTHER_TEST_SOCIAL.id])),
  );
  if (failures.length > 0) {
    throw new Error(`Cleaning up test users failed: ${failures.join("; ")}`);
  }
});

describe.skipIf(!localStack)("submitSessionAction (local Supabase)", () => {
  let admin: DatabaseClient;
  let host: DatabaseClient;
  let outsider: DatabaseClient;
  let sessionId: string;
  let config: SessionConfig;
  let courtId: string;
  const matchId = randomUUID();

  /** Submits as `client`, writing through the secret-key client like production code. */
  const submit = (client: DatabaseClient, input: SubmitSessionActionInput) =>
    submitSessionAction(client, input, { serviceRoleClient: admin });

  beforeAll(async () => {
    const stack = localStack!;
    admin = createAdminClient(stack);
    ({ host, sessionId, config } = await createHostedDraftSession(
      stack,
      admin,
      4,
      1,
    ));
    courtId = config.courts[0].courtId;
    outsider = (await signedInClient(stack, admin)).client;
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
    ).rejects.toThrow(
      /not found \(or it isn't your social's, or you are not a host\)/,
    );
  });

  it("refuses a host of another social: the session isn't found, and the database refuses it too", async () => {
    const otherSocial = await createHostedDraftSession(
      localStack!,
      admin,
      1,
      1,
      OTHER_TEST_SOCIAL,
    );
    await expect(
      submit(otherSocial.host, {
        sessionId,
        eventId: randomUUID(),
        expectedLastSeq: 4,
        request: { kind: "action", action: { type: "Paused", payload: {} } },
      }),
    ).rejects.toThrow(/not found/);

    // Even with a valid action and seq, the write function derives the
    // actor's social and finds no such session in it.
    const { error } = await admin.rpc("append_session_event", {
      p_actor_user_id: otherSocial.hostUserId,
      p_session_id: sessionId,
      p_event_id: randomUUID(),
      p_expected_last_seq: 4,
      p_type: "Paused",
      p_payload: {},
      p_occurred_at: new Date().toISOString(),
    });
    expect(error?.message).toBe("SESSION_NOT_FOUND");
    const log = await loadSessionLog(host, sessionId);
    expect(log?.events).toHaveLength(4);
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

describe.skipIf(!localStack)(
  "submitSessionAction undoing a match started with the session (local Supabase)",
  () => {
    let admin: DatabaseClient;
    let host: DatabaseClient;
    let socialId: string;
    let sessionId: string;
    let playerIds: string[];
    const firstMatchId = randomUUID();
    const secondMatchId = randomUUID();
    const undoEventId = randomUUID();

    const submit = (input: SubmitSessionActionInput) =>
      submitSessionAction(host, input, { serviceRoleClient: admin });

    async function replayedState() {
      const log = await loadSessionLog(host, sessionId);
      const replayed = replay(log!.events);
      if (!replayed.ok) throw new Error(replayed.error.message);
      return replayed.state;
    }

    beforeAll(async () => {
      const stack = localStack!;
      admin = createAdminClient(stack);
      const draft = await createHostedDraftSession(stack, admin, 8, 2);
      host = draft.host;
      socialId = draft.socialId;
      sessionId = draft.sessionId;
      playerIds = draft.config.participants.map(
        (participant) => participant.participantId,
      );
      const [firstCourt, secondCourt] = draft.config.courts;
      const started = await submit({
        sessionId,
        eventId: randomUUID(),
        expectedLastSeq: 0,
        request: {
          kind: "action",
          action: {
            type: "SessionStarted",
            payload: {
              config: draft.config,
              initialAttendeeIds: playerIds,
              initialMatches: [
                {
                  matchId: firstMatchId,
                  courtId: firstCourt.courtId,
                  teamA: playerIds.slice(0, 2),
                  teamB: playerIds.slice(2, 4),
                },
                {
                  matchId: secondMatchId,
                  courtId: secondCourt.courtId,
                  teamA: playerIds.slice(4, 6),
                  teamB: playerIds.slice(6, 8),
                },
              ],
            },
          },
        },
      });
      expect(started).toMatchObject({ ok: true, seq: 1 });
    });

    // End the session so no live session outlives the run: abandon any match
    // still in progress, then end. The rows themselves are append-only history.
    afterAll(async () => {
      await endLiveSessionThroughEngine(host, admin, sessionId);
    });

    it("refuses to undo a first match after a player was removed from it, pointing to abandon", async () => {
      const removal = await submit({
        sessionId,
        eventId: randomUUID(),
        expectedLastSeq: 1,
        request: {
          kind: "action",
          action: {
            type: "PlayerRemovedMidMatch",
            payload: {
              matchId: firstMatchId,
              participantId: playerIds[0],
              countGameForOut: false,
            },
          },
        },
      });
      expect(removal).toMatchObject({ ok: true, seq: 2 });

      const blocked = await submit({
        sessionId,
        eventId: randomUUID(),
        expectedLastSeq: 2,
        request: { kind: "undo", targetSeq: 1, matchId: firstMatchId },
      });
      expect(blocked).toMatchObject({
        ok: false,
        reason: "INVALID_ACTION",
        error: {
          code: "UNDO_BLOCKED",
          message: expect.stringMatching(/abandon/),
        },
      });
    });

    it("undoes one first match: it leaves the state and its players wait again", async () => {
      const undone = await submit({
        sessionId,
        eventId: undoEventId,
        expectedLastSeq: 2,
        request: { kind: "undo", targetSeq: 1, matchId: secondMatchId },
      });
      expect(undone).toMatchObject({ ok: true, seq: 3, wasDuplicate: false });

      const state = await replayedState();
      expect(state.matches[secondMatchId]).toBeUndefined();
      expect(state.matches[firstMatchId]).toBeDefined();
      for (const participantId of playerIds.slice(4, 8)) {
        expect(state.participants[participantId].activeMatchId).toBeNull();
        expect(
          state.participants[participantId].presence.at(-1)?.to,
        ).toBeNull();
      }
      const { data: matchRows } = await host
        .from("matches")
        .select("id")
        .eq("id", secondMatchId);
      expect(matchRows).toEqual([]);
    });

    it("recognises a retry of that undo as a duplicate", async () => {
      const retry = await submit({
        sessionId,
        eventId: undoEventId,
        expectedLastSeq: 2,
        request: { kind: "undo", targetSeq: 1, matchId: secondMatchId },
      });
      expect(retry).toMatchObject({ ok: true, seq: 3, wasDuplicate: true });
    });

    it("refuses the same event id for a different match", async () => {
      const reused = await submit({
        sessionId,
        eventId: undoEventId,
        expectedLastSeq: 3,
        request: { kind: "undo", targetSeq: 1, matchId: firstMatchId },
      });
      expect(reused).toMatchObject({
        ok: false,
        reason: "INVALID_ACTION",
        error: { code: "DUPLICATE_ID" },
      });
    });

    it("rejects undoing the same first match twice", async () => {
      const again = await submit({
        sessionId,
        eventId: randomUUID(),
        expectedLastSeq: 3,
        request: { kind: "undo", targetSeq: 1, matchId: secondMatchId },
      });
      expect(again).toMatchObject({
        ok: false,
        reason: "INVALID_ACTION",
        error: { code: "ALREADY_COMPENSATED" },
      });
    });

    it("lets a co-host of the social act on the same session", async () => {
      const coHost = await addCoHost(localStack!, admin, socialId);
      const lastSeq = (await replayedState()).lastSeq;
      const paused = await submitSessionAction(
        coHost.client,
        {
          sessionId,
          eventId: randomUUID(),
          expectedLastSeq: lastSeq,
          request: { kind: "action", action: { type: "Paused", payload: {} } },
        },
        { serviceRoleClient: admin },
      );
      expect(paused).toMatchObject({ ok: true, seq: lastSeq + 1 });
      const log = await loadSessionLog(host, sessionId);
      expect(log?.events.at(-1)).toMatchObject({
        type: "Paused",
        actorId: coHost.userId,
      });
      // The creator sees the co-host's action and carries on from it.
      const resumed = await submit({
        sessionId,
        eventId: randomUUID(),
        expectedLastSeq: lastSeq + 1,
        request: { kind: "action", action: { type: "Resumed", payload: {} } },
      });
      expect(resumed).toMatchObject({ ok: true, seq: lastSeq + 2 });
    });
  },
);
