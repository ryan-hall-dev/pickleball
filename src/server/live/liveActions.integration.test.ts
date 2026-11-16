// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { playerMetrics, replay } from "@/engine/session";
import type { Database, Json } from "@/lib/database.types";
import * as adminClientModule from "@/lib/supabase/admin";
import { approveCheckin } from "@/server/checkin/hostCheckinActions";
import type { DatabaseClient } from "@/server/sessionLog";
import { loadSessionLog } from "@/server/sessionLog";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import { DEFAULT_SESSION_DRAFT_CONFIG } from "../setup/setupRules";
import { readLiveSession, writeLiveAction } from "./liveActions";
import { addLivePlayer } from "./liveAddPlayer";
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
  it("replaces only eligible valid players, interrupts without credit, and safely recovers starts/finishes", async () => {
    actingClient = host;
    const teams = {
      teamA: [participantIds[0], participantIds[4]],
      teamB: [participantIds[1], participantIds[5]],
    };
    async function startGame() {
      const callId = randomUUID();
      expect(
        await write({ kind: "call", courtId, ...teams }, undefined, callId),
      ).toMatchObject({ ok: true });
      const matchId = randomUUID();
      expect(
        await write({ kind: "start", courtId, calledEventId: callId, matchId }),
      ).toMatchObject({ ok: true });
      return { callId, matchId, startSeq: (await view()).lastSeq };
    }
    async function state() {
      const result = replay((await loadSessionLog(host, sessionId))!.events);
      if (!result.ok) throw new Error(result.error.message);
      return result.state;
    }
    const beforeGames = new Map(
      playerMetrics(await state(), Date.now()).map((player) => [
        player.participantId,
        player.gamesCompleted,
      ]),
    );
    const first = await startGame();
    expect(
      await write({
        kind: "replace",
        matchId: first.matchId,
        outId: participantIds[0],
        inId: participantIds[1],
      }),
    ).toMatchObject({ ok: false, outcome: "rejected" });
    const additionalFemale = (await view()).players.find(
      (player) =>
        player.gender === "female" &&
        !participantIds.includes(player.participantId),
    )!;
    const reserve = randomUUID();
    expect(
      await write(
        {
          kind: "call",
          courtId,
          teamA: [participantIds[2], participantIds[6]],
          teamB: [participantIds[3], additionalFemale.participantId],
        },
        undefined,
        reserve,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await write({
        kind: "replace",
        matchId: first.matchId,
        outId: participantIds[0],
        inId: participantIds[2],
      }),
    ).toMatchObject({
      ok: false,
      outcome: "rejected",
      message: expect.stringContaining("called"),
    });
    expect(
      await write({ kind: "release", calledEventId: reserve }),
    ).toMatchObject({ ok: true });
    expect(
      await write({
        kind: "replace",
        matchId: first.matchId,
        outId: participantIds[0],
        inId: participantIds[6],
      }),
    ).toMatchObject({ ok: false, outcome: "rejected" });
    const replacement = {
      kind: "replace" as const,
      matchId: first.matchId,
      outId: participantIds[0],
      inId: participantIds[2],
    };
    const replaceId = randomUUID();
    const beforeReplace = await view();
    expect(
      await write(replacement, beforeReplace.lastSeq, replaceId),
    ).toMatchObject({ ok: true });
    expect(
      await write(replacement, beforeReplace.lastSeq, replaceId),
    ).toMatchObject({ ok: true, wasDuplicate: true });
    const replaced = await state();
    const outgoing = replaced.matches[first.matchId].segments.find(
      (segment) => segment.participantId === participantIds[0],
    )!;
    const incoming = replaced.matches[first.matchId].segments.find(
      (segment) => segment.participantId === participantIds[2],
    )!;
    expect(outgoing.to).not.toBeNull();
    expect(outgoing.countGameForOut).toBe(false);
    expect(incoming.team).toBe(outgoing.team);
    expect(
      await write({ kind: "finish", matchId: first.matchId }),
    ).toMatchObject({ ok: true });
    const finished = await view();
    const finishSeq = finished.lastSeq;
    const metrics = playerMetrics(await state(), Date.now());
    expect(
      metrics.find((player) => player.participantId === participantIds[0])!
        .gamesCompleted,
    ).toBe(beforeGames.get(participantIds[0]));
    expect(
      metrics.find((player) => player.participantId === participantIds[2])!
        .gamesCompleted,
    ).toBe(beforeGames.get(participantIds[2])! + 1);
    expect(finished.undoOptions).toEqual([
      { courtId, matchId: first.matchId, targetSeq: finishSeq, kind: "finish" },
    ]);
    const undoId = randomUUID();
    expect(
      await write(
        { kind: "undo", targetSeq: finishSeq },
        finished.lastSeq,
        undoId,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await write(
        { kind: "undo", targetSeq: finishSeq },
        finished.lastSeq,
        undoId,
      ),
    ).toMatchObject({ ok: true, wasDuplicate: true });
    expect((await view()).courts[0].activeMatch?.matchId).toBe(first.matchId);
    expect(
      await write({ kind: "undo", targetSeq: first.startSeq }),
    ).toMatchObject({ ok: false, outcome: "rejected" });
    const interruptId = randomUUID();
    const beforeInterrupt = await view();
    expect(
      await write(
        { kind: "interrupt", matchId: first.matchId },
        beforeInterrupt.lastSeq,
        interruptId,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await write(
        { kind: "interrupt", matchId: first.matchId },
        beforeInterrupt.lastSeq,
        interruptId,
      ),
    ).toMatchObject({ ok: true, wasDuplicate: true });
    const interrupted = await state();
    const at = interrupted.matches[first.matchId].endedAt!;
    expect(interrupted.matches[first.matchId].status).toBe("abandoned");
    const afterMetrics = playerMetrics(interrupted, at);
    for (const id of [
      participantIds[2],
      participantIds[1],
      participantIds[4],
      participantIds[5],
    ]) {
      expect(
        afterMetrics.find((player) => player.participantId === id),
      ).toMatchObject({
        status: "waiting",
        currentWaitMs: 0,
        gamesCompleted: beforeGames.get(id),
      });
    }
    const row = await admin
      .from("matches")
      .select("status")
      .eq("session_id", sessionId)
      .eq("id", first.matchId)
      .single();
    expect(row.error).toBeNull();
    expect(row.data!.status).toBe("abandoned");
    expect((await view()).undoOptions).toEqual([]);

    const second = await startGame();
    const beforeUndoStart = await view();
    const undoStartId = randomUUID();
    expect(beforeUndoStart.undoOptions).toEqual([
      {
        courtId,
        matchId: second.matchId,
        targetSeq: second.startSeq,
        kind: "start",
      },
    ]);
    expect(
      await write(
        { kind: "undo", targetSeq: second.startSeq },
        beforeUndoStart.lastSeq,
        undoStartId,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await write(
        { kind: "undo", targetSeq: second.startSeq },
        beforeUndoStart.lastSeq,
        undoStartId,
      ),
    ).toMatchObject({ ok: true, wasDuplicate: true });
    expect((await view()).courts[0]).toMatchObject({
      activeMatch: null,
      called: { calledEventId: second.callId, ...teams },
    });
    expect((await view()).undoOptions).toEqual([]);
    expect(await write({ kind: "undo", targetSeq: 1 })).toMatchObject({
      ok: false,
      outcome: "rejected",
    });
    expect(
      await write({ kind: "undo", targetSeq: (await view()).lastSeq }),
    ).toMatchObject({ ok: false, outcome: "rejected" });
    expect(
      await write({ kind: "release", calledEventId: second.callId }),
    ).toMatchObject({ ok: true });
    const third = await startGame();
    expect(
      await write({ kind: "finish", matchId: third.matchId }),
    ).toMatchObject({ ok: true });
    const unsafeFinish = (await view()).lastSeq;
    expect(
      await write(
        { kind: "undo", targetSeq: unsafeFinish },
        unsafeFinish,
        undoId,
      ),
    ).toMatchObject({ ok: false, outcome: "rejected" });
    expect(
      await write({ kind: "rest", participantId: participantIds[0] }),
    ).toMatchObject({ ok: true });
    expect((await view()).undoOptions).toEqual([]);
    expect(
      await write({ kind: "undo", targetSeq: unsafeFinish }),
    ).toMatchObject({ ok: false, outcome: "rejected" });
    const resting = (await view()).players.find(
      (player) => player.participantId === participantIds[0],
    )!;
    expect(
      await write({
        kind: "ready",
        participantId: participantIds[0],
        targetSeq: resting.skipSeq!,
      }),
    ).toMatchObject({ ok: true });
    actingClient = otherHost;
    for (const command of [
      {
        kind: "replace",
        matchId: third.matchId,
        outId: participantIds[0],
        inId: participantIds[2],
      },
      { kind: "interrupt", matchId: third.matchId },
      { kind: "undo", targetSeq: unsafeFinish },
    ] satisfies LiveCommand[]) {
      expect(
        await writeLiveAction({
          sessionId,
          eventId: randomUUID(),
          expectedLastSeq: unsafeFinish,
          command,
        }),
      ).toMatchObject({ ok: false, outcome: "rejected" });
    }
    actingClient = host;
  });
  it("adds a manual player exactly once, never merges names, and refuses stale, foreign and clashing adds", async () => {
    actingClient = host;
    const before = await view(false);
    const addId = randomUUID();
    const walkIn = {
      sessionId,
      firstName: "Walk",
      lastName: "In",
      skillLevel: "beginner" as const,
      gender: "female" as const,
    };
    const add = (eventId: string, expectedLastSeq: number, extra = {}) =>
      addLivePlayer({ ...walkIn, ...extra, eventId, expectedLastSeq });
    // A double click sends the same write twice at once.
    const both = await Promise.all([
      add(addId, before.lastSeq),
      add(addId, before.lastSeq),
    ]);
    expect(both.every((result) => result.ok)).toBe(true);
    expect(
      both.filter((result) => result.ok && !result.wasDuplicate),
    ).toHaveLength(1);
    // A lost answer is retried later, with a sequence that is now stale.
    expect(await add(addId, before.lastSeq)).toMatchObject({
      ok: true,
      wasDuplicate: true,
    });
    const added = await view(false);
    expect(added.lastSeq).toBe(before.lastSeq + 1);
    expect(added.players).toHaveLength(before.players.length + 1);
    const walkIns = added.players.filter((player) => player.name === "Walk In");
    expect(walkIns).toHaveLength(1);
    expect(walkIns[0]).toMatchObject({ status: "waiting", gender: "female" });
    const rows = await admin
      .from("session_participants")
      .select("id, social_id")
      .eq("session_id", sessionId)
      .eq("first_name", "Walk");
    expect(rows.data).toEqual([
      { id: walkIns[0].participantId, social_id: socialId },
    ]);
    const events = (await loadSessionLog(host, sessionId))!.events.filter(
      (event) => event.eventId === addId,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("PlayerJoined");

    // The same name is never merged: it is refused, even respelled with spaces and case.
    expect(
      await add(randomUUID(), added.lastSeq, {
        firstName: "  walk ",
        lastName: "IN",
      }),
    ).toMatchObject({ ok: false, outcome: "rejected" });
    // A stale screen adds nobody.
    expect(
      await add(randomUUID(), before.lastSeq, {
        firstName: "Late",
        lastName: "Comer",
      }),
    ).toMatchObject({ ok: false, outcome: "conflict" });
    // Another social's host, a non-host and a signed-out caller change nothing.
    for (const client of [otherHost, nonHost, signedOut]) {
      actingClient = client;
      expect(
        await add(randomUUID(), added.lastSeq, {
          firstName: "Not",
          lastName: "Mine",
        }),
      ).toMatchObject({ ok: false });
    }
    actingClient = host;
    const final = await view(false);
    expect(final.lastSeq).toBe(added.lastSeq);
    expect(final.players).toHaveLength(added.players.length);
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
  it("stops waiting times at End and keeps them frozen on a much later reload; nobody can join afterwards", async () => {
    actingClient = host;
    const ended = await view(false);
    expect(ended.phase).toBe("ended");
    expect(ended.players.some((player) => player.currentWaitMs! > 0)).toBe(
      true,
    );
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(ended.now + 529 * 60_000);
    try {
      const reloaded = await view(false);
      expect(reloaded.phase).toBe("ended");
      expect(reloaded.endedAt).toBe(ended.endedAt);
      expect(reloaded.players.map((player) => player.currentWaitMs)).toEqual(
        ended.players.map((player) => player.currentWaitMs),
      );
    } finally {
      clock.mockRestore();
    }
    expect(
      await addLivePlayer({
        sessionId,
        eventId: randomUUID(),
        expectedLastSeq: ended.lastSeq,
        firstName: "After",
        lastName: "End",
        skillLevel: "beginner",
        gender: "male",
      }),
    ).toMatchObject({ ok: false, outcome: "rejected" });
  });
});
