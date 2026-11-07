// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clientIpFromHeaders } from "./clientIp";

describe("clientIpFromHeaders", () => {
  it("uses the first x-forwarded-for entry (the original client)", () => {
    expect(
      clientIpFromHeaders(
        new Headers({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1, 10.0.0.2" }),
      ),
    ).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(
      clientIpFromHeaders(new Headers({ "x-real-ip": "2001:db8::1" })),
    ).toBe("2001:db8::1");
  });

  it("returns null without either header, or with empty ones", () => {
    expect(clientIpFromHeaders(new Headers())).toBeNull();
    expect(
      clientIpFromHeaders(
        new Headers({ "x-forwarded-for": " , ", "x-real-ip": " " }),
      ),
    ).toBeNull();
  });
});
