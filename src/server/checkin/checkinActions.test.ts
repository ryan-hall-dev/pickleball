// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  rpc: vi.fn(),
  log: vi.fn(),
  jar: new Map<string, string>(),
  setCookie: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => ({ value: mocks.jar.get(name) }),
    set: (name: string, value: string, options: unknown) => {
      mocks.jar.set(name, value);
      mocks.setCookie(name, value, options);
    },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "10.0.0.1" }),
}));
vi.mock("./checkinPage", () => ({
  fetchCheckinPage: mocks.fetchPage,
  loadCheckinPage: vi.fn(),
  logCheckinFailure: mocks.log,
  checkinDatabaseTimeoutSignal: () => AbortSignal.timeout(1000),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
}));
import { ensureCheckinDevice, submitCheckin } from "./checkinActions";
const tag = "riverside0123456789";
const sessionA = "a0000000-0000-4000-8000-000000000001";
const sessionB = "a0000000-0000-4000-8000-000000000002";
const page = (sessionId: string) => ({
  status: "open",
  session: { sessionId },
});
const input = {
  sessionId: sessionA,
  firstName: "Kai",
  lastName: "Moreno",
  skillLevel: "beginner",
  gender: "male" as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.jar.clear();
  vi.stubEnv(
    "CHECKIN_IP_HMAC_SECRET",
    "unit-test-secret-with-at-least-32-characters",
  );
  mocks.fetchPage.mockResolvedValue(page(sessionA));
  mocks.rpc.mockReturnValue({
    abortSignal: async () => ({
      data: {
        status: "pending",
        checkin_request_id: "b0000000-0000-4000-8000-000000000001",
        was_already_pending: false,
      },
      error: null,
    }),
  });
});
describe("session-specific check-in cookie", () => {
  it("validates the tag before accessing the database or cookies", async () => {
    expect(await ensureCheckinDevice("../invalid")).toEqual({
      ok: false,
      failure: "inactive",
    });
    expect(mocks.fetchPage).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });
  it("reports closed sessions and database errors without throwing", async () => {
    mocks.fetchPage.mockResolvedValueOnce({ status: "no_open_session" });
    expect(await ensureCheckinDevice(tag)).toEqual({
      ok: false,
      failure: "no_open_session",
    });
    mocks.fetchPage.mockRejectedValueOnce(new Error("offline"));
    expect(await ensureCheckinDevice(tag)).toEqual({
      ok: false,
      failure: "unavailable",
    });
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });
  it("ignores the universal cookie and initializes an HttpOnly token once", async () => {
    mocks.jar.set("checkin_device", "x".repeat(43));
    expect(await ensureCheckinDevice(tag)).toEqual({ ok: true });
    const token = mocks.jar.get(`checkin_session_${sessionA}`)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe("x".repeat(43));
    expect(mocks.setCookie).toHaveBeenCalledWith(
      `checkin_session_${sessionA}`,
      token,
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: `/t/${tag}`,
        maxAge: 86400,
      }),
    );
    await ensureCheckinDevice(tag);
    expect(mocks.setCookie).toHaveBeenCalledTimes(1);
  });
  it("refuses the rendered A form when B opened before the action starts", async () => {
    await ensureCheckinDevice(tag);
    mocks.fetchPage.mockResolvedValue(page(sessionB));
    expect(await submitCheckin(tag, input)).toEqual({
      ok: false,
      failure: "session_changed",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.jar.has(`checkin_session_${sessionB}`)).toBe(false);
    await ensureCheckinDevice(tag);
    const secondToken = mocks.jar.get(`checkin_session_${sessionB}`)!;
    expect(secondToken).not.toBe(mocks.jar.get(`checkin_session_${sessionA}`));
    await submitCheckin(tag, { ...input, sessionId: sessionB });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "submit_checkin",
      expect.objectContaining({
        p_expected_session_id: sessionB,
        p_device_token_hash: createHash("sha256")
          .update(secondToken)
          .digest("hex"),
      }),
    );
  });
  it("maps turnover after preflight to session_changed", async () => {
    await ensureCheckinDevice(tag);
    mocks.rpc.mockReturnValueOnce({
      abortSignal: async () => ({
        data: null,
        error: { message: "SESSION_CHANGED" },
      }),
    });
    expect(await submitCheckin(tag, input)).toEqual({
      ok: false,
      failure: "session_changed",
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "submit_checkin",
      expect.objectContaining({ p_expected_session_id: sessionA }),
    );
  });
  it("replaces a malformed token and reports cookie write failures", async () => {
    mocks.jar.set(`checkin_session_${sessionA}`, "bad");
    await ensureCheckinDevice(tag);
    expect(mocks.jar.get(`checkin_session_${sessionA}`)).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    mocks.jar.clear();
    mocks.setCookie.mockImplementationOnce(() => {
      throw new Error("cookie failed");
    });
    expect(await ensureCheckinDevice(tag)).toEqual({
      ok: false,
      failure: "unavailable",
    });
  });
});

it("rejects an outdated submission missing gender before creating a cookie or touching the database", async () => {
  const { gender: ignoredGender, ...outdated } = input;
  void ignoredGender;
  expect(await submitCheckin(tag, outdated)).toMatchObject({
    ok: false,
    failure: "invalid_input",
    fieldErrors: { gender: "Choose male or female." },
  });
  expect(mocks.fetchPage).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.setCookie).not.toHaveBeenCalled();
});
