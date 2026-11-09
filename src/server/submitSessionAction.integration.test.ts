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

/** Creates a user and returns a client signed in as them. */
/** Auth users this run created; deleted (with their hosts rows) after all tests. */
const createdAuthUserIds: string[] = [];
const createdSocialIds: string[] = [];

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

// One fixed set of test members, reused by every run (members referenced by a
// session log can never be deleted, so new ones per run would pile up). The
// ids are reserved for this test.
const SHARED_MEMBER_ID_PREFIX = "7e570000-0000-4000-8000-0000000000";
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
  sessionId: string;
  config: SessionConfig;
}

/** A new host with a draft session of `playerCount` attending members on `courtCount` doubles courts. */
async function createHostedDraftSession(
  stack: LocalStack,
  admin: DatabaseClient,
  playerCount: number,
  courtCount: number,
): Promise<HostedDraftSession> {
  const hostUser = await signedInClient(stack, admin);
  // Each host gets its own social (sessions aren't scoped to socials until A3).
  const socialId = requireData(
    await admin
      .from("socials")
      .insert({ name: "Integration social" })
      .select("id")
      .single(),
    "Creating the social",
  ).id;
  createdSocialIds.push(socialId);
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
  const sessionId = requireData(
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
  const sharedMembers = PLAYER_FIRST_NAMES.slice(0, playerCount).map(
    (firstName, index) => ({
      id: `${SHARED_MEMBER_ID_PREFIX}${String(index + 1).padStart(2, "0")}`,
      first_name: firstName,
      last_name: "Tester",
      skill_level: "intermediate" as const,
    }),
  );
  // Create the shared members once; later runs leave the existing rows untouched.
  const upserted = await admin
    .from("members")
    .upsert(sharedMembers, { onConflict: "id", ignoreDuplicates: true });
  if (upserted.error) {
    throw new Error(`Creating members failed: ${upserted.error.message}`);
  }
  const members = sharedMembers;
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
      isGuest: false,
    })),
  };
  return { host: hostUser.client, sessionId, config };
}

function createAdminClient(stack: LocalStack): DatabaseClient {
  return createClient<Database>(stack.apiUrl, stack.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Deleting the auth users also deletes their hosts rows (on delete cascade);
// their sessions keep the history with host_id set to null. Then the emptied
// socials go.
afterAll(async () => {
  if (!localStack || createdAuthUserIds.length === 0) return;
  const admin = createAdminClient(localStack);
  const failures: string[] = [];
  for (const userId of createdAuthUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) failures.push(`${userId}: ${error.message}`);
  }
  if (createdSocialIds.length > 0) {
    const { error } = await admin
      .from("socials")
      .delete()
      .in("id", createdSocialIds);
    if (error) failures.push(`socials: ${error.message}`);
  }
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

describe.skipIf(!localStack)(
  "submitSessionAction undoing a match started with the session (local Supabase)",
  () => {
    let admin: DatabaseClient;
    let host: DatabaseClient;
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
      const state = await replayedState();
      let lastSeq = state.lastSeq;
      for (const match of Object.values(state.matches)) {
        if (match.status !== "active") continue;
        const abandoned = await submit({
          sessionId,
          eventId: randomUUID(),
          expectedLastSeq: lastSeq,
          request: {
            kind: "action",
            action: {
              type: "MatchAbandoned",
              payload: { matchId: match.matchId },
            },
          },
        });
        if (!abandoned.ok)
          throw new Error(`Cleanup abandon failed: ${abandoned.reason}`);
        lastSeq = abandoned.seq;
      }
      const ended = await submit({
        sessionId,
        eventId: randomUUID(),
        expectedLastSeq: lastSeq,
        request: {
          kind: "action",
          action: { type: "SessionEnded", payload: {} },
        },
      });
      if (!ended.ok) throw new Error(`Cleanup end failed: ${ended.reason}`);
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
  },
);
