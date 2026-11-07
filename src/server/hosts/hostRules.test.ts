// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkHostRemoval, inviteHostInputSchema } from "./hostRules";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";

describe("checkHostRemoval", () => {
  it("allows removing another regular host", () => {
    expect(
      checkHostRemoval({
        actorUserId: ACTOR_ID,
        targetHost: { userId: OTHER_ID, role: "host" },
        adminCount: 1,
      }),
    ).toEqual({ ok: true });
  });

  it("allows removing another admin while another admin remains", () => {
    expect(
      checkHostRemoval({
        actorUserId: ACTOR_ID,
        targetHost: { userId: OTHER_ID, role: "admin" },
        adminCount: 2,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses to let an admin remove themselves", () => {
    expect(
      checkHostRemoval({
        actorUserId: ACTOR_ID,
        targetHost: { userId: ACTOR_ID, role: "admin" },
        adminCount: 3,
      }),
    ).toEqual({ ok: false, reason: "CANNOT_REMOVE_SELF" });
  });

  it("refuses to remove the last admin", () => {
    expect(
      checkHostRemoval({
        actorUserId: ACTOR_ID,
        targetHost: { userId: OTHER_ID, role: "admin" },
        adminCount: 1,
      }),
    ).toEqual({ ok: false, reason: "LAST_ADMIN" });
  });

  it("reports a host that is no longer on the list", () => {
    expect(
      checkHostRemoval({
        actorUserId: ACTOR_ID,
        targetHost: null,
        adminCount: 1,
      }),
    ).toEqual({ ok: false, reason: "HOST_NOT_FOUND" });
  });
});

describe("inviteHostInputSchema", () => {
  it("trims and lowercases the email and trims the name", () => {
    expect(
      inviteHostInputSchema.parse({
        email: "  Sam.Lee@Example.COM ",
        displayName: "  Sam Lee ",
      }),
    ).toEqual({ email: "sam.lee@example.com", displayName: "Sam Lee" });
  });

  it.each([
    [{ email: "not-an-email", displayName: "Sam" }, "email"],
    [{ email: "sam@example.com", displayName: "   " }, "displayName"],
    [{ email: "sam@example.com", displayName: "x".repeat(81) }, "displayName"],
    [{ email: "sam@example.com", displayName: "Sam\u0007" }, "displayName"],
  ])("rejects %j on %s", (input, fieldName) => {
    const result = inviteHostInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual([fieldName]);
  });

  it("accepts an 80-character name with accents", () => {
    const displayName = "é".repeat(80);
    expect(
      inviteHostInputSchema.parse({ email: "a@b.co", displayName }).displayName,
    ).toBe(displayName);
  });
});
