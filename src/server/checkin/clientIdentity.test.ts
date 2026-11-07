// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashClientIp, hashDeviceToken } from "./clientIdentity";

// Next.js resolves "server-only" itself; plain Vitest has no such module.
vi.mock("server-only", () => ({}));

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TEST_SECRET = "test-secret-that-is-at-least-32-characters";

describe("hashClientIp", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a stable lowercase hex HMAC, keyed by the secret", () => {
    vi.stubEnv("CHECKIN_IP_HMAC_SECRET", TEST_SECRET);
    const hash = hashClientIp("203.0.113.7");
    expect(hash).toMatch(SHA256_HEX);
    expect(hashClientIp(" 203.0.113.7 ")).toBe(hash);
    expect(hashClientIp("203.0.113.8")).not.toBe(hash);
    // Not a plain hash, so it can't be reversed by hashing every IPv4 address.
    expect(hash).not.toBe(
      createHash("sha256").update("203.0.113.7").digest("hex"),
    );

    vi.stubEnv("CHECKIN_IP_HMAC_SECRET", `${TEST_SECRET}-rotated`);
    expect(hashClientIp("203.0.113.7")).not.toBe(hash);
  });

  it("fails fast without a long enough secret", () => {
    vi.stubEnv("CHECKIN_IP_HMAC_SECRET", "");
    expect(() => hashClientIp("203.0.113.7")).toThrow(/CHECKIN_IP_HMAC_SECRET/);
    vi.stubEnv("CHECKIN_IP_HMAC_SECRET", "too-short");
    expect(() => hashClientIp("203.0.113.7")).toThrow(/at least 32/);
  });

  it("refuses an empty IP", () => {
    vi.stubEnv("CHECKIN_IP_HMAC_SECRET", TEST_SECRET);
    expect(() => hashClientIp("  ")).toThrow(/client IP/);
  });
});

describe("hashDeviceToken", () => {
  it("returns the lowercase hex SHA-256 of the token", () => {
    expect(hashDeviceToken("token-abc")).toBe(
      createHash("sha256").update("token-abc").digest("hex"),
    );
    expect(hashDeviceToken("token-abc")).toMatch(SHA256_HEX);
  });

  it("refuses an empty token", () => {
    expect(() => hashDeviceToken("")).toThrow(/device token/);
  });
});
