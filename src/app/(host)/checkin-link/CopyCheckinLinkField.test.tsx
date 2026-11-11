import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COPIED_CONFIRMATION_VISIBLE_MS,
  CopyCheckinLinkField,
} from "./CopyCheckinLinkField";

const LINK = "https://pickleball.example/t/0123456789abcdef0123456789abcdef";

function setClipboard(
  clipboard: { writeText: (text: string) => Promise<void> } | undefined,
) {
  Object.defineProperty(navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
}

/** Lets the clipboard promise and React's update settle. */
async function settle() {
  await act(async () => {});
}

describe("CopyCheckinLinkField", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setClipboard(undefined);
  });

  it("shows the full link in a labelled, read-only field", () => {
    render(<CopyCheckinLinkField link={LINK} />);
    const input = screen.getByRole("textbox", { name: "Link" });
    expect(input).toHaveValue(LINK);
    expect(input).toHaveAttribute("readonly");
  });

  it("copies the link and shows Copied for a few seconds", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    render(<CopyCheckinLinkField link={LINK} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await settle();

    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(screen.getByText("Copied")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(COPIED_CONFIRMATION_VISIBLE_MS));
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("selects the link for copying by hand when the clipboard refuses", async () => {
    setClipboard({
      writeText: vi.fn(async () => {
        throw new Error("denied");
      }),
    });
    render(<CopyCheckinLinkField link={LINK} />);
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Link",
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await settle();

    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Couldn't copy automatically. The link is selected: copy it from there.",
      ),
    ).toBeInTheDocument();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(LINK.length);
  });

  it("falls back the same way without a clipboard (plain http)", async () => {
    setClipboard(undefined);
    render(<CopyCheckinLinkField link={LINK} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await settle();
    expect(screen.getByText(/The link is selected/)).toBeInTheDocument();
  });
});
