// @vitest-environment node
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { playerMetrics, replay } from "@/engine/session";
import type { Database, Json } from "@/lib/database.types";
import type { DatabaseClient } from "@/server/sessionLog";
import { loadSessionLog } from "@/server/sessionLog";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import { DEFAULT_SESSION_DRAFT_CONFIG } from "../setup/setupRules";
import { startSimpleSession } from "../setup/startSimpleSession";
import { readLiveSession, writeLiveAction } from "./liveActions";
import { addLivePlayer } from "./liveAddPlayer";
import type { LiveCommand, LiveSessionView } from "./liveTypes";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
const actingAs = new AsyncLocalStorage<DatabaseClient>();
let defaultClient: DatabaseClient;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(
    async () => actingAs.getStore() ?? defaultClient,
  ),
}));
// Test hooks around the real write: run something just before it (another
// host acts first), or lose its answer after it landed.
let beforeSubmit: (() => Promise<void>) | null = null;
let loseAnswerOnce = false;
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
      const result = await actual.submitSessionAction(...args);
      if (loseAnswerOnce) {
        loseAnswerOnce = false;
        throw new Error("connection lost after the write landed");
      }
      return result;
    },
  };
});

// simple-social-v2 prepares through the system write path: same hooks.
vi.mock("@/server/nonHostSessionAction", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/nonHostSessionAction")>();
  return {
    ...actual,
    submitNonHostSessionAction: async (
      ...args: Parameters<typeof actual.submitNonHostSessionAction>
    ) => {
      if (beforeSubmit) {
        const run = beforeSubmit;
        beforeSubmit = null;
        await run();
      }
      const result = await actual.submitNonHostSessionAction(...args);
      if (loseAnswerOnce) {
        loseAnswerOnce = false;
        throw new Error("connection lost after the write landed");
      }
      return result;
    },
  };
});

function findLocalStack() {
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
    if (!["127.0.0.1", "localhost"].includes(new URL(status.API_URL).hostname))
      return null;
    return {
      apiUrl: status.API_URL,
      publishableKey: status.PUBLISHABLE_KEY,
      secretKey: status.SECRET_KEY,
    };
  } catch {
    return null;
  }
}
const localStack = findLocalStack();
if (!localStack && process.env.REQUIRE_LOCAL_SUPABASE === "1")
  throw new Error("REQUIRE_LOCAL_SUPABASE=1 but the local stack is down.");

describe.skipIf(!localStack)("automatic court preparation", () => {
  let admin: DatabaseClient;
  const users: string[] = [];
  const socials: string[] = [];

  async function signedInClient(email: string, password: string) {
    const client = createClient<Database>(
      localStack!.apiUrl,
      localStack!.publishableKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const login = await client.auth.signInWithPassword({ email, password });
    if (login.error) throw login.error;
    return client;
  }
  async function createHost(socialId: string) {
    const email = `auto-prepare-${randomUUID()}@example.test`;
    const password = `pw-${randomUUID()}`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    users.push(created.data.user.id);
    const row = await admin.from("hosts").insert({
      user_id: created.data.user.id,
      social_id: socialId,
      display_name: "Auto tester",
      role: "host",
    });
    if (row.error) throw row.error;
    return {
      id: created.data.user.id,
      client: await signedInClient(email, password),
    };
  }

  beforeAll(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", localStack!.apiUrl);
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      localStack!.publishableKey,
    );
    vi.stubEnv("SUPABASE_SECRET_KEY", localStack!.secretKey);
    admin = createClient<Database>(localStack!.apiUrl, localStack!.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });
  afterAll(async () => {
    await admin.from("hosts").delete().in("user_id", users);
    for (const id of users) await admin.auth.admin.deleteUser(id);
    const failures = await deleteTestSocials(admin, socials);
    vi.unstubAllEnvs();
    expect(failures).toEqual([]);
  });

  /** A new social with two hosts and a started session (genders: "M"/"F" per player). */
  async function scenario(courtCount: number, genders: string) {
    const social = await admin
      .from("socials")
      .insert({ name: "Integration auto prepare" })
      .select("id")
      .single();
    if (social.error) throw social.error;
    socials.push(social.data.id);
    const host = await createHost(social.data.id);
    const cohost = await createHost(social.data.id);
    const courtIds = Array.from({ length: courtCount }, () => randomUUID());
    const draft = await admin
      .from("sessions")
      .insert({
        social_id: social.data.id,
        host_id: host.id,
        name: "Auto prepare",
        host_name: "Auto tester",
        planned_start: "2026-11-14T10:00:00.000Z",
        planned_end: "2026-11-14T11:15:00.000Z",
        config_snapshot: {
          ...DEFAULT_SESSION_DRAFT_CONFIG,
          courts: courtIds.map((courtId, index) => ({
            courtId,
            name: `Court ${index + 1}`,
            format: "doubles",
          })),
        } as unknown as Json,
      })
      .select("id")
      .single();
    if (draft.error) throw draft.error;
    const sessionId = draft.data.id;
    const people = await admin
      .from("session_participants")
      .insert(
        [...genders].map((gender, index) => ({
          session_id: sessionId,
          social_id: social.data.id,
          first_name: `Player ${index}`,
          last_name: "Auto",
          gender: gender === "M" ? "male" : "female",
          skill_level: "intermediate" as const,
        })),
      )
      .select("id");
    if (people.error) throw people.error;
    defaultClient = host.client;
    expect(
      await startSimpleSession({
        sessionId,
        eventId: randomUUID(),
        expectedDraftRevision: 0,
      }),
    ).toMatchObject({ ok: true });
    const read = (
      client: DatabaseClient = host.client,
      prepareCourtId?: string,
    ): Promise<LiveSessionView> =>
      actingAs.run(client, async () => {
        const result = await readLiveSession({ sessionId, prepareCourtId });
        if (!result.ok || result.status !== "session")
          throw new Error(JSON.stringify(result));
        return result.session;
      });
    const write = async (
      command: LiveCommand,
      client: DatabaseClient = host.client,
    ) => {
      const current = await read(client);
      return actingAs.run(client, () =>
        writeLiveAction({
          sessionId,
          eventId: randomUUID(),
          expectedLastSeq: current.lastSeq,
          command,
        }),
      );
    };
    const events = async () =>
      (await loadSessionLog(host.client, sessionId))!.events;
    const calls = async () =>
      (await events()).filter((event) => event.type === "NextGroupCalled");
    return {
      socialId: social.data.id,
      host,
      cohost,
      sessionId,
      courtIds,
      participantIds: people.data.map((row) => row.id),
      read,
      write,
      events,
      calls,
    };
  }
  const seatsOf = (view: LiveSessionView) =>
    view.courts.flatMap((court) =>
      court.called ? [...court.called.teamA, ...court.called.teamB] : [],
    );

  it.each([
    [4, 4, 1],
    [7, 4, 1],
    [16, 4, 4],
  ])(
    "starts with %i eligible players and %i courts by preparing %i group(s), once, whatever the polling",
    async (players, courts, groups) => {
      const s = await scenario(courts, "M".repeat(players));
      const first = await s.read();
      expect(first.courts.filter((court) => court.called)).toHaveLength(groups);
      // Court order: the first courts are filled, the rest stay free.
      expect(first.courts.map((court) => !!court.called)).toEqual(
        s.courtIds.map((_, index) => index < groups),
      );
      const seats = seatsOf(first);
      expect(seats).toHaveLength(groups * 4);
      expect(new Set(seats).size).toBe(groups * 4);
      expect(
        first.players.filter((player) => player.status === "waiting"),
      ).toHaveLength(players);
      // Polling and reloading append nothing more, for either host.
      for (let poll = 0; poll < 3; poll += 1) {
        await s.read();
        await s.read(s.cohost.client);
      }
      expect(await s.calls()).toHaveLength(groups);
      expect((await s.read()).lastSeq).toBe(first.lastSeq);
      // Reserved is not playing: no match started, so no playing time.
      const replayed = replay(await s.events());
      if (!replayed.ok) throw new Error("replay");
      expect(Object.keys(replayed.state.matches)).toHaveLength(0);
      for (const metric of playerMetrics(replayed.state, Date.now()))
        expect(metric.playMs).toBe(0);
    },
  );

  it("an arrival that makes another group fills the next free court and leaves the prepared group alone", async () => {
    const s = await scenario(2, "MMMMMMM");
    const before = await s.read();
    expect(before.courts[0].called).not.toBeNull();
    expect(before.courts[1].called).toBeNull();
    const added = await actingAs.run(s.host.client, () =>
      addLivePlayer({
        sessionId: s.sessionId,
        eventId: randomUUID(),
        expectedLastSeq: before.lastSeq,
        firstName: "Late",
        lastName: "Arrival",
        skillLevel: "beginner",
        gender: "male",
      }),
    );
    expect(added).toMatchObject({ ok: true });
    const after = await s.read();
    expect(after.courts[1].called).not.toBeNull();
    expect(after.courts[0].called).toEqual(before.courts[0].called);
    expect(new Set(seatsOf(after)).size).toBe(8);
    expect(await s.calls()).toHaveLength(2);
  });

  it("a finished game prepares the next four for its court without a preparation step", async () => {
    const s = await scenario(1, "MMMMMMMM");
    const prepared = (await s.read()).courts[0].called!;
    const matchId = randomUUID();
    expect(
      await s.write({
        kind: "start",
        courtId: s.courtIds[0],
        calledEventId: prepared.calledEventId,
        matchId,
      }),
    ).toMatchObject({ ok: true });
    const playing = await s.read();
    expect(playing.courts[0].called).toBeNull(); // busy court: nothing prepared
    expect(await s.write({ kind: "finish", matchId })).toMatchObject({
      ok: true,
    });
    const next = (await s.read()).courts[0].called!;
    expect(next.calledEventId).not.toBe(prepared.calledEventId);
    const played = new Set([...prepared.teamA, ...prepared.teamB]);
    expect(
      [...next.teamA, ...next.teamB].some(
        (id) => id !== null && played.has(id),
      ),
    ).toBe(false);
    expect(await s.calls()).toHaveLength(2);
  });

  it("two hosts polling at once prepare each court exactly once, with distinct players", async () => {
    const s = await scenario(4, "M".repeat(16));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        s.read(index % 2 ? s.cohost.client : s.host.client),
      ),
    );
    const calls = await s.calls();
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((event) => event.eventId)).size).toBe(4);
    const final = await s.read();
    expect(new Set(seatsOf(final)).size).toBe(16);
    expect(final.courts.every((court) => court.called)).toBe(true);
  });

  it("a lost answer after the group landed is not repeated by the next poll", async () => {
    const s = await scenario(1, "MMMM");
    loseAnswerOnce = true;
    await s.read(); // still answers although the write's answer was lost
    expect(await s.calls()).toHaveLength(1); // the group did land
    await s.read();
    await s.read(s.cohost.client);
    expect(await s.calls()).toHaveLength(1);
    expect((await s.read()).courts[0].called).not.toBeNull();
  });

  it("a stale sequence writes nothing, and the next poll plans again from the new log", async () => {
    const s = await scenario(1, "MMMMM");
    const resting = s.participantIds[4];
    beforeSubmit = async () => {
      expect(
        await actingAs.run(s.cohost.client, () =>
          writeLiveAction({
            sessionId: s.sessionId,
            eventId: randomUUID(),
            expectedLastSeq: 1,
            command: { kind: "rest", participantId: resting },
          }),
        ),
      ).toMatchObject({ ok: true });
    };
    await s.read();
    expect(await s.calls()).toHaveLength(0); // the stale try wrote nothing
    const view = await s.read();
    expect(await s.calls()).toHaveLength(1);
    expect(seatsOf(view)).not.toContain(resting);
    expect(new Set(seatsOf(view)).size).toBe(4);
  });

  it("a host's Release group is respected by later polls", async () => {
    const s = await scenario(1, "MMMMMMMM");
    const prepared = (await s.read()).courts[0].called!;
    expect(
      await s.write({ kind: "release", calledEventId: prepared.calledEventId }),
    ).toMatchObject({ ok: true });
    const first = await s.read();
    await s.read(s.cohost.client);
    expect(first.courts[0].called).toBeNull();
    expect(await s.calls()).toHaveLength(1);
  });

  it("prepares nothing after the deadline, and never for another social's session", async () => {
    const s = await scenario(2, "M".repeat(8));
    const outsider = await admin
      .from("socials")
      .insert({ name: "Integration auto outsider" })
      .select("id")
      .single();
    if (outsider.error) throw outsider.error;
    socials.push(outsider.data.id);
    const stranger = await createHost(outsider.data.id);
    const readByStranger = await actingAs.run(stranger.client, () =>
      readLiveSession({ sessionId: s.sessionId }),
    );
    expect(!readByStranger.ok || readByStranger.status === "empty").toBe(true);
    expect(await s.calls()).toHaveLength(0);

    const started = replay(await s.events());
    if (!started.ok) throw new Error("replay");
    const deadline = started.state.startedAt! + 75 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(deadline + 1);
    try {
      const late = await s.read();
      expect(late.timeIsUp).toBe(true);
      expect(late.courts.every((court) => court.called === null)).toBe(true);
    } finally {
      clock.mockRestore();
    }
    expect(await s.calls()).toHaveLength(0);
  });
});
