import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithLocale as render } from "@/i18n/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discardSessionDraft } from "@/server/setup/setupActions";
import { DiscardDraftButton } from "./DiscardDraftButton";
import {
  polyfillDialogForTests,
  pressEscapeOnDialog,
} from "./dialogTestPolyfill";

vi.mock("@/server/setup/setupActions", () => ({
  discardSessionDraft: vi.fn(),
}));

polyfillDialogForTests();

const discardSessionDraftMock = vi.mocked(discardSessionDraft);
const SESSION_ID = "d0000000-0000-4000-8000-000000000001";
const DRAFT_NOT_OPEN =
  "This draft is no longer open (it was discarded or started). Reload the page.";

function renderButton(overrides: { draftName?: string } = {}) {
  const onAutosavePausedChange = vi.fn();
  render(
    <DiscardDraftButton
      sessionId={SESSION_ID}
      draftName={overrides.draftName ?? "Saturday social"}
      plannedStart={new Date(2026, 10, 7, 18, 0)}
      plannedEnd={new Date(2026, 10, 7, 20, 0)}
      attendingPlayerCount={12}
      hostName="Ryan H."
      socialName="Riverside Picklers"
      onAutosavePausedChange={onAutosavePausedChange}
    />,
  );
  return { onAutosavePausedChange };
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  return screen.getByRole("dialog");
}

function understoodCheckbox() {
  return screen.getByRole("checkbox", {
    name: /I understand this discards/,
  });
}

function finalDiscardButton() {
  return screen.getByRole("button", { name: "Discard for all hosts" });
}

describe("DiscardDraftButton", () => {
  beforeEach(() => {
    discardSessionDraftMock.mockReset();
  });
  afterEach(cleanup);

  it("names the draft, the social and the impact on every co-host", () => {
    renderButton();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const dialog = openDialog();
    expect(dialog).toHaveAccessibleName("Discard “Saturday social”?");
    expect(dialog).toHaveAccessibleDescription(
      "This discards the draft for every host of Riverside Picklers, including anyone editing it right now. Its details, courts and players will be lost and can't be brought back.",
    );
    expect(dialog).toHaveTextContent(
      "Sat 7 Nov · 18:00 – 20:00 · 12 attending · Hosted by Ryan H.",
    );
    expect(understoodCheckbox()).toHaveAccessibleName(
      "I understand this discards “Saturday social” for all hosts",
    );
    expect(screen.getByRole("button", { name: "Keep draft" })).toHaveFocus();
  });

  it("calls an untitled draft untitled", () => {
    renderButton({ draftName: "   " });
    const dialog = openDialog();
    expect(dialog).toHaveAccessibleName("Discard this untitled draft?");
    expect(understoodCheckbox()).toHaveAccessibleName(
      "I understand this discards the untitled draft for all hosts",
    );
  });

  it("keeps the final button disabled until the host ticks the checkbox", () => {
    renderButton();
    openDialog();
    expect(finalDiscardButton()).toBeDisabled();
    fireEvent.click(finalDiscardButton());
    expect(discardSessionDraftMock).not.toHaveBeenCalled();
    fireEvent.click(understoodCheckbox());
    expect(finalDiscardButton()).toBeEnabled();
    fireEvent.click(understoodCheckbox());
    expect(finalDiscardButton()).toBeDisabled();
  });

  it.each([
    [
      "Keep draft",
      () => fireEvent.click(screen.getByRole("button", { name: "Keep draft" })),
    ],
    [
      "Esc",
      () =>
        pressEscapeOnDialog(screen.getByRole("dialog") as HTMLDialogElement),
    ],
    ["a backdrop click", () => fireEvent.click(screen.getByRole("dialog"))],
  ])(
    "%s closes without discarding or pausing autosave, and resets the checkbox",
    (_way, cancel) => {
      const { onAutosavePausedChange } = renderButton();
      openDialog();
      fireEvent.click(understoodCheckbox());
      cancel();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(discardSessionDraftMock).not.toHaveBeenCalled();
      expect(onAutosavePausedChange).not.toHaveBeenCalled();
      openDialog();
      expect(understoodCheckbox()).not.toBeChecked();
      expect(finalDiscardButton()).toBeDisabled();
    },
  );

  it("a click inside the dialog's content doesn't close it", () => {
    renderButton();
    const dialog = openDialog();
    fireEvent.click(screen.getByText(/This discards the draft/));
    expect(dialog).toHaveAttribute("open");
  });

  it("discards once after both confirmations, pausing autosave first", async () => {
    let resolveDiscard: (result: { ok: true }) => void = () => {};
    discardSessionDraftMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDiscard = resolve;
      }),
    );
    const { onAutosavePausedChange } = renderButton();
    openDialog();
    fireEvent.click(understoodCheckbox());
    fireEvent.click(finalDiscardButton());
    expect(onAutosavePausedChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(discardSessionDraftMock).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
    const pendingButton = await screen.findByRole("button", {
      name: "Discarding…",
    });
    expect(pendingButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep draft" })).toBeDisabled();
    // Esc can't close it mid-discard.
    pressEscapeOnDialog(screen.getByRole("dialog") as HTMLDialogElement);
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
    resolveDiscard({ ok: true });
    await waitFor(() =>
      expect(onAutosavePausedChange).toHaveBeenCalledTimes(1),
    );
    expect(discardSessionDraftMock).toHaveBeenCalledTimes(1);
  });

  it("shows a refusal in the open dialog and resumes autosave", async () => {
    discardSessionDraftMock.mockResolvedValue({
      ok: false,
      message: DRAFT_NOT_OPEN,
    });
    const { onAutosavePausedChange } = renderButton();
    const dialog = openDialog();
    fireEvent.click(understoodCheckbox());
    fireEvent.click(finalDiscardButton());
    expect(await screen.findByText(DRAFT_NOT_OPEN)).toBeInTheDocument();
    expect(dialog).toHaveAttribute("open");
    expect(onAutosavePausedChange.mock.calls).toEqual([[true], [false]]);
    // The message renders before the transition settles; the button re-enables when it does.
    await waitFor(() => expect(finalDiscardButton()).toBeEnabled());
  });

  it("says when the server can't be reached", async () => {
    discardSessionDraftMock.mockRejectedValue(new TypeError("fetch failed"));
    const { onAutosavePausedChange } = renderButton();
    openDialog();
    fireEvent.click(understoodCheckbox());
    fireEvent.click(finalDiscardButton());
    expect(
      await screen.findByText(
        "Couldn't reach the server. Check your connection.",
      ),
    ).toBeInTheDocument();
    expect(onAutosavePausedChange).toHaveBeenLastCalledWith(false);
  });
});
