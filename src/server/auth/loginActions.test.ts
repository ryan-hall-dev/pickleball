// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requestLoginCode, verifyLoginCode } from "./loginActions";
import { recordLoginAttempt } from "./loginThrottle";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
}));
vi.mock("./loginThrottle", () => ({ recordLoginAttempt: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

const recordLoginAttemptMock = vi.mocked(recordLoginAttempt);
const signInWithOtp = vi.fn();
const verifyOtp = vi.fn();

describe("login actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { signInWithOtp, verifyOtp },
    } as unknown as Awaited<ReturnType<typeof createSupabaseServerClient>>);
  });

  it("records the attempt with the normalised email, then sends the code", async () => {
    recordLoginAttemptMock.mockResolvedValue(true);
    signInWithOtp.mockResolvedValue({ error: null });

    expect(await requestLoginCode("  Host@Example.TEST ")).toBe("CODE_SENT");
    expect(recordLoginAttemptMock).toHaveBeenCalledWith(
      "request_code",
      "host@example.test",
    );
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "host@example.test",
      options: { shouldCreateUser: false },
    });
  });

  it("refuses a throttled code request without contacting Supabase", async () => {
    recordLoginAttemptMock.mockResolvedValue(false);

    expect(await requestLoginCode("host@example.test")).toBe("RATE_LIMITED");
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("gives invited and uninvited emails the same answer, including Supabase's per-email limit", async () => {
    recordLoginAttemptMock.mockResolvedValue(true);
    signInWithOtp.mockResolvedValueOnce({ error: null });
    signInWithOtp.mockResolvedValueOnce({
      error: { code: "otp_disabled", status: 422 },
    });
    signInWithOtp.mockResolvedValueOnce({
      error: { code: "over_email_send_rate_limit", status: 429 },
    });

    expect(await requestLoginCode("invited@example.test")).toBe("CODE_SENT");
    expect(await requestLoginCode("stranger@example.test")).toBe("CODE_SENT");
    expect(await requestLoginCode("invited@example.test")).toBe("CODE_SENT");
  });

  it("reports the service as unavailable when the throttle can't be checked", async () => {
    recordLoginAttemptMock.mockRejectedValue(new Error("database down"));

    expect(await requestLoginCode("host@example.test")).toBe("UNAVAILABLE");
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("does not record attempts for a malformed email", async () => {
    expect(await requestLoginCode("not-an-email")).toBe("INVALID_EMAIL");
    expect(recordLoginAttemptMock).not.toHaveBeenCalled();
  });

  it("refuses a throttled code check without contacting Supabase", async () => {
    recordLoginAttemptMock.mockResolvedValue(false);

    expect(await verifyLoginCode("host@example.test", "123456")).toEqual({
      ok: false,
      reason: "RATE_LIMITED",
    });
    expect(recordLoginAttemptMock).toHaveBeenCalledWith(
      "verify_code",
      "host@example.test",
    );
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("checks an allowed code and redirects home on success", async () => {
    recordLoginAttemptMock.mockResolvedValue(true);
    verifyOtp.mockResolvedValue({ error: null });

    await expect(
      verifyLoginCode("host@example.test", "123 456"),
    ).rejects.toThrow("REDIRECT /");
    expect(verifyOtp).toHaveBeenCalledWith({
      email: "host@example.test",
      token: "123456",
      type: "email",
    });
  });
});
