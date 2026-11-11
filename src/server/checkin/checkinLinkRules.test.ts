// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkinLinkFromOrigin,
  publicOriginFromHeaders,
  publicOriginFromSetting,
  shortCheckinLink,
} from "./checkinLinkRules";

const TAG = "0123456789abcdef0123456789abcdef";

describe("publicOriginFromHeaders", () => {
  it("uses the proxy's forwarded host and protocol", () => {
    expect(
      publicOriginFromHeaders(
        new Headers({
          host: "internal:3000",
          "x-forwarded-host": "pickleball.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://pickleball.example");
  });

  it("takes the first value of a forwarded list and lower-cases the host", () => {
    expect(
      publicOriginFromHeaders(
        new Headers({
          "x-forwarded-host": "Pickleball.Example, internal",
          "x-forwarded-proto": "https,http",
        }),
      ),
    ).toBe("https://pickleball.example");
  });

  it("falls back to the host header, http on localhost and https elsewhere", () => {
    expect(
      publicOriginFromHeaders(new Headers({ host: "localhost:3000" })),
    ).toBe("http://localhost:3000");
    expect(
      publicOriginFromHeaders(new Headers({ host: "127.0.0.1:3000" })),
    ).toBe("http://127.0.0.1:3000");
    expect(
      publicOriginFromHeaders(new Headers({ host: "pickleball.example" })),
    ).toBe("https://pickleball.example");
  });

  it("ignores a forwarded protocol that isn't http or https", () => {
    expect(
      publicOriginFromHeaders(
        new Headers({
          host: "pickleball.example",
          "x-forwarded-proto": "javascript",
        }),
      ),
    ).toBe("https://pickleball.example");
  });

  it.each([
    ["no host at all", new Headers()],
    ["a blank host", new Headers({ host: " " })],
    ["a host with a path", new Headers({ host: "evil.example/x" })],
    ["a host with credentials", new Headers({ host: "a@evil.example" })],
  ])("fails fast on %s", (_label, requestHeaders) => {
    expect(() => publicOriginFromHeaders(requestHeaders)).toThrow(
      /no usable host header/,
    );
  });
});

describe("publicOriginFromSetting (PUBLIC_APP_ORIGIN)", () => {
  it("is null when unset or blank, so the request's origin is used", () => {
    expect(publicOriginFromSetting(undefined)).toBeNull();
    expect(publicOriginFromSetting("")).toBeNull();
    expect(publicOriginFromSetting("  ")).toBeNull();
  });

  it.each([
    ["https://social.example.com", "https://social.example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://Social.Example.com", "https://social.example.com"],
  ])("accepts the bare origin %s", (configured, expected) => {
    expect(publicOriginFromSetting(configured)).toBe(expected);
  });

  it.each([
    "social.example.com",
    "https://social.example.com/",
    "https://social.example.com/checkin",
    "https://social.example.com?x=1",
    "https://user:pass@social.example.com",
    "ftp://social.example.com",
    "javascript:alert(1)",
    "not a url",
  ])("fails fast on %s", (configured) => {
    expect(() => publicOriginFromSetting(configured)).toThrow(
      /PUBLIC_APP_ORIGIN must be an http or https origin/,
    );
  });
});

describe("check-in link formatting", () => {
  it("builds the absolute /t/<tag> link", () => {
    expect(checkinLinkFromOrigin("https://pickleball.example", TAG)).toBe(
      `https://pickleball.example/t/${TAG}`,
    );
  });

  it("drops only the scheme for the short link", () => {
    expect(shortCheckinLink(`https://pickleball.example/t/${TAG}`)).toBe(
      `pickleball.example/t/${TAG}`,
    );
    expect(shortCheckinLink(`http://localhost:3000/t/${TAG}`)).toBe(
      `localhost:3000/t/${TAG}`,
    );
  });
});
