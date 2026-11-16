// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { replay } from "@/engine/session";
import type { Database, Json } from "@/lib/database.types";
import * as adminClientModule from "@/lib/supabase/admin";
import { approveCheckin } from "@/server/checkin/hostCheckinActions";
import type { DatabaseClient } from "@/server/sessionLog";
import { loadSessionLog } from "@/server/sessionLog";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import { DEFAULT_SESSION_DRAFT_CONFIG } from "../setup/setupRules";
import { readLiveSession, writeLiveAction } from "./liveActions";
import type { LiveCommand, LiveSessionView } from "./liveTypes";
import { startSimpleSession } from "../setup/startSimpleSession";

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
    "Skipping live controls integration tests: the local Supabase stack is not running (start it with `pnpm db:start`).",
  );
}

describe.skipIf(!localStack)("simple live host controls", () => {
  let admin: DatabaseClient;
  let host: DatabaseClient;
  let otherHost: DatabaseClient;
  let signedOut: DatabaseClient;
  let nonHost: DatabaseClient;
  let sessionId: string;
  let socialId: string;
  const participantIds: string[] = [];
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
    for (const name of ["Integration simple live", "Integration other live"]) {
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
        name: "Live test",
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
      .insert(
        Array.from({ length: 8 }, (_, index) => ({
          session_id: sessionId,
          social_id: socialId,
          first_name: `Player ${index}`,
          last_name: "Live",
          gender: index < 4 ? "male" : "female",
          skill_level: "intermediate" as const,
        })),
      )
      .select("id");
    if (participant.error) throw participant.error;
    participantIds.push(...participant.data.map((row) => row.id));
    actingClient = host;
    expect(await startSimpleSession(input())).toMatchObject({ ok: true });
  });
  afterAll(async () => {
    await admin.from("hosts").delete().in("user_id", users);
    for (const id of users) await admin.auth.admin.deleteUser(id);
    const failures = await deleteTestSocials(admin, socials);
    vi.unstubAllEnvs();
    expect(failures).toEqual([]);
  });

  async function view(prepare = true): Promise<LiveSessionView> {
    const result = await readLiveSession({
      sessionId,
      ...(prepare ? { prepareCourtId: courtId } : {}),
    });
    if (!result.ok || result.status !== "session")
      throw new Error(JSON.stringify(result));
    return result.session;
  }
  async function write(
    command: LiveCommand,
    expectedLastSeq?: number,
    id = randomUUID(),
  ) {
    const current = await view();
    return writeLiveAction({
      sessionId,
      eventId: id,
      expectedLastSeq: expectedLastSeq ?? current.lastSeq,
      command,
    });
  }
  it("authorizes every read/write and rejects cross-social and stale changes", async () => {
    for (const client of [signedOut, nonHost, otherHost]) {
      actingClient = client;
      const read = await readLiveSession({ sessionId });
      expect(!read.ok || read.status === "empty").toBe(true);
      expect(
        await writeLiveAction({
          sessionId,
          eventId: randomUUID(),
          expectedLastSeq: 1,
          command: { kind: "end" },
        }),
      ).toMatchObject({ ok: false });
    }
    actingClient = host;
    expect(
      await write({ kind: "rest", participantId: participantIds[0] }, 999),
    ).toMatchObject({ ok: false, outcome: "conflict" });
    expect((await view()).lastSeq).toBe(1);
  });
  it("calls, starts, finishes separately, keeps retries idempotent and enforces hard teams", async () => {
    actingClient = host;
    const current = await view();
    expect(current.courts[0].suggestion).not.toBeNull();
    expect(
      await write({
        kind: "call",
        courtId,
        teamA: [participantIds[0], participantIds[1]],
        teamB: [participantIds[2], participantIds[4]],
      }),
    ).toMatchObject({ ok: false });
    const suggestion = current.courts[0].suggestion!;
    const callId = randomUUID();
    expect(
      await write(
        {
          kind: "call",
          courtId,
          teamA: suggestion.teamA as string[],
          teamB: suggestion.teamB as string[],
        },
        1,
        callId,
      ),
    ).toMatchObject({ ok: true });
    const called = await view();
    expect(
      called.players.filter((player) => player.status === "waiting"),
    ).toHaveLength(8);
    expect(called.courts[0].called?.calledEventId).toBe(callId);
    const startId = randomUUID();
    const start = {
      kind: "start" as const,
      courtId,
      calledEventId: callId,
      matchId: randomUUID(),
    };
    expect(await write(start, called.lastSeq, startId)).toMatchObject({
      ok: true,
      wasDuplicate: false,
    });
    expect(await write(start, called.lastSeq, startId)).toMatchObject({
      ok: true,
      wasDuplicate: true,
    });
    const playing = await view();
    expect(
      playing.players.filter((player) => player.status === "playing"),
    ).toHaveLength(4);
    expect(playing.courts[0].suggestion).not.toBeNull(); // Can prepare while occupied.
    const finishId = randomUUID();
    expect(
      await write(
        { kind: "finish", matchId: start.matchId },
        playing.lastSeq,
        finishId,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await write(
        { kind: "finish", matchId: start.matchId },
        playing.lastSeq,
        finishId,
      ),
    ).toMatchObject({ ok: true, wasDuplicate: true });
    const finished = await view();
    expect(finished.courts[0].activeMatch).toBeNull();
    expect(
      finished.players.filter((player) => player.status === "waiting"),
    ).toHaveLength(8);
    const state = replay((await loadSessionLog(host, sessionId))!.events);
    expect(state.ok && Object.values(state.state.matches)[0].status).toBe(
      "completed",
    );
  });
  it("rolls back a raced live approval and safely retries the same event exactly once", async () => {
    actingClient = host;
    const before = await view(false);
    const cohost = await user(socialId);
    const approvalEventId = randomUUID();
    const competingEventId = randomUUID();
    const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
    const request = await admin
      .from("checkin_requests")
      .insert({
        social_id: socialId,
        session_id: sessionId,
        first_name: "Approval",
        last_name: "Race",
        skill_level: "intermediate",
        gender: "female",
        device_token_hash: hash(),
        ip_hash: hash(),
      })
      .select("id")
      .single();
    expect(request.error).toBeNull();
    const requestId = request.data!.id;
    const readRequest = () =>
      admin
        .from("checkin_requests")
        .select("status, session_participant_id, decided_by")
        .eq("social_id", socialId)
        .eq("id", requestId)
        .single();
    const readAttendees = () =>
      admin
        .from("session_participants")
        .select("id")
        .eq("social_id", socialId)
        .eq("session_id", sessionId);
    let racePending = true;
    let databaseRefusal: string | undefined;
    const approvalClient = createClient<Database>(
      localStack!.apiUrl,
      localStack!.secretKey,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: async (input, init) => {
            const isApproval = String(input).endsWith("/rpc/approve_checkin");
            if (isApproval && racePending) {
              racePending = false;
              // Prevalidation has finished; advance the real log immediately
              // before sending the unchanged approval to PostgreSQL.
              actingClient = cohost.client;
              try {
                expect(
                  await writeLiveAction({
                    sessionId,
                    eventId: competingEventId,
                    expectedLastSeq: before.lastSeq,
                    command: { kind: "rest", participantId: participantIds[7] },
                  }),
                ).toMatchObject({ ok: true });
              } finally {
                actingClient = host;
              }
            }
            const response = await fetch(input, init);
            if (isApproval && !response.ok) {
              const error = (await response.clone().json()) as {
                message: string;
              };
              databaseRefusal = error.message;
            }
            return response;
          },
        },
      },
    );
    const factory = vi
      .spyOn(adminClientModule, "createSupabaseAdminClient")
      .mockReturnValue(approvalClient);
    try {
      const metadata = {
        eventId: approvalEventId,
        expectedLastSeq: before.lastSeq,
      };
      expect(await approveCheckin(requestId, undefined, metadata)).toEqual({
        kind: "session_changed",
      });
      expect(databaseRefusal).toBe("STALE_EXPECTED_SEQ");
      const pending = await readRequest();
      expect(pending.error).toBeNull();
      expect(pending.data).toEqual({
        status: "pending",
        session_participant_id: null,
        decided_by: null,
      });
      const refreshed = await view(false);
      expect(refreshed.lastSeq).toBe(before.lastSeq + 1);
      expect(refreshed.players).toHaveLength(before.players.length);
      const unchangedAttendees = await readAttendees();
      expect(unchangedAttendees.error).toBeNull();
      expect(unchangedAttendees.data!.map((row) => row.id).sort()).toEqual(
        [...participantIds].sort(),
      );
      const racedLog = (await loadSessionLog(host, sessionId))!.events;
      expect(racedLog.at(-1)).toMatchObject({
        eventId: competingEventId,
        actorId: cohost.id,
        type: "PlayerSkipped",
      });
      expect(racedLog.some((event) => event.eventId === approvalEventId)).toBe(
        false,
      );

      const approved = await approveCheckin(requestId, undefined, {
        ...metadata,
        expectedLastSeq: refreshed.lastSeq,
      });
      expect(approved).toMatchObject({ kind: "approved" });
      if (approved.kind !== "approved" || !approved.participant)
        throw new Error("The refreshed approval must return its participant.");
      const participantId = approved.participant.participantId;
      const savedRequest = await readRequest();
      expect(savedRequest.error).toBeNull();
      expect(savedRequest.data).toEqual({
        status: "approved",
        session_participant_id: participantId,
        decided_by: userId,
      });
      // A lost response retries the original UUID, even with a stale sequence.
      expect(await approveCheckin(requestId, undefined, metadata)).toEqual(
        approved,
      );
      const saved = await view(false);
      expect(saved.lastSeq).toBe(refreshed.lastSeq + 1);
      expect(saved.players).toHaveLength(before.players.length + 1);
      expect(
        saved.players.filter(
          (player) => player.participantId === participantId,
        ),
      ).toHaveLength(1);
      const savedAttendees = await readAttendees();
      expect(savedAttendees.error).toBeNull();
      expect(savedAttendees.data!.map((row) => row.id).sort()).toEqual(
        [...participantIds, participantId].sort(),
      );
      const joined = (await loadSessionLog(host, sessionId))!.events.filter(
        (event) => event.eventId === approvalEventId,
      );
      expect(joined).toHaveLength(1);
      expect(joined[0]).toMatchObject({
        seq: saved.lastSeq,
        type: "PlayerJoined",
        actorId: userId,
        payload: { participant: { participantId } },
      });
    } finally {
      factory.mockRestore();
      actingClient = host;
    }
  });
  it("rest freezes wait and ready restores it; deadline blocks calls/starts and end releases groups", async () => {
    const player = participantIds[0];
    expect(await write({ kind: "rest", participantId: player })).toMatchObject({
      ok: true,
    });
    const resting = await view();
    const restPlayer = resting.players.find(
      (candidate) => candidate.participantId === player,
    )!;
    expect(restPlayer.status).toBe("skipped");
    expect(restPlayer.returnsAt! - resting.now).toBeGreaterThan(590000);
    expect(
      await write({
        kind: "ready",
        participantId: player,
        targetSeq: restPlayer.skipSeq!,
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await view()).players.find(
        (candidate) => candidate.participantId === player,
      )?.status,
    ).toBe("waiting");
    const suggestion = (await view()).courts[0].suggestion!;
    const callId = randomUUID();
    expect(
      await write(
        {
          kind: "call",
          courtId,
          teamA: suggestion.teamA as string[],
          teamB: suggestion.teamB as string[],
        },
        undefined,
        callId,
      ),
    ).toMatchObject({ ok: true });
    const before = await view();
    const clock = vi.spyOn(Date, "now").mockReturnValue(before.deadline + 1);
    try {
      expect((await view()).timeIsUp).toBe(true);
      expect(
        await write({
          kind: "start",
          courtId,
          calledEventId: callId,
          matchId: randomUUID(),
        }),
      ).toMatchObject({
        ok: false,
        message: "Session time is up; finish the active games.",
        // A definitive engine refusal: the host carries on, nothing is retried.
        outcome: "rejected",
      });
    } finally {
      clock.mockRestore();
    }
    // Writes carry the real clock: the database refuses an occurred_at more
    // than five minutes from its own time, so End runs with the mock removed
    // (as it does in production, where only the deadline check reads the clock).
    expect(await write({ kind: "end" })).toMatchObject({ ok: true });
    const ended = await view();
    expect(ended.phase).toBe("ended");
    expect(ended.courts[0].called).toBeNull();
  });
});
