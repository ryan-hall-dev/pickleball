// @vitest-environment node
// A simple-social-v2 session from players' phones against the LOCAL Supabase
// stack (docs/plans/reclub-to-court-v1.md, Phase 2): the app prepares the
// courts by itself (recorded as the system), the four confirm on their
// phones, several "Game started" taps make one game, a rest frees one seat
// that the app refills, a stale reply is refused, and a player can never act
// for someone else. Skips when the stack isn't running, unless
// REQUIRE_LOCAL_SUPABASE=1.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { replay, type SessionState } from "@/engine/session";
import type { Database, Json } from "@/lib/database.types";
import { claimRosterEntry } from "@/server/checkin/checkinActions";
import { submitPlayerAction } from "@/server/checkin/playerActions";
import { readLiveSession } from "@/server/live/liveActions";
import {
  loadSessionLog,
  PLAYER_ACTOR_PREFIX,
  SYSTEM_ACTOR_ID,
} from "@/server/sessionLog";
import { DEFAULT_SESSION_DRAFT_CONFIG } from "@/server/setup/setupRules";
import { startSimpleSession } from "@/server/setup/startSimpleSession";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import {
  importRosterPaste,
  readHostRoster,
} from "@/server/roster/hostRosterActions";

type DatabaseClient = SupabaseClient<Database>;

interface FakePhone {
  cookieJar: Map<string, string>;
  clientIp: string;
}

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
let actingClient: DatabaseClient;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => actingClient),
}));
let currentPhone: FakePhone;
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = currentPhone.cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      currentPhone.cookieJar.set(name, value);
    },
  })),
  headers: vi.fn(
    async () => new Headers({ "x-forwarded-for": currentPhone.clientIp }),
  ),
}));

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
    if (
      !status.API_URL ||
      !["127.0.0.1", "localhost"].includes(new URL(status.API_URL).hostname)
    )
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
if (!localStack && process.env.REQUIRE_LOCAL_SUPABASE === "1") {
  throw new Error(
    "REQUIRE_LOCAL_SUPABASE=1 but the local Supabase stack is not reachable.",
  );
}

let phoneCounter = 0;
function newPhone(): FakePhone {
  phoneCounter += 1;
  return {
    cookieJar: new Map(),
    clientIp: `10.77.${phoneCounter}.${Math.floor(Math.random() * 250) + 1}`,
  };
}

/** Eight men and four women. */
const NAMES = [
  "Adam One",
  "Bao Two",
  "Cuong Three",
  "Dat Four",
  "Em Five",
  "Phong Six",
  "Gia Seven",
  "Hung Eight",
  "Lan Nine",
  "Mai Ten",
  "Ngoc Eleven",
  "Oanh Twelve",
];

describe.skipIf(!localStack)(
  "player actions in a v2 session (local Supabase)",
  () => {
    let admin: DatabaseClient;
    let host: DatabaseClient;
    let socialId: string;
    let checkinTag: string;
    let sessionId: string;
    const userIds: string[] = [];
    /** Phone and participant per name, after the claims. */
    const players = new Map<
      string,
      { phone: FakePhone; participantId: string }
    >();

    async function state(): Promise<SessionState> {
      const log = await loadSessionLog(admin, sessionId);
      const replayed = replay(log!.events);
      if (!replayed.ok) throw new Error("log does not replay");
      return replayed.state;
    }

    async function hostRead() {
      actingClient = host;
      const result = await readLiveSession({ sessionId });
      if (!result.ok) throw new Error(JSON.stringify(result));
    }

    function act(name: string, intent: string) {
      currentPhone = players.get(name)!.phone;
      return submitPlayerAction(checkinTag, {
        sessionId,
        eventId: randomUUID(),
        intent,
      });
    }

    function nameOf(participantId: string | null) {
      return [...players].find(
        ([, player]) => player.participantId === participantId,
      )?.[0];
    }

    beforeAll(async () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", localStack!.apiUrl);
      vi.stubEnv(
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        localStack!.publishableKey,
      );
      vi.stubEnv("SUPABASE_SECRET_KEY", localStack!.secretKey);
      vi.stubEnv(
        "CHECKIN_IP_HMAC_SECRET",
        "integration-test-secret-at-least-32-characters",
      );
      vi.spyOn(console, "error").mockImplementation(() => {});
      admin = createClient<Database>(
        localStack!.apiUrl,
        localStack!.secretKey,
        {
          auth: { persistSession: false, autoRefreshToken: false },
        },
      );
      const social = await admin
        .from("socials")
        .insert({ name: "Integration v2 players" })
        .select("id, checkin_tag")
        .single();
      if (social.error) throw social.error;
      socialId = social.data.id;
      checkinTag = social.data.checkin_tag;
      const email = `integration-v2-${randomUUID()}@example.test`;
      const password = `pw-${randomUUID()}`;
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error) throw created.error;
      userIds.push(created.data.user.id);
      const hostRow = await admin.from("hosts").insert({
        user_id: created.data.user.id,
        social_id: socialId,
        display_name: "V2 Host",
        role: "manager",
      });
      if (hostRow.error) throw hostRow.error;
      host = createClient<Database>(
        localStack!.apiUrl,
        localStack!.publishableKey,
        {
          auth: { persistSession: false, autoRefreshToken: false },
        },
      );
      const login = await host.auth.signInWithPassword({ email, password });
      if (login.error) throw login.error;
      const draft = await admin
        .from("sessions")
        .insert({
          social_id: socialId,
          host_id: created.data.user.id,
          name: "V2 Thursday",
          host_name: "V2 Host",
          planned_start: "2026-11-27T11:30:00.000Z",
          planned_end: "2026-11-27T14:00:00.000Z",
          config_snapshot: {
            ...DEFAULT_SESSION_DRAFT_CONFIG,
            courts: [
              { courtId: randomUUID(), name: "Court 7", format: "doubles" },
            ],
          } as unknown as Json,
        })
        .select("id")
        .single();
      if (draft.error) throw draft.error;
      sessionId = draft.data.id;

      actingClient = host;
      const imported = await importRosterPaste({
        sessionId,
        pastedText: NAMES.join("\n"),
        expectedEntryCount: 0,
      });
      if (!imported.ok) throw new Error(JSON.stringify(imported));
      const roster = await readHostRoster();
      if (!roster.ok || !roster.roster) throw new Error("no roster");
      for (const [index, entry] of roster.roster.entries.entries()) {
        const phone = newPhone();
        currentPhone = phone;
        const claimed = await claimRosterEntry(checkinTag, {
          sessionId,
          rosterEntryId: entry.rosterEntryId,
          skillLevel: "intermediate",
          gender: index < 8 ? "male" : "female",
          guestName: null,
        });
        if (!claimed.ok) throw new Error(JSON.stringify(claimed));
        players.set(entry.label.displayName!, { phone, participantId: "" });
      }
      actingClient = host;
      const started = await startSimpleSession({
        sessionId,
        eventId: randomUUID(),
        expectedDraftRevision: 0,
      });
      if (!started.ok) throw new Error(JSON.stringify(started));
      const live = await state();
      for (const participant of Object.values(live.participants)) {
        const name = `${participant.participant.firstName} ${participant.participant.lastName}`;
        players.get(name)!.participantId =
          participant.participant.participantId;
      }
    });

    afterAll(async () => {
      if (!admin) return;
      await deleteTestSocials(admin, [socialId]);
      await admin.from("hosts").delete().in("user_id", userIds);
      for (const id of userIds) await admin.auth.admin.deleteUser(id);
    });

    it("the app prepares the free court by itself, recorded as the system", async () => {
      await hostRead();
      await hostRead();
      const log = (await loadSessionLog(admin, sessionId))!.events;
      const calls = log.filter((event) => event.type === "NextGroupCalled");
      expect(calls).toHaveLength(1);
      expect(calls[0].actorId).toBe(SYSTEM_ACTOR_ID);
      expect(log[0].payload).toMatchObject({
        config: { policyVersion: "simple-social-v2", upNextAfterMinutes: 6 },
      });
    });

    it("a phone that hasn't checked in can't act", async () => {
      currentPhone = newPhone();
      expect(
        await submitPlayerAction(checkinTag, {
          sessionId,
          eventId: randomUUID(),
          intent: "confirm",
        }),
      ).toEqual({ ok: false, failure: "not_checked_in" });
    });

    it("a rest frees one seat, the app refills it, the stale reply is refused", async () => {
      const group = Object.values((await state()).courts)[0].nextGroup!;
      const seated = [...group.teamA, ...group.teamB].map((id) => nameOf(id)!);
      expect(await act(seated[0], "confirm")).toEqual({ ok: true });
      expect(await act(seated[0], "confirm")).toEqual({ ok: true }); // repeat tap
      expect(await act(seated[1], "takeBreak")).toEqual({ ok: true });
      const refilled = Object.values((await state()).courts)[0].nextGroup!;
      const seats = [...refilled.teamA, ...refilled.teamB];
      expect(seats).not.toContain(players.get(seated[1])!.participantId);
      expect(seats).not.toContain(null);
      expect(refilled.confirmedIds).toEqual([
        players.get(seated[0])!.participantId,
      ]);
      const log = (await loadSessionLog(admin, sessionId))!.events;
      expect(log.at(-2)).toMatchObject({
        type: "PlayerSkipped",
        actorId: `${PLAYER_ACTOR_PREFIX}${players.get(seated[1])!.participantId}`,
      });
      expect(log.at(-1)).toMatchObject({
        type: "NextGroupChanged",
        actorId: SYSTEM_ACTOR_ID,
      });
      // The rested player's late "I'm ready" no longer fits.
      expect(await act(seated[1], "confirm")).toEqual({
        ok: false,
        failure: "no_longer_possible",
      });
      expect(await act(seated[1], "readyAgain")).toEqual({ ok: true });
    });

    it("starts only when all four are ready; several taps make one game", async () => {
      const group = Object.values((await state()).courts)[0].nextGroup!;
      const names = [...group.teamA, ...group.teamB].map((id) => nameOf(id)!);
      expect(await act(names[0], "gameStarted")).toEqual({
        ok: false,
        failure: "no_longer_possible",
      });
      for (const name of names) await act(name, "confirm");
      const taps = await Promise.all(
        names.map((name) => act(name, "gameStarted")),
      );
      expect(taps.every((tap) => tap.ok)).toBe(true);
      const log = (await loadSessionLog(admin, sessionId))!.events;
      const starts = log.filter((event) => event.type === "MatchStarted");
      expect(starts).toHaveLength(1);
      expect(starts[0].actorId.startsWith(PLAYER_ACTOR_PREFIX)).toBe(true);
      expect(replay(log).ok).toBe(true);
    });

    it("the database refuses a player acting for someone else", async () => {
      const live = await state();
      const [first, second] = Object.values(live.participants).filter(
        (participant) => participant.activeMatchId === null,
      );
      const { error } = await admin.rpc("append_session_event_without_host", {
        p_session_id: sessionId,
        p_event_id: randomUUID(),
        p_expected_last_seq: live.lastSeq,
        p_type: "PlayerLeft",
        p_payload: { participantId: second.participant.participantId },
        p_occurred_at: new Date().toISOString(),
        p_actor_session_participant_id: first.participant.participantId,
      });
      expect(error?.message).toBe("ACTION_NOT_ALLOWED");
      const system = await admin.rpc("append_session_event_without_host", {
        p_session_id: sessionId,
        p_event_id: randomUUID(),
        p_expected_last_seq: live.lastSeq,
        p_type: "PlayerLeft",
        p_payload: { participantId: second.participant.participantId },
        p_occurred_at: new Date().toISOString(),
      });
      expect(system.error?.message).toBe("ACTION_NOT_ALLOWED");
    });
  },
);
