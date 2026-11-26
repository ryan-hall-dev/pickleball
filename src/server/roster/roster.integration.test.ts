// @vitest-environment node
// The Reclub roster against the LOCAL Supabase stack (`pnpm db:start`): the
// host pastes the list; phones find their name and claim it with no
// approval; "That's my name" moves a taken name when the host agrees; a host
// checks in someone with no phone; walk-ins can be closed; claims in a live
// session write PlayerJoined as the player's own action. Each phone is a fake
// cookie jar with its own client IP. Skips when the stack isn't running,
// unless REQUIRE_LOCAL_SUPABASE=1.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { replay } from "@/engine/session";
import type { Database, Json } from "@/lib/database.types";
import {
  claimRosterEntry,
  readCheckinPage,
  requestRosterTransfer,
  searchRoster,
  submitCheckin,
} from "@/server/checkin/checkinActions";
import type {
  OpenCheckinPage,
  RosterSearchResult,
} from "@/server/checkin/checkinResults";
import { loadSessionLog, PLAYER_ACTOR_PREFIX } from "@/server/sessionLog";
import { DEFAULT_SESSION_DRAFT_CONFIG } from "@/server/setup/setupRules";
import { startSimpleSession } from "@/server/setup/startSimpleSession";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import {
  decideRosterTransfer,
  hostCheckInRosterEntry,
  importRosterPaste,
  readHostRoster,
  removeRosterEntry,
  setRosterEntryNote,
  setWalkInsOpen,
} from "./hostRosterActions";
import type { HostRoster } from "./hostRosterResults";

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

const RECLUB_PASTE = `🏓 Thursday Social
📅 Thu 27 Nov
Confirmed (6/16)
1. An Vo
2. Duy Ha (+1)
3. Minh Nguyen
4. Minh Nguyen
5. Sunny (Host)
6. Lan Dinh

Waitlist (1)
1. Oscar Bell`;

describe.skipIf(!localStack)("Reclub roster (local Supabase)", () => {
  let admin: DatabaseClient;
  let host: DatabaseClient;
  let hostUserId: string;
  let socialId: string;
  let checkinTag: string;
  let sessionId: string;
  const userIds: string[] = [];

  async function roster(): Promise<HostRoster> {
    actingClient = host;
    const result = await readHostRoster();
    if (!result.ok || !result.roster) throw new Error(JSON.stringify(result));
    return result.roster;
  }

  function entryNamed(current: HostRoster, label: string, twin = 1) {
    const entry = current.entries.find(
      (candidate) =>
        candidate.label.displayName === label &&
        candidate.label.twinNumber === twin,
    );
    if (!entry) throw new Error(`no roster entry ${label}`);
    return entry;
  }

  async function search(phone: FakePhone, query: string) {
    currentPhone = phone;
    const result = await searchRoster(checkinTag, { sessionId, query });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.results;
  }

  async function page(phone: FakePhone): Promise<OpenCheckinPage> {
    currentPhone = phone;
    const result = await readCheckinPage(checkinTag);
    if (!result.ok || result.page.status !== "open")
      throw new Error(JSON.stringify(result));
    return result.page;
  }

  async function claim(
    phone: FakePhone,
    rosterEntryId: string,
    guestName: { firstName: string; lastName: string } | null = null,
  ) {
    currentPhone = phone;
    return claimRosterEntry(checkinTag, {
      sessionId,
      rosterEntryId,
      skillLevel: "intermediate",
      gender: "female",
      guestName,
    });
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
    admin = createClient<Database>(localStack!.apiUrl, localStack!.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const social = await admin
      .from("socials")
      .insert({ name: "Integration roster social" })
      .select("id, checkin_tag")
      .single();
    if (social.error) throw social.error;
    socialId = social.data.id;
    checkinTag = social.data.checkin_tag;

    const email = `integration-roster-${randomUUID()}@example.test`;
    const password = `pw-${randomUUID()}`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    hostUserId = created.data.user.id;
    userIds.push(hostUserId);
    const hostRow = await admin.from("hosts").insert({
      user_id: hostUserId,
      social_id: socialId,
      display_name: "Roster Host",
      role: "manager",
    });
    if (hostRow.error) throw hostRow.error;
    host = createClient<Database>(
      localStack!.apiUrl,
      localStack!.publishableKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const login = await host.auth.signInWithPassword({ email, password });
    if (login.error) throw login.error;

    const draft = await admin
      .from("sessions")
      .insert({
        social_id: socialId,
        host_id: hostUserId,
        name: "Roster Thursday",
        host_name: "Roster Host",
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
  });

  afterAll(async () => {
    if (!admin) return;
    await deleteTestSocials(admin, [socialId]);
    await admin.from("hosts").delete().in("user_id", userIds);
    for (const id of userIds) await admin.auth.admin.deleteUser(id);
  });

  it("imports the Confirmed names once, numbering twins and adding the guest", async () => {
    actingClient = host;
    expect(
      await importRosterPaste({
        sessionId,
        pastedText: RECLUB_PASTE,
        expectedEntryCount: 0,
      }),
    ).toEqual({ ok: true, added: 7 });
    // The same paste again adds nobody; a stale count is refused.
    expect(
      await importRosterPaste({
        sessionId,
        pastedText: RECLUB_PASTE,
        expectedEntryCount: 7,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await importRosterPaste({
        sessionId,
        pastedText: "Phuc Ngo",
        expectedEntryCount: 0,
      }),
    ).toMatchObject({ ok: false, isConflict: true });

    const current = await roster();
    expect(current.entries.map((entry) => entry.label.displayName)).toEqual([
      "An Vo",
      "Duy Ha",
      null,
      "Minh Nguyen",
      "Minh Nguyen",
      "Sunny",
      "Lan Dinh",
    ]);
    expect(entryNamed(current, "Minh Nguyen", 2).label).toMatchObject({
      twinNumber: 2,
      twinCount: 2,
    });
    expect(current.entries[2]).toMatchObject({
      guestOfEntryId: entryNamed(current, "Duy Ha").rosterEntryId,
      label: { guestOfName: "Duy Ha", guestNumber: 1, guestCount: 1 },
    });
    expect(
      await setRosterEntryNote({
        sessionId,
        rosterEntryId: entryNamed(current, "Minh Nguyen", 2).rosterEntryId,
        hostNote: " red  paddle ",
      }),
    ).toEqual({ ok: true });
    expect(entryNamed(await roster(), "Minh Nguyen", 2).hostNote).toBe(
      "red paddle",
    );
  });

  it("finds names from 2 letters, at most 5, and never says who has arrived", async () => {
    const phone = newPhone();
    expect(await search(phone, "m")).toEqual([]);
    const minhs = await search(phone, "ngu");
    expect(minhs.map((result) => result.label.twinNumber)).toEqual([1, 2]);
    expect(minhs[1]).toMatchObject({
      hostNote: "red paddle",
      isInUse: false,
    });
    const duy = await search(phone, "duy");
    expect(duy.map((result) => result.label.displayName)).toEqual([
      "Duy Ha",
      null,
    ]);
    expect((await page(phone)).session).toMatchObject({
      hasRoster: true,
      walkInsOpen: true,
    });
  });

  it("checks a phone straight in as its name, once, and marks a taken twin in use", async () => {
    const phone = newPhone();
    const [minhOne] = await search(phone, "minh");
    expect(await claim(phone, minhOne!.rosterEntryId)).toEqual({
      ok: true,
      outcome: "claimed",
    });
    expect(await claim(phone, minhOne!.rosterEntryId)).toEqual({
      ok: true,
      outcome: "already_yours",
    });
    expect((await page(phone)).rosterClaim).toEqual({
      rosterEntryId: minhOne!.rosterEntryId,
      firstName: "Minh",
      lastName: "Nguyen",
    });
    const sunny = (await search(phone, "sun"))[0]!;
    expect(await claim(phone, sunny.rosterEntryId)).toEqual({
      ok: true,
      outcome: "phone_has_other_name",
    });

    const other = newPhone();
    const minhs = await search(other, "minh");
    expect(minhs.map((result) => result.isInUse)).toEqual([true, false]);
    expect(await claim(other, minhOne!.rosterEntryId)).toEqual({
      ok: true,
      outcome: "in_use",
    });
  });

  it("keeps one-word names as they are and asks a guest for their own name", async () => {
    const sunnyPhone = newPhone();
    const sunny = (await search(sunnyPhone, "sunny"))[0]!;
    expect(await claim(sunnyPhone, sunny.rosterEntryId)).toMatchObject({
      outcome: "claimed",
    });
    expect((await page(sunnyPhone)).rosterClaim).toMatchObject({
      firstName: "Sunny",
      lastName: "",
    });

    const guestPhone = newPhone();
    const guest = (await search(guestPhone, "duy")).find(
      (result: RosterSearchResult) => result.label.displayName === null,
    )!;
    expect(await claim(guestPhone, guest.rosterEntryId)).toEqual({
      ok: false,
      failure: "invalid_input",
    });
    expect(
      await claim(guestPhone, guest.rosterEntryId, {
        firstName: "Emma",
        lastName: "Reid",
      }),
    ).toMatchObject({ outcome: "claimed" });
    const guestEntry = (await roster()).entries[2]!;
    expect(guestEntry.participant).toMatchObject({
      firstName: "Emma",
      lastName: "Reid",
    });
    expect(guestEntry.hasPhone).toBe(true);
  });

  it("moves a taken name to the phone that asked, only when the host agrees", async () => {
    const firstPhone = newPhone();
    const secondPhone = newPhone();
    const an = (await search(firstPhone, "an v"))[0]!;
    await claim(firstPhone, an.rosterEntryId);

    currentPhone = secondPhone;
    expect(
      await requestRosterTransfer(checkinTag, {
        sessionId,
        rosterEntryId: an.rosterEntryId,
      }),
    ).toEqual({ ok: true, outcome: "requested" });
    expect((await page(secondPhone)).rosterTransferRequest).toMatchObject({
      status: "pending",
      label: { displayName: "An Vo" },
    });

    const request = (await roster()).transferRequests.find(
      (candidate) => candidate.rosterEntryId === an.rosterEntryId,
    )!;
    actingClient = host;
    expect(
      await decideRosterTransfer({
        transferRequestId: request.transferRequestId,
        shouldMove: true,
      }),
    ).toEqual({ ok: true });
    expect((await page(secondPhone)).rosterClaim?.firstName).toBe("An");
    expect((await page(firstPhone)).rosterClaim).toBeNull();
    // Deciding again changes nothing.
    expect(
      await decideRosterTransfer({
        transferRequestId: request.transferRequestId,
        shouldMove: false,
      }),
    ).toEqual({ ok: true });
    expect((await page(secondPhone)).rosterClaim?.firstName).toBe("An");
  });

  it("lets a host check in someone with no phone, and closes walk-ins", async () => {
    const current = await roster();
    const lan = entryNamed(current, "Lan Dinh");
    const participantId = randomUUID();
    actingClient = host;
    const checkIn = {
      sessionId,
      rosterEntryId: lan.rosterEntryId,
      participantId,
      eventId: randomUUID(),
      skillLevel: "beginner",
      gender: "female",
      guestName: null,
    };
    expect(await hostCheckInRosterEntry(checkIn)).toEqual({ ok: true });
    expect(await hostCheckInRosterEntry(checkIn)).toEqual({ ok: true });
    expect(entryNamed(await roster(), "Lan Dinh")).toMatchObject({
      hasPhone: false,
      participant: { participantId, firstName: "Lan", lastName: "Dinh" },
    });
    expect(
      await removeRosterEntry({ sessionId, rosterEntryId: lan.rosterEntryId }),
    ).toMatchObject({ ok: false, isConflict: true });

    expect(await setWalkInsOpen({ sessionId, walkInsOpen: false })).toEqual({
      ok: true,
    });
    currentPhone = newPhone();
    expect(
      await submitCheckin(checkinTag, {
        sessionId,
        firstName: "Walk",
        lastName: "In",
        skillLevel: "beginner",
        gender: "male",
      }),
    ).toEqual({ ok: false, failure: "walk_ins_closed" });
    actingClient = host;
    await setWalkInsOpen({ sessionId, walkInsOpen: true });
  });

  it("removes a name nobody has claimed", async () => {
    actingClient = host;
    await importRosterPaste({
      sessionId,
      pastedText: "Oscar Bell",
      expectedEntryCount: 7,
    });
    const oscar = entryNamed(await roster(), "Oscar Bell");
    expect(
      await removeRosterEntry({
        sessionId,
        rosterEntryId: oscar.rosterEntryId,
      }),
    ).toEqual({ ok: true });
    expect((await roster()).entries).toHaveLength(7);
  });

  it("after the start, a claim joins the live session as the player's own action", async () => {
    actingClient = host;
    const started = await startSimpleSession({
      sessionId,
      eventId: randomUUID(),
      expectedDraftRevision: 0,
    });
    expect(started).toMatchObject({ ok: true });

    const phone = newPhone();
    const [, minhTwo] = await search(phone, "minh");
    expect(await claim(phone, minhTwo!.rosterEntryId)).toMatchObject({
      outcome: "claimed",
    });
    const log = await loadSessionLog(host, sessionId);
    const joined = log!.events.at(-1)!;
    expect(joined.type).toBe("PlayerJoined");
    expect(joined.actorId.startsWith(PLAYER_ACTOR_PREFIX)).toBe(true);
    const replayed = replay(log!.events);
    expect(replayed.ok).toBe(true);

    // A host check-in in the live session is the host's action.
    const current = await roster();
    actingClient = host;
    expect(
      await hostCheckInRosterEntry({
        sessionId,
        rosterEntryId: entryNamed(current, "Duy Ha").rosterEntryId,
        participantId: randomUUID(),
        eventId: randomUUID(),
        skillLevel: "advanced",
        gender: "male",
        guestName: null,
      }),
    ).toEqual({ ok: true });
    const after = await loadSessionLog(host, sessionId);
    expect(after!.events.at(-1)).toMatchObject({
      type: "PlayerJoined",
      actorId: hostUserId,
    });
    expect(replay(after!.events).ok).toBe(true);
  });
});
