// @vitest-environment node
import { describe, expect, it } from "vitest";
import { authorizeHostAccess, type SignedInHost } from "./hostAccess";

const adminHost: SignedInHost = {
  userId: "00000000-0000-4000-8000-000000000001",
  email: "admin@example.test",
  displayName: "Ada",
  role: "admin",
};
const regularHost: SignedInHost = { ...adminHost, role: "host" };

describe("authorizeHostAccess", () => {
  it("denies a signed-out visitor for every role", () => {
    expect(authorizeHostAccess({ status: "signed_out" }, "host")).toEqual({
      ok: false,
      reason: "SIGNED_OUT",
    });
    expect(authorizeHostAccess({ status: "signed_out" }, "admin")).toEqual({
      ok: false,
      reason: "SIGNED_OUT",
    });
  });

  it("denies a signed-in user who isn't on the hosts list", () => {
    const access = { status: "not_a_host", email: "x@example.test" } as const;
    expect(authorizeHostAccess(access, "host")).toEqual({
      ok: false,
      reason: "NOT_A_HOST",
    });
    expect(authorizeHostAccess(access, "admin")).toEqual({
      ok: false,
      reason: "NOT_A_HOST",
    });
  });

  it("lets a regular host do host things but not admin things", () => {
    const access = { status: "host", host: regularHost } as const;
    expect(authorizeHostAccess(access, "host")).toEqual({
      ok: true,
      host: regularHost,
    });
    expect(authorizeHostAccess(access, "admin")).toEqual({
      ok: false,
      reason: "NOT_AN_ADMIN",
    });
  });

  it("lets an admin do both", () => {
    const access = { status: "host", host: adminHost } as const;
    expect(authorizeHostAccess(access, "host")).toEqual({
      ok: true,
      host: adminHost,
    });
    expect(authorizeHostAccess(access, "admin")).toEqual({
      ok: true,
      host: adminHost,
    });
  });
});
