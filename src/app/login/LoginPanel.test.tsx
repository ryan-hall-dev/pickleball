import { cleanup, screen } from "@testing-library/react";
import { renderWithLocale as render } from "@/i18n/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHostAccess } from "@/server/auth/currentHost";
import { installationHasAnyHost } from "@/server/hosts/hostDirectory";
import { LoginPanel } from "./LoginPanel";

vi.mock("@/server/auth/currentHost", () => ({ readHostAccess: vi.fn() }));
vi.mock("@/i18n/getLocale", async () => {
  const { MESSAGES } = await import("@/i18n/messages");
  return { getMessages: async () => MESSAGES.en };
});
vi.mock("@/server/hosts/hostDirectory", () => ({
  installationHasAnyHost: vi.fn(),
}));
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
const installationHasAnyHostMock = vi.mocked(installationHasAnyHost);

describe("LoginPanel", () => {
  afterEach(cleanup);

  it("explains how to create the first social when there are no hosts", async () => {
    readHostAccessMock.mockResolvedValue({ status: "signed_out" });
    installationHasAnyHostMock.mockResolvedValue(false);

    render(await LoginPanel());

    expect(
      screen.getByRole("heading", { name: "No hosts yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/pnpm create-social --name/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("shows the sign-in form when hosts exist", async () => {
    readHostAccessMock.mockResolvedValue({ status: "signed_out" });
    installationHasAnyHostMock.mockResolvedValue(true);

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
      host: {
        userId: "u1",
        email: null,
        displayName: "Ada",
        role: "host",
        socialId: "s1",
        socialName: "Riverside Social",
      },
    } as const,
  ])("sends a signed-in visitor ($status) to the host area", async (access) => {
    readHostAccessMock.mockResolvedValue(access);

    await expect(LoginPanel()).rejects.toThrow("REDIRECT /");
  });
});
