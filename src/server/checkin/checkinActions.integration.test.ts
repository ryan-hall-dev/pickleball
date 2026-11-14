// @vitest-environment node
// The public check-in page's server actions against the LOCAL Supabase stack
// (`pnpm db:start`), after session-only participants (20261112090000): the
// page read (inactive link, nothing open, open, this phone's request only),
// the submit privacy rule (only the phone whose own request was approved
// hears "already checked in"; a name already attending is never revealed),
// one pending request per phone, a fresh request after a rejection, the
// rate-limit mapping, the device cookie (only its hash reaches the database),
// and no table or function access with the publishable (anon) key. Each phone is a fake
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
  submitCheckin as submitCheckinAction,
} from "./checkinActions";
import type { ParticipantCheckinInput } from "./checkinRules";
import type { OpenCheckinPage } from "./checkinResults";

import * as checkinPageModule from "./checkinPage";

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
  async function submitCheckin(tag: unknown, input: unknown) {
    return submitCheckinAction(tag, {
      ...(input as object),
      sessionId: riversideSessionId,
    });
  }

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

  async function approve(checkinRequestId: string) {
    return admin.rpc("approve_checkin", {
      p_actor_user_id: managerUserId,
      p_checkin_request_id: checkinRequestId,
      p_session_participant_id: randomUUID(),
    });
  }

  async function approveOrThrow(checkinRequestId: string) {
    const { data, error } = await approve(checkinRequestId);
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

  /** A check-in with a name unique to this run (names are unique per session). */
  function playerInput(
    firstName: string,
    skillLevel: ParticipantCheckinInput["skillLevel"] = "beginner",
  ) {
    return {
      firstName,
      lastName: `Tester${randomUUID().slice(0, 6)}`,
      skillLevel,
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
        currentRequest: null,
      });
      expect(Date.parse(page.now)).not.toBeNaN();
      // Reading never creates the device cookie.
      expect(currentPhone.cookieJar.size).toBe(0);
    });
  });

  describe("submitCheckin", () => {
    it("sets an HttpOnly, SameSite=Lax device cookie on /t and stores only the token's hash", async () => {
      const phone = newPhone();
      const requestId = await pendingRequestId(phone, playerInput("Grace"));
      const deviceToken = phone.cookieJar.get(
        `checkin_session_${riversideSessionId}`,
      )!;
      expect(deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(phone.lastCookieOptions).toMatchObject({
        httpOnly: true,
        // Not Secure outside production: phones on the LAN use plain http.
        secure: false,
        sameSite: "lax",
        path: `/t/${riversideTag}`,
      });

      const { data: requestRow, error } = await admin
        .from("checkin_requests")
        .select("device_token_hash, ip_hash, status")
        .eq("id", requestId)
        .single();
      if (error) throw error;
      expect(requestRow.device_token_hash).toBe(sha256Hex(deviceToken));
      expect(requestRow.device_token_hash).not.toContain(deviceToken);
      expect(requestRow.ip_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(requestRow.ip_hash).not.toBe(sha256Hex(phone.clientIp));

      // Waiting, then approved: the phone sees its own request only.
      expect(await openPageFor(phone)).toMatchObject({
        currentRequest: { checkinRequestId: requestId, status: "pending" },
      });
      await approveOrThrow(requestId);
      expect(await openPageFor(phone)).toMatchObject({
        currentRequest: { checkinRequestId: requestId, status: "approved" },
      });
      expect(await openPageFor(newPhone())).toMatchObject({
        currentRequest: null,
      });
    });

    it("answers already checked in only to the phone whose request was approved, and never reveals a name", async () => {
      const peter = playerInput("Peter");
      const peterPhone = newPhone();
      await approveOrThrow(await pendingRequestId(peterPhone, peter));

      actAsPhone(peterPhone);
      expect(await submitCheckin(riversideTag, peter)).toEqual({
        ok: true,
        outcome: { status: "already_checked_in" },
      });

      // Another phone with the same name just waits, like any request.
      const strangerPhone = newPhone();
      const strangerRequestId = await pendingRequestId(strangerPhone, peter);
      expect(await openPageFor(strangerPhone)).toMatchObject({
        currentRequest: {
          checkinRequestId: strangerRequestId,
          status: "pending",
          firstName: "Peter",
        },
      });

      // The host can't approve it (one name per session) and rejects it; the
      // phone then sends a fresh request with a distinguishing name.
      const { error: approveError } = await approve(strangerRequestId);
      expect(approveError?.message).toBe("NAME_ALREADY_IN_SESSION");
      const { error: rejectError } = await admin.rpc("reject_checkin", {
        p_actor_user_id: managerUserId,
        p_checkin_request_id: strangerRequestId,
      });
      if (rejectError) throw rejectError;
      expect(await openPageFor(strangerPhone)).toMatchObject({
        currentRequest: {
          checkinRequestId: strangerRequestId,
          status: "rejected",
        },
      });
      const freshRequestId = await pendingRequestId(strangerPhone, {
        ...peter,
        lastName: `${peter.lastName} B`,
      });
      expect(freshRequestId).not.toBe(strangerRequestId);
      expect(await openPageFor(strangerPhone)).toMatchObject({
        currentRequest: { checkinRequestId: freshRequestId, status: "pending" },
      });
    });

    it("returns the same pending request when the same phone submits twice", async () => {
      const phone = newPhone();
      const firstRequestId = await pendingRequestId(phone, playerInput("Pia"));
      const secondRequestId = await pendingRequestId(
        phone,
        playerInput("Pia", "advanced"),
      );
      expect(secondRequestId).toBe(firstRequestId);

      const { data, error } = await admin
        .from("checkin_requests")
        .select("id")
        .eq("session_id", riversideSessionId)
        .eq(
          "device_token_hash",
          sha256Hex(
            phone.cookieJar.get(`checkin_session_${riversideSessionId}`)!,
          ),
        )
        .eq("status", "pending");
      if (error) throw error;
      expect(data).toEqual([{ id: firstRequestId }]);
    });

    it("stores the player's names (trimmed) and level", async () => {
      const phone = newPhone();
      const requestId = await pendingRequestId(phone, {
        firstName: "  Kai ",
        lastName: "Moreno",
        skillLevel: "intermediate",
      });
      const { data, error } = await admin
        .from("checkin_requests")
        .select("first_name, last_name, skill_level")
        .eq("id", requestId)
        .single();
      if (error) throw error;
      expect(data).toEqual({
        first_name: "Kai",
        last_name: "Moreno",
        skill_level: "intermediate",
      });
    });

    it("returns the form's field errors without calling the database", async () => {
      const phone = newPhone();
      actAsPhone(phone);
      expect(
        await submitCheckin(riversideTag, {
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

    it("refuses an obsolete member-era submit without creating a request", async () => {
      const phone = newPhone();
      actAsPhone(phone);
      expect(
        await submitCheckin(riversideTag, {
          kind: "member",
          memberId: randomUUID(),
          firstName: "Old",
          lastName: "Page",
          updatedSkillLevel: null,
        }),
      ).toMatchObject({ ok: false, failure: "invalid_input" });
      const { data, error } = await admin
        .from("checkin_requests")
        .select("id")
        .eq("session_id", riversideSessionId)
        .eq("first_name", "Old")
        .eq("last_name", "Page");
      if (error) throw error;
      expect(data).toEqual([]);
    });

    it("tells an inactive link from a social with nothing open", async () => {
      actAsPhone(newPhone());
      expect(await submitCheckin(UNKNOWN_TAG, playerInput("Nobody"))).toEqual({
        ok: false,
        failure: "inactive",
      });
      expect(
        await submitCheckin(quietSocialTag, playerInput("Nobody")),
      ).toEqual({ ok: false, failure: "no_open_session" });
    });

    it("maps the per-phone rate limit to rate_limited", async () => {
      // submit_checkin allows 10 submits per phone in the window.
      const phone = newPhone();
      actAsPhone(phone);
      const penny = playerInput("Penny");
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const result = await submitCheckin(riversideTag, penny);
        expect(result.ok).toBe(true);
      }
      expect(await submitCheckin(riversideTag, penny)).toEqual({
        ok: false,
        failure: "rate_limited",
      });
    });
  });

  describe("review fixes", () => {
    it("ensureCheckinDevice sets the device cookie once, before any submit", async () => {
      const phone = newPhone();
      actAsPhone(phone);
      await ensureCheckinDevice(riversideTag);
      const deviceToken = phone.cookieJar.get(
        `checkin_session_${riversideSessionId}`,
      );
      expect(deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(phone.lastCookieOptions).toMatchObject({
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: `/t/${riversideTag}`,
      });
      phone.lastCookieOptions = null;
      await ensureCheckinDevice(riversideTag);
      expect(phone.cookieJar.get(`checkin_session_${riversideSessionId}`)).toBe(
        deviceToken,
      );
      expect(phone.lastCookieOptions).toBeNull();

      // A submit retried after a lost answer is the same phone: same request.
      const player = playerInput("Retry");
      const firstRequestId = await pendingRequestId(phone, player);
      expect(await pendingRequestId(phone, player)).toBe(firstRequestId);
    });

    it("marks the device cookie Secure in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      try {
        const phone = newPhone();
        actAsPhone(phone);
        await ensureCheckinDevice(riversideTag);
        expect(phone.lastCookieOptions).toMatchObject({ secure: true });
      } finally {
        vi.stubEnv("NODE_ENV", "test");
      }
    });

    it("never shows one phone's request to another phone", async () => {
      const firstPhone = newPhone();
      const requestId = await pendingRequestId(
        firstPhone,
        playerInput("Private"),
      );
      expect(await openPageFor(firstPhone)).toMatchObject({
        currentRequest: { checkinRequestId: requestId },
      });

      const secondPhone = newPhone();
      actAsPhone(secondPhone);
      await ensureCheckinDevice(riversideTag);
      expect(await openPageFor(secondPhone)).toMatchObject({
        currentRequest: null,
      });
    });

    it("maps the per-network rate limit to rate_limited", async () => {
      // submit_checkin allows 30 submits per network (IP) in the window.
      const sharedIp = newPhone().clientIp;
      const penny = playerInput("Penny");
      for (let phoneNumber = 1; phoneNumber <= 3; phoneNumber += 1) {
        const phone = { ...newPhone(), clientIp: sharedIp };
        actAsPhone(phone);
        for (let attempt = 1; attempt <= 10; attempt += 1) {
          expect((await submitCheckin(riversideTag, penny)).ok).toBe(true);
        }
      }
      actAsPhone({ ...newPhone(), clientIp: sharedIp });
      expect(await submitCheckin(riversideTag, penny)).toEqual({
        ok: false,
        failure: "rate_limited",
      });
    });
  });

  it("refuses session turnover before the action and between preflight and RPC without writing a request", async () => {
    const phone = newPhone();
    actAsPhone(phone);
    await ensureCheckinDevice(riversideTag);
    const originalFetch = checkinPageModule.fetchCheckinPage;
    let replacementSessionId: string | undefined;
    const spy = vi.spyOn(checkinPageModule, "fetchCheckinPage");
    spy.mockImplementationOnce(async (tag, hash) => {
      const oldPage = await originalFetch(tag, hash);
      const { data: old, error } = await admin
        .from("sessions")
        .select("social_id, host_id, host_name, planned_start, planned_end")
        .eq("id", riversideSessionId)
        .single();
      if (error) throw error;
      const cancelled = await admin
        .from("sessions")
        .update({ status: "cancelled" })
        .eq("id", riversideSessionId);
      if (cancelled.error) throw cancelled.error;
      const created = await admin
        .from("sessions")
        .insert({ ...old, name: "Replacement session" })
        .select("id")
        .single();
      if (created.error) throw created.error;
      replacementSessionId = created.data.id;
      return oldPage;
    });
    try {
      expect(
        await submitCheckin(riversideTag, playerInput("Turnover")),
      ).toEqual({ ok: false, failure: "session_changed" });
      spy.mockRestore();
      // A stale rendered form is rejected even when B is already open before the action starts.
      expect(await submitCheckin(riversideTag, playerInput("Stale"))).toEqual({
        ok: false,
        failure: "session_changed",
      });
      const { data, error } = await admin
        .from("checkin_requests")
        .select("id")
        .eq("session_id", replacementSessionId!);
      if (error) throw error;
      expect(data).toEqual([]);
      expect(
        phone.cookieJar.has(`checkin_session_${replacementSessionId}`),
      ).toBe(false);
      const freshPage = await openPageFor(phone);
      expect(freshPage.session.sessionId).toBe(replacementSessionId);
      expect(freshPage.currentRequest).toBeNull();
      await ensureCheckinDevice(riversideTag);
      expect(
        phone.cookieJar.get(`checkin_session_${replacementSessionId}`),
      ).not.toBe(phone.cookieJar.get(`checkin_session_${riversideSessionId}`));
    } finally {
      spy.mockRestore();
      if (replacementSessionId) {
        const cancelled = await admin
          .from("sessions")
          .update({ status: "cancelled" })
          .eq("id", replacementSessionId);
        if (cancelled.error) throw cancelled.error;
      }
      const restored = await admin
        .from("sessions")
        .update({ status: "draft" })
        .eq("id", riversideSessionId);
      if (restored.error) throw restored.error;
    }
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
        "session_participants",
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
      const submit = await anonClient.rpc("submit_checkin", {
        p_checkin_tag: riversideTag,
        p_expected_session_id: riversideSessionId,
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
