import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderWithLocale as render } from "@/i18n/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reissueCheckinLink } from "@/server/checkin/checkinLinkActions";
import {
  polyfillDialogForTests,
  pressEscapeOnDialog,
} from "../setup/dialogTestPolyfill";
import { CheckinLinkCard, type CheckinLinkCardLink } from "./CheckinLinkCard";

vi.mock("@/server/checkin/checkinLinkActions", () => ({
  reissueCheckinLink: vi.fn(),
}));

polyfillDialogForTests();

const reissueMock = vi.mocked(reissueCheckinLink);
const SHORT_LINK = "pickleball.example/t/0123456789abcdef0123456789abcdef";

function renderCard(
  canIssueNewLink: boolean,
  checkinLink: CheckinLinkCardLink = {
    status: "loaded",
    shortLink: SHORT_LINK,
  },
) {
  render(
    <CheckinLinkCard
      checkinLink={checkinLink}
      socialName="Riverside Picklers"
      canIssueNewLink={canIssueNewLink}
    />,
  );
}

/** The card's trigger (the dialog's confirm button has the same name). */
function issueNewLinkTrigger() {
  return screen
    .getAllByRole("button", { name: "Issue new link" })
    .find((button) => button.getAttribute("aria-haspopup") === "dialog")!;
}

function openDialog() {
  fireEvent.click(issueNewLinkTrigger());
  return screen.getByRole("dialog", { name: "Issue a new check-in link?" });
}

function dialogButton(name: string) {
  return within(screen.getByRole("dialog")).getByRole("button", { name });
}

describe("CheckinLinkCard", () => {
  beforeEach(() => {
    reissueMock.mockReset();
  });
  afterEach(cleanup);

  it("shows every host the link and Open Sticker and QR", () => {
    renderCard(false);
    expect(
      screen.getByRole("heading", { name: "Check-in link" }),
    ).toBeInTheDocument();
    expect(screen.getByText(SHORT_LINK)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open Sticker and QR" }),
    ).toHaveAttribute("href", "/checkin-link");
  });

  it("hides Issue new link and its explanation from an operational host", () => {
    renderCard(false);
    expect(
      screen.queryByRole("button", { name: "Issue new link" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Issue a new link if the old one was shared/),
    ).not.toBeInTheDocument();
  });

  it("keeps the card working when the link couldn't be read", () => {
    renderCard(true, { status: "failed" });
    expect(
      screen.getByText("Couldn't load the check-in link."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open Sticker and QR" }),
    ).toBeInTheDocument();
    expect(issueNewLinkTrigger()).toBeInTheDocument();
  });

  it("says the link is loading while it streams in", () => {
    renderCard(false, { status: "loading" });
    expect(screen.getByText("Loading the check-in link…")).toBeInTheDocument();
    expect(screen.queryByText(SHORT_LINK)).not.toBeInTheDocument();
  });

  it("shows a manager the explanation and Issue new link", () => {
    renderCard(true);
    expect(
      screen.getByText(
        "Issue a new link if the old one was shared where it shouldn't be. The current link, QR code and every printed sticker stop working.",
      ),
    ).toBeInTheDocument();
    expect(issueNewLinkTrigger()).toBeInTheDocument();
  });
});

describe("Issue new link dialog", () => {
  beforeEach(() => {
    reissueMock.mockReset();
  });
  afterEach(cleanup);

  it("opens with the copy deck's words and focus on Cancel", () => {
    renderCard(true);
    const dialog = openDialog();
    expect(dialog).toHaveTextContent("Riverside Picklers");
    expect(dialog).toHaveAccessibleDescription(
      "The current link and QR code stop working immediately, including every printed and NFC sticker. Anyone who uses them sees “This check-in link isn't active”.",
    );
    expect(dialog).toHaveTextContent(
      "Afterwards, print new stickers from the Sticker and QR page and replace the old ones. Check-ins already sent are not affected.",
    );
    expect(dialogButton("Cancel")).toHaveFocus();
  });

  it("Cancel and Esc close it without issuing anything", () => {
    renderCard(true);
    let dialog = openDialog();
    fireEvent.click(dialogButton("Cancel"));
    expect(dialog).not.toHaveAttribute("open");

    dialog = openDialog();
    pressEscapeOnDialog(dialog as HTMLDialogElement);
    expect(dialog).not.toHaveAttribute("open");
    expect(reissueMock).not.toHaveBeenCalled();
  });

  it("issues a new link, closes and confirms", async () => {
    reissueMock.mockResolvedValue({ ok: true });
    renderCard(true);
    const dialog = openDialog();
    fireEvent.click(dialogButton("Issue new link"));

    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(reissueMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        "New link issued. The old link, QR code and stickers no longer work.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the dialog open with the refusal when the server says no", async () => {
    reissueMock.mockResolvedValue({
      ok: false,
      message: "Only the social manager can do this.",
    });
    renderCard(true);
    const dialog = openDialog();
    fireEvent.click(dialogButton("Issue new link"));

    expect(
      await screen.findByText("Only the social manager can do this."),
    ).toBeInTheDocument();
    expect(dialog).toHaveAttribute("open");
    expect(screen.queryByText(/New link issued/)).not.toBeInTheDocument();
  });

  it("shows a refusal under the button when the browser closed the dialog mid-request, and the next opening starts clean", async () => {
    let answer: (result: { ok: false; message: string }) => void = () => {};
    reissueMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderCard(true);
    const dialog = openDialog() as HTMLDialogElement;
    fireEvent.click(dialogButton("Issue new link"));
    // What Chrome does on a second Esc: the dialog closes despite preventDefault.
    act(() => dialog.close());
    await act(async () =>
      answer({ ok: false, message: "Only the social manager can do this." }),
    );

    const refusal = screen.getByText("Only the social manager can do this.");
    expect(dialog).not.toContainElement(refusal);

    openDialog();
    expect(
      screen.queryByText("Only the social manager can do this."),
    ).not.toBeInTheDocument();
  });

  it("says when the server can't be reached", async () => {
    reissueMock.mockRejectedValue(new Error("network"));
    renderCard(true);
    openDialog();
    fireEvent.click(dialogButton("Issue new link"));
    expect(
      await screen.findByText(
        "Couldn't reach the server. Check your connection.",
      ),
    ).toBeInTheDocument();
  });
});
