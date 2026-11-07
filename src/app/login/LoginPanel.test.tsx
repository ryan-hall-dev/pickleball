import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHostAccess } from "@/server/auth/currentHost";
import { clubHasAnyHost } from "@/server/hosts/hostDirectory";
import { LoginPanel } from "./LoginPanel";

vi.mock("@/server/auth/currentHost", () => ({ readHostAccess: vi.fn() }));
vi.mock("@/server/hosts/hostDirectory", () => ({ clubHasAnyHost: vi.fn() }));
vi.mock("@/server/auth/loginActions", () => ({
  requestLoginCode: vi.fn(),
  verifyLoginCode: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT ${path}`);
  }),
}));

const readHostAccessMock = vi.mocked(readHostAccess);
const clubHasAnyHostMock = vi.mocked(clubHasAnyHost);

describe("LoginPanel", () => {
  afterEach(cleanup);

  it("explains how to create the first admin when there are no hosts", async () => {
    readHostAccessMock.mockResolvedValue({ status: "signed_out" });
    clubHasAnyHostMock.mockResolvedValue(false);

    render(await LoginPanel());

    expect(
      screen.getByRole("heading", { name: "No hosts yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/pnpm create-admin --email/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("shows the sign-in form when hosts exist", async () => {
    readHostAccessMock.mockResolvedValue({ status: "signed_out" });
    clubHasAnyHostMock.mockResolvedValue(true);

    render(await LoginPanel());

    expect(
      screen.getByRole("heading", { name: "Host sign in" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it.each([
    { status: "not_a_host", email: "x@example.test" } as const,
    {
      status: "host",
      host: { userId: "u1", email: null, displayName: "Ada", role: "host" },
    } as const,
  ])("sends a signed-in visitor ($status) to the host area", async (access) => {
    readHostAccessMock.mockResolvedValue(access);

    await expect(LoginPanel()).rejects.toThrow("REDIRECT /");
  });
});
