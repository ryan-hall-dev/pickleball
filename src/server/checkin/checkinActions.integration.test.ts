// @vitest-environment node
// The public check-in page's server actions against the LOCAL Supabase stack
// (`pnpm db:start`): the page read (inactive link, nothing open, open),
// phone recognition only for a linked device, the submit privacy rule (only
// the member's own linked phone hears "already checked in"), one pending
// request per phone, the rate-limit mapping, another social's member refused,
// the device cookie (only its hash reaches the database), and no table or
// function access with the publishable (anon) key. Each phone is a fake
// cookie jar with its own client IP. Skips when the stack isn't running,
// unless REQUIRE_LOCAL_SUPABASE=1. Everything deletable is removed afterwards.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import { deleteTestSocials } from "@/server/testing/deleteTestSocials";
import {
  ensureCheckinDevice,
  readCheckinPage,
  searchCheckinNames,
  submitCheckin,
} from "./checkinActions";
import type { OpenCheckinPage } from "./checkinResults";

type DatabaseClient = SupabaseClient<Database>;

interface FakePhone {
  cookieJar: Map<string, string>;
  lastCookieOptions: Record<string, unknown> | null;
  clientIp: string;
}

// Next.js resolves these itself; plain Vitest runs the actions outside a
// request, as whichever phone `currentPhone` is.
vi.mock("server-only", () => ({}));
let currentPhone: FakePhone;
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => {
      const value = currentPhone.cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, options: Record<string, unknown>) => {
      currentPhone.cookieJar.set(name, value);
      currentPhone.lastCookieOptions = options;
    },
  })),
  headers: vi.fn(
    async () => new Headers({ "x-forwarded-for": currentPhone.clientIp }),
  ),
}));

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
    "Skipping check-in integration tests: the local Supabase stack is not running (start it with `pnpm db:start`).",
  );
}

const DEVICE_COOKIE_NAME = "checkin_device";
const UNKNOWN_TAG = `zz${randomUUID().replace(/-/g, "")}`;
let phoneCounter = 0;

function newPhone(): FakePhone {
  phoneCounter += 1;
  // A fresh network per phone, so the per-IP limits never trip across tests.
  const octets = randomUUID().replace(/-/g, "").slice(0, 4);
  return {
    cookieJar: new Map(),
    lastCookieOptions: null,
    clientIp: `10.${phoneCounter % 250}.${parseInt(octets.slice(0, 2), 16)}.${parseInt(octets.slice(2), 16)}`,
  };
}

function actAsPhone(phone: FakePhone) {
  currentPhone = phone;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe.skipIf(!localStack)("public check-in actions (local Supabase)", () => {
  let admin: DatabaseClient;
  const createdUserIds: string[] = [];
  const createdSocialIds: string[] = [];
  let managerUserId: string;
  let riversideTag: string;
  let quietSocialTag: string;
  let riversideSessionId: string;
  const memberIds: Record<string, string> = {};
  let otherSocialMemberId: string;

  async function createTestSocial(name: string) {
    const { data, error } = await admin
      .from("socials")
      .insert({ name })
      .select("id, checkin_tag")
      .single();
    if (error) throw error;
    createdSocialIds.push(data.id);
    return data;
  }

  async function insertMember(
    socialId: string,
    firstName: string,
    lastName: string,
    skillLevel: "beginner" | "intermediate" | "advanced" | null = null,
  ): Promise<string> {
    const { data, error } = await admin
      .from("members")
      .insert({
        social_id: socialId,
        first_name: firstName,
        last_name: lastName,
        skill_level: skillLevel,
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async function approve(checkinRequestId: string) {
    const { data, error } = await admin.rpc("approve_checkin", {
      p_actor_user_id: managerUserId,
      p_checkin_request_id: checkinRequestId,
      p_session_participant_id: randomUUID(),
    });
    if (error) throw error;
    return data;
  }

  async function pendingRequestId(
    phone: FakePhone,
    input: Parameters<typeof submitCheckin>[1],
  ): Promise<string> {
    actAsPhone(phone);
    const result = await submitCheckin(riversideTag, input);
    if (!result.ok || result.outcome.status !== "pending") {
      throw new Error(
        `expected a pending request, got ${JSON.stringify(result)}`,
      );
    }
    return result.outcome.checkinRequestId;
  }

  function memberInput(name: "grace" | "peter" | "penny") {
    const names = {
      grace: ["Grace", "Kim"],
      peter: ["Peter", "Lindqvist"],
      penny: ["Penny", "Ward"],
    } as const;
    return {
      kind: "member" as const,
      memberId: memberIds[name],
      firstName: names[name][0],
      lastName: names[name][1],
      updatedSkillLevel: null,
    };
  }

  async function openPageFor(phone: FakePhone): Promise<OpenCheckinPage> {
    actAsPhone(phone);
    const result = await readCheckinPage(riversideTag);
    if (!result.ok || result.page.status !== "open") {
      throw new Error(`expected an open page, got ${JSON.stringify(result)}`);
    }
    return result.page;
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

    const riverside = await createTestSocial("Integration check-in Riverside");
    riversideTag = riverside.checkin_tag;
    const quietSocial = await createTestSocial("Integration check-in quiet");
    quietSocialTag = quietSocial.checkin_tag;
    const otherSocial = await createTestSocial("Integration check-in other");

    const created = await admin.auth.admin.createUser({
      email: `integration-checkin-${randomUUID()}@example.test`,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    managerUserId = created.data.user.id;
    createdUserIds.push(managerUserId);
    const { error: hostError } = await admin.from("hosts").insert({
      user_id: managerUserId,
      display_name: "Check-in Manager",
      role: "manager",
      social_id: riverside.id,
    });
    if (hostError) throw hostError;

    memberIds.grace = await insertMember(
      riverside.id,
      "Grace",
      "Kim",
      "beginner",
    );
    memberIds.peter = await insertMember(riverside.id, "Peter", "Lindqvist");
    memberIds.penny = await insertMember(riverside.id, "Penny", "Ward");
    for (const [firstName, lastName] of [
      ["Pedro", "Alves"],
      ["Petra", "Novák"],
      ["Pearl", "Jones"],
      ["Élodie", "Durand"],
    ]) {
      await insertMember(riverside.id, firstName, lastName);
    }
    const { error: inactiveError } = await admin.from("members").insert({
      social_id: riverside.id,
      first_name: "Pete",
      last_name: "Retired",
      is_active: false,
    });
    if (inactiveError) throw inactiveError;
    otherSocialMemberId = await insertMember(otherSocial.id, "Peter", "Other");

    const plannedStart = new Date(Date.now() + 30 * 60_000);
    const { data: session, error: sessionError } = await admin
      .from("sessions")
      .insert({
        social_id: riverside.id,
        host_id: managerUserId,
        name: "Integration Saturday Social",
        host_name: "Check-in Manager",
        planned_start: plannedStart.toISOString(),
        planned_end: new Date(
          plannedStart.getTime() + 120 * 60_000,
        ).toISOString(),
        config_snapshot: {
          courts: [{ courtId: randomUUID() }, { courtId: randomUUID() }],
        },
      })
      .select("id")
      .single();
    if (sessionError) throw sessionError;
    riversideSessionId = session.id;
  });

  afterAll(async () => {
    // Test-only cleanup with the secret key.
    await admin.from("hosts").delete().in("user_id", createdUserIds);
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
    await deleteTestSocials(admin, createdSocialIds);
    vi.unstubAllEnvs();
  });

  describe("readCheckinPage", () => {
    it("answers inactive for an unknown or malformed tag, revealing nothing", async () => {
      actAsPhone(newPhone());
      for (const tag of [UNKNOWN_TAG, "short", 42, "../admin"]) {
        expect(await readCheckinPage(tag)).toEqual({
          ok: true,
          page: { status: "inactive" },
        });
      }
    });

    it("answers no open session with only the social's name", async () => {
      actAsPhone(newPhone());
      expect(await readCheckinPage(quietSocialTag)).toEqual({
        ok: true,
        page: {
          status: "no_open_session",
          socialName: "Integration check-in quiet",
        },
      });
    });

    it("shows the open session's header, and nothing about a phone without a cookie", async () => {
      const page = await openPageFor(newPhone());
      expect(page).toMatchObject({
        status: "open",
        socialName: "Integration check-in Riverside",
        session: {
          name: "Integration Saturday Social",
          courtsCount: 2,
          checkedInCount: expect.any(Number),
        },
        recognisedMember: null,
        currentRequest: null,
      });
      expect(Date.parse(page.now)).not.toBeNaN();
      // Reading never creates the device cookie.
      expect(currentPhone.cookieJar.size).toBe(0);
    });
  });

  describe("searchCheckinNames", () => {
    it("lists nothing (and sets no cookie) before 2 letters", async () => {
      actAsPhone(newPhone());
      expect(await searchCheckinNames(riversideTag, "P")).toEqual({
        ok: true,
        matches: [],
      });
      expect(await searchCheckinNames(riversideTag, " é ")).toEqual({
        ok: true,
        matches: [],
      });
      expect(currentPhone.cookieJar.size).toBe(0);
    });

    it("lists at most 5 active members of this social, names only", async () => {
      actAsPhone(newPhone());
      const result = await searchCheckinNames(riversideTag, "pe");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches).toHaveLength(5);
      for (const match of result.matches) {
        expect(Object.keys(match).sort()).toEqual([
          "firstName",
          "lastName",
          "memberId",
        ]);
      }
      const names = result.matches.map(
        (match) => `${match.firstName} ${match.lastName}`,
      );
      expect(names).not.toContain("Pete Retired");
      expect(names).not.toContain("Peter Other");
    });

    it("matches accent-insensitively, by last name too", async () => {
      actAsPhone(newPhone());
      expect(await searchCheckinNames(riversideTag, "elo")).toMatchObject({
        ok: true,
        matches: [{ firstName: "Élodie", lastName: "Durand" }],
      });
      expect(await searchCheckinNames(riversideTag, "NOVAK")).toMatchObject({
        ok: true,
        matches: [{ firstName: "Petra" }],
      });
      expect(await searchCheckinNames(riversideTag, "pe1")).toEqual({
        ok: true,
        matches: [],
      });
    });

    it("tells an inactive link from a social with nothing open", async () => {
      actAsPhone(newPhone());
      expect(await searchCheckinNames(UNKNOWN_TAG, "pe")).toEqual({
        ok: false,
        failure: "inactive",
      });
      expect(await searchCheckinNames(quietSocialTag, "pe")).toEqual({
        ok: false,
        failure: "no_open_session",
      });
    });

    it("sets an HttpOnly, Secure, SameSite=Lax device cookie on /t", async () => {
      const phone = newPhone();
      actAsPhone(phone);
      await searchCheckinNames(riversideTag, "gr");
      expect(phone.cookieJar.get(DEVICE_COOKIE_NAME)).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
      expect(phone.lastCookieOptions).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/t",
      });
      // The same phone keeps its token.
      const firstToken = phone.cookieJar.get(DEVICE_COOKIE_NAME);
      phone.lastCookieOptions = null;
      await searchCheckinNames(riversideTag, "gra");
      expect(phone.cookieJar.get(DEVICE_COOKIE_NAME)).toBe(firstToken);
      expect(phone.lastCookieOptions).toBeNull();
    });
  });

  describe("submitCheckin", () => {
    it("recognises only the phone linked by an approval, and stores only the token's hash", async () => {
      const gracePhone = newPhone();
      const requestId = await pendingRequestId(
        gracePhone,
        memberInput("grace"),
      );

      const { data: requestRow, error } = await admin
        .from("checkin_requests")
        .select("device_token_hash, ip_hash, status")
        .eq("id", requestId)
        .single();
      if (error) throw error;
      const deviceToken = gracePhone.cookieJar.get(DEVICE_COOKIE_NAME)!;
      expect(requestRow.device_token_hash).toBe(sha256Hex(deviceToken));
      expect(requestRow.device_token_hash).not.toContain(deviceToken);
      expect(requestRow.ip_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(requestRow.ip_hash).not.toBe(sha256Hex(gracePhone.clientIp));

      // Before approval: waiting, and not yet recognised.
      expect(await openPageFor(gracePhone)).toMatchObject({
        recognisedMember: null,
        currentRequest: { checkinRequestId: requestId, status: "pending" },
      });

      await approve(requestId);
      expect(await openPageFor(gracePhone)).toMatchObject({
        recognisedMember: {
          memberId: memberIds.grace,
          firstName: "Grace",
          lastName: "Kim",
          skillLevel: "beginner",
        },
        currentRequest: { checkinRequestId: requestId, status: "approved" },
      });

      // Another phone recognises nobody and sees no request.
      expect(await openPageFor(newPhone())).toMatchObject({
        recognisedMember: null,
        currentRequest: null,
      });
    });

    it("answers already checked in only to the member's own linked phone", async () => {
      // Approving Peter's request links his phone and makes him attending.
      const peterPhone = newPhone();
      await approve(await pendingRequestId(peterPhone, memberInput("peter")));

      actAsPhone(peterPhone);
      expect(await submitCheckin(riversideTag, memberInput("peter"))).toEqual({
        ok: true,
        outcome: { status: "already_checked_in" },
      });

      // Any other phone naming Peter just waits, like any request: a submit
      // never tells a phone who is checked in.
      const strangerPhone = newPhone();
      const strangerRequestId = await pendingRequestId(
        strangerPhone,
        memberInput("peter"),
      );
      expect(await openPageFor(strangerPhone)).toMatchObject({
        recognisedMember: null,
        currentRequest: {
          checkinRequestId: strangerRequestId,
          status: "pending",
          firstName: "Peter",
        },
      });

      // A host closes it as already checked in: that phone sees the outcome
      // (P09b) and is still not linked to Peter (D-C).
      const { error: closeError } = await admin.rpc(
        "close_checkin_already_checked_in",
        {
          p_actor_user_id: managerUserId,
          p_checkin_request_id: strangerRequestId,
        },
      );
      if (closeError) throw closeError;
      expect(await openPageFor(strangerPhone)).toMatchObject({
        recognisedMember: null,
        currentRequest: {
          checkinRequestId: strangerRequestId,
          status: "already_checked_in",
        },
      });
    });

    it("returns the same pending request when the same phone submits twice", async () => {
      const phone = newPhone();
      const firstRequestId = await pendingRequestId(
        phone,
        memberInput("peter"),
      );
      const secondRequestId = await pendingRequestId(phone, {
        kind: "guest",
        firstName: "Peter",
        lastName: "Changed",
        skillLevel: "advanced",
      });
      expect(secondRequestId).toBe(firstRequestId);

      const { data, error } = await admin
        .from("checkin_requests")
        .select("id")
        .eq("session_id", riversideSessionId)
        .eq(
          "device_token_hash",
          sha256Hex(phone.cookieJar.get(DEVICE_COOKIE_NAME)!),
        )
        .eq("status", "pending");
      if (error) throw error;
      expect(data).toEqual([{ id: firstRequestId }]);
    });

    it("sends a guest with an optional level change kept for the host", async () => {
      const phone = newPhone();
      const requestId = await pendingRequestId(phone, {
        kind: "guest",
        firstName: "  Kai ",
        lastName: "Moreno",
        skillLevel: "intermediate",
      });
      const { data, error } = await admin
        .from("checkin_requests")
        .select("member_id, first_name, last_name, skill_level")
        .eq("id", requestId)
        .single();
      if (error) throw error;
      expect(data).toEqual({
        member_id: null,
        first_name: "Kai",
        last_name: "Moreno",
        skill_level: "intermediate",
      });

      const pennyPhone = newPhone();
      const pennyRequestId = await pendingRequestId(pennyPhone, {
        ...memberInput("penny"),
        updatedSkillLevel: "advanced",
      });
      const { data: pennyRow } = await admin
        .from("checkin_requests")
        .select("member_id, skill_level")
        .eq("id", pennyRequestId)
        .single();
      expect(pennyRow).toEqual({
        member_id: memberIds.penny,
        skill_level: "advanced",
      });
    });

    it("returns the guest form's field errors without calling the database", async () => {
      const phone = newPhone();
      actAsPhone(phone);
      expect(
        await submitCheckin(riversideTag, {
          kind: "guest",
          firstName: "",
          lastName: "Moreno",
          skillLevel: null,
        }),
      ).toEqual({
        ok: false,
        failure: "invalid_input",
        fieldErrors: {
          firstName: "Enter your first name",
          lastName: undefined,
          skillLevel: "Choose your level",
        },
      });
      expect(phone.cookieJar.size).toBe(0);
    });

    it("refuses another social's member id without creating a request", async () => {
      const phone = newPhone();
      actAsPhone(phone);
      expect(
        await submitCheckin(riversideTag, {
          kind: "member",
          memberId: otherSocialMemberId,
          firstName: "Peter",
          lastName: "Other",
          updatedSkillLevel: null,
        }),
      ).toEqual({ ok: true, outcome: { status: "member_not_found" } });
      const { data, error } = await admin
        .from("checkin_requests")
        .select("id")
        .eq("member_id", otherSocialMemberId);
      if (error) throw error;
      expect(data).toEqual([]);
    });

    it("tells an inactive link from a social with nothing open", async () => {
      actAsPhone(newPhone());
      expect(await submitCheckin(UNKNOWN_TAG, memberInput("peter"))).toEqual({
        ok: false,
        failure: "inactive",
      });
      expect(await submitCheckin(quietSocialTag, memberInput("peter"))).toEqual(
        { ok: false, failure: "no_open_session" },
      );
    });

    it("maps the per-phone rate limit to rate_limited", async () => {
      // submit_checkin allows 10 submits per phone in the window.
      const phone = newPhone();
      actAsPhone(phone);
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const result = await submitCheckin(riversideTag, memberInput("penny"));
        expect(result.ok).toBe(true);
      }
      expect(await submitCheckin(riversideTag, memberInput("penny"))).toEqual({
        ok: false,
        failure: "rate_limited",
      });
    });
  });

  describe("review fixes", () => {
    it("ensureCheckinDevice sets the device cookie once, before any submit", async () => {
      const phone = newPhone();
      actAsPhone(phone);
      await ensureCheckinDevice();
      const deviceToken = phone.cookieJar.get(DEVICE_COOKIE_NAME);
      expect(deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(phone.lastCookieOptions).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/t",
      });
      phone.lastCookieOptions = null;
      await ensureCheckinDevice();
      expect(phone.cookieJar.get(DEVICE_COOKIE_NAME)).toBe(deviceToken);
      expect(phone.lastCookieOptions).toBeNull();

      // A submit retried after a lost answer is the same phone: same request.
      const guest = {
        kind: "guest" as const,
        firstName: "Retry",
        lastName: "Twice",
        skillLevel: "beginner" as const,
      };
      const firstRequestId = await pendingRequestId(phone, guest);
      expect(await pendingRequestId(phone, guest)).toBe(firstRequestId);
    });

    it("stores a member's own name, whatever name the phone sends", async () => {
      const phone = newPhone();
      const requestId = await pendingRequestId(phone, {
        ...memberInput("penny"),
        firstName: "Alice",
        lastName: "Smith",
      });
      const { data, error } = await admin
        .from("checkin_requests")
        .select("member_id, first_name, last_name")
        .eq("id", requestId)
        .single();
      if (error) throw error;
      expect(data).toEqual({
        member_id: memberIds.penny,
        first_name: "Penny",
        last_name: "Ward",
      });

      const { data: tray, error: trayError } = await admin.rpc(
        "list_checkin_requests_for_open_session",
        { p_actor_user_id: managerUserId },
      );
      if (trayError) throw trayError;
      const trayRow = tray.find((row) => row.id === requestId);
      expect(trayRow).toMatchObject({
        member_id: memberIds.penny,
        first_name: "Penny",
        last_name: "Ward",
      });
      expect(tray.some((row) => row.first_name === "Alice")).toBe(false);
    });

    it("never shows one phone's request to another phone", async () => {
      const firstPhone = newPhone();
      const requestId = await pendingRequestId(firstPhone, {
        kind: "guest",
        firstName: "Private",
        lastName: "Person",
        skillLevel: "beginner",
      });
      expect(await openPageFor(firstPhone)).toMatchObject({
        currentRequest: { checkinRequestId: requestId },
      });

      const secondPhone = newPhone();
      actAsPhone(secondPhone);
      await ensureCheckinDevice();
      expect(await openPageFor(secondPhone)).toMatchObject({
        recognisedMember: null,
        currentRequest: null,
      });
    });

    it("maps the per-network rate limit to rate_limited", async () => {
      // submit_checkin allows 30 submits per network (IP) in the window.
      const sharedIp = newPhone().clientIp;
      for (let phoneNumber = 1; phoneNumber <= 3; phoneNumber += 1) {
        const phone = { ...newPhone(), clientIp: sharedIp };
        actAsPhone(phone);
        for (let attempt = 1; attempt <= 10; attempt += 1) {
          expect(
            (await submitCheckin(riversideTag, memberInput("penny"))).ok,
          ).toBe(true);
        }
      }
      actAsPhone({ ...newPhone(), clientIp: sharedIp });
      expect(await submitCheckin(riversideTag, memberInput("penny"))).toEqual({
        ok: false,
        failure: "rate_limited",
      });
    });
  });

  describe("the publishable (anon) key", () => {
    it("reads no check-in table and calls no check-in function", async () => {
      const anonClient = createClient<Database>(
        localStack!.apiUrl,
        localStack!.publishableKey,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      for (const table of [
        "checkin_requests",
        "member_devices",
        "members",
        "socials",
        "sessions",
        "checkin_attempts",
      ] as const) {
        const { data } = await anonClient.from(table).select("*").limit(1);
        expect(data ?? []).toEqual([]);
      }
      const page = await anonClient.rpc("get_checkin_page", {
        p_checkin_tag: riversideTag,
        p_device_token_hash: sha256Hex("anything"),
      });
      expect(page.error).not.toBeNull();
      const search = await anonClient.rpc("search_checkin_names", {
        p_checkin_tag: riversideTag,
        p_name_query: "pe",
        p_device_token_hash: sha256Hex("anything"),
        p_ip_hash: sha256Hex("anything"),
      });
      expect(search.error).not.toBeNull();
      const submit = await anonClient.rpc("submit_checkin", {
        p_checkin_tag: riversideTag,
        p_device_token_hash: sha256Hex("anything"),
        p_ip_hash: sha256Hex("anything"),
        p_first_name: "Anon",
        p_last_name: "Caller",
        p_skill_level: "beginner",
      });
      expect(submit.error).not.toBeNull();
    });
  });
});
