import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestLoginCode, verifyLoginCode } from "@/server/auth/loginActions";
import { LoginForm } from "./LoginForm";

vi.mock("@/server/auth/loginActions", () => ({
  requestLoginCode: vi.fn(),
  verifyLoginCode: vi.fn(),
}));

const requestLoginCodeMock = vi.mocked(requestLoginCode);
const verifyLoginCodeMock = vi.mocked(verifyLoginCode);

function submitEmail(email: string) {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: email },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
}

describe("LoginForm", () => {
  beforeEach(() => {
    requestLoginCodeMock.mockReset();
    verifyLoginCodeMock.mockReset();
  });

  // Vitest runs without globals, so Testing Library can't clean up on its own.
  afterEach(cleanup);

  it("moves to the code step after sending a code", async () => {
    requestLoginCodeMock.mockResolvedValue("CODE_SENT");
    render(<LoginForm />);

    submitEmail("host@example.test");

    expect(
      await screen.findByRole("heading", { name: "Check your email" }),
    ).toBeInTheDocument();
    expect(requestLoginCodeMock).toHaveBeenCalledWith("host@example.test");
    expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send a new code in 60s" }),
    ).toBeDisabled();
  });

  it("shows a rate-limit error and stays on the email step", async () => {
    requestLoginCodeMock.mockResolvedValue("RATE_LIMITED");
    render(<LoginForm />);

    submitEmail("host@example.test");

    expect(
      await screen.findByText(/Too many sign-in attempts/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("treats a failed request as unavailable", async () => {
    requestLoginCodeMock.mockRejectedValue(new Error("network down"));
    render(<LoginForm />);

    submitEmail("host@example.test");

    expect(await screen.findByText(/couldn't send a code/)).toBeInTheDocument();
  });

  it("shows a wrong-or-expired message for a bad code", async () => {
    requestLoginCodeMock.mockResolvedValue("CODE_SENT");
    verifyLoginCodeMock.mockResolvedValue({
      ok: false,
      reason: "WRONG_OR_EXPIRED_CODE",
    });
    render(<LoginForm />);
    submitEmail("host@example.test");
    const codeInput = await screen.findByLabelText("6-digit code");

    fireEvent.change(codeInput, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/wrong or has expired/)).toBeInTheDocument();
    expect(verifyLoginCodeMock).toHaveBeenCalledWith(
      "host@example.test",
      "000000",
    );
  });

  it("goes back to the email step", async () => {
    requestLoginCodeMock.mockResolvedValue("CODE_SENT");
    render(<LoginForm />);
    submitEmail("host@example.test");
    await screen.findByLabelText("6-digit code");
    // The code step can render while the send transition is still pending,
    // when this button is briefly disabled; wait so the click isn't lost.
    const useDifferentEmailButton = screen.getByRole("button", {
      name: "Use a different email",
    });
    await waitFor(() => expect(useDifferentEmailButton).toBeEnabled());

    fireEvent.click(useDifferentEmailButton);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send code" }),
      ).toBeInTheDocument(),
    );
  });
});
