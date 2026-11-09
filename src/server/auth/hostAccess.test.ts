// @vitest-environment node
import { describe, expect, it } from "vitest";
import { authorizeHostAccess, type SignedInHost } from "./hostAccess";

const managerHost: SignedInHost = {
  userId: "00000000-0000-4000-8000-000000000001",
  email: "manager@example.test",
  displayName: "Ada",
  role: "manager",
  socialId: "00000000-0000-4000-8000-0000000000a1",
  socialName: "Riverside Social",
};
const regularHost: SignedInHost = { ...managerHost, role: "host" };

describe("authorizeHostAccess", () => {
  it("denies a signed-out visitor for every role", () => {
    expect(authorizeHostAccess({ status: "signed_out" }, "host")).toEqual({
      ok: false,
      reason: "SIGNED_OUT",
    });
    expect(authorizeHostAccess({ status: "signed_out" }, "manager")).toEqual({
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
    expect(authorizeHostAccess(access, "manager")).toEqual({
      ok: false,
      reason: "NOT_A_HOST",
    });
  });

  it("lets a regular host do host things but not manager things", () => {
    const access = { status: "host", host: regularHost } as const;
    expect(authorizeHostAccess(access, "host")).toEqual({
      ok: true,
      host: regularHost,
    });
    expect(authorizeHostAccess(access, "manager")).toEqual({
      ok: false,
      reason: "NOT_A_MANAGER",
    });
  });

  it("lets a social manager do both", () => {
    const access = { status: "host", host: managerHost } as const;
    expect(authorizeHostAccess(access, "host")).toEqual({
      ok: true,
      host: managerHost,
    });
    expect(authorizeHostAccess(access, "manager")).toEqual({
      ok: true,
      host: managerHost,
    });
  });
});
