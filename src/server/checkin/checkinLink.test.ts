// @vitest-environment node
// readCheckinLink's origin: PUBLIC_APP_ORIGIN when set (production), the
// request's own address otherwise (local development), and a clear failure
// for a malformed setting. The database read is stubbed here; the
// integration test reads a real tag.
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCheckinLink } from "./checkinLink";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
const CHECKIN_TAG = "0123456789abcdef0123456789abcdef";
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { checkin_tag: CHECKIN_TAG },
            error: null,
          }),
        }),
      }),
    }),
  })),
}));

const headersMock = vi.mocked(headers);
const SOCIAL_ID = "a0000000-0000-4000-8000-000000000001";

describe("readCheckinLink", () => {
  beforeEach(() => {
    headersMock.mockResolvedValue(
      new Headers({ host: "internal.vercel.app" }) as never,
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    headersMock.mockReset();
  });

  it("uses PUBLIC_APP_ORIGIN when it is set, whatever the request's host", async () => {
    vi.stubEnv("PUBLIC_APP_ORIGIN", "https://social.example.com");
    expect(await readCheckinLink(SOCIAL_ID)).toEqual({
      link: `https://social.example.com/t/${CHECKIN_TAG}`,
      shortLink: `social.example.com/t/${CHECKIN_TAG}`,
    });
    expect(headersMock).not.toHaveBeenCalled();
  });

  it("falls back to the request's address when it isn't set", async () => {
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
    expect(await readCheckinLink(SOCIAL_ID)).toEqual({
      link: `https://internal.vercel.app/t/${CHECKIN_TAG}`,
      shortLink: `internal.vercel.app/t/${CHECKIN_TAG}`,
    });
  });

  it("refuses a malformed setting instead of printing a wrong link", async () => {
    vi.stubEnv("PUBLIC_APP_ORIGIN", "https://social.example.com/");
    await expect(readCheckinLink(SOCIAL_ID)).rejects.toThrow(
      /PUBLIC_APP_ORIGIN must be an http or https origin/,
    );
  });
});
