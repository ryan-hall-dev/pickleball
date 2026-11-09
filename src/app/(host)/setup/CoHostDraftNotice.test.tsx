import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSessionDraft } from "@/server/setup/setupActions";
import {
  CoHostDraftNotice,
  CoHostDraftNoticeProvider,
} from "./CoHostDraftNotice";
import { StartSessionDraftButton } from "./StartSessionDraftButton";

vi.mock("@/server/setup/setupActions", () => ({
  startSessionDraft: vi.fn(),
}));

const startSessionDraftMock = vi.mocked(startSessionDraft);
const CO_HOST_NOTICE =
  "A co-host already started “Tuesday social”. You're editing it together.";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("starting a draft when a co-host already started one", () => {
  it("keeps the notice after the button gives way to the editor", async () => {
    startSessionDraftMock.mockResolvedValue({
      ok: true,
      notice: CO_HOST_NOTICE,
    });
    const { rerender } = render(
      <CoHostDraftNoticeProvider>
        <StartSessionDraftButton />
      </CoHostDraftNoticeProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start a new session" }),
    );
    await waitFor(() => expect(startSessionDraftMock).toHaveBeenCalledOnce());

    // The page re-renders with the editor (which shows the notice) instead of the button.
    rerender(
      <CoHostDraftNoticeProvider>
        <CoHostDraftNotice />
      </CoHostDraftNoticeProvider>,
    );
    expect(await screen.findByRole("status")).toHaveTextContent(CO_HOST_NOTICE);
  });

  it("shows nothing for a draft of the host's own", async () => {
    startSessionDraftMock.mockResolvedValue({ ok: true, notice: null });
    render(
      <CoHostDraftNoticeProvider>
        <StartSessionDraftButton />
        <CoHostDraftNotice />
      </CoHostDraftNoticeProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start a new session" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start a new session" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the error instead when the draft can't start", async () => {
    startSessionDraftMock.mockResolvedValue({
      ok: false,
      message:
        "Your social already has a live session. End it before setting up a new one.",
    });
    render(
      <CoHostDraftNoticeProvider>
        <StartSessionDraftButton />
        <CoHostDraftNotice />
      </CoHostDraftNoticeProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start a new session" }),
    );
    expect(
      await screen.findByText(
        "Your social already has a live session. End it before setting up a new one.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing outside a provider (the editor in isolation)", () => {
    render(<CoHostDraftNotice />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
