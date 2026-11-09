import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addClubCourt,
  discardSessionDraft,
  saveSessionDraft,
} from "@/server/setup/setupActions";
import type { ClubCourt, SessionDraft } from "@/server/setup/setupDraft";
import { SessionSetupEditor } from "./SessionSetupEditor";

vi.mock("@/server/setup/setupActions", () => ({
  saveSessionDraft: vi.fn(),
  discardSessionDraft: vi.fn(),
  addClubCourt: vi.fn(),
  startSessionDraft: vi.fn(),
}));

const saveSessionDraftMock = vi.mocked(saveSessionDraft);
const discardSessionDraftMock = vi.mocked(discardSessionDraft);
const addClubCourtMock = vi.mocked(addClubCourt);

const SESSION_ID = "d0000000-0000-4000-8000-000000000001";
const clubCourts: ClubCourt[] = [
  {
    id: "c0000000-0000-4000-8000-000000000001",
    name: "Court 1",
    supportedFormats: ["doubles", "singles"],
  },
  {
    id: "c0000000-0000-4000-8000-000000000002",
    name: "Court 2",
    supportedFormats: ["doubles", "singles"],
  },
  {
    id: "c0000000-0000-4000-8000-000000000003",
    name: "Singles court",
    supportedFormats: ["singles"],
  },
];

function draftWith(overrides: Partial<SessionDraft> = {}): SessionDraft {
  return {
    sessionId: SESSION_ID,
    name: "Saturday social",
    location: null,
    hostName: "Ryan H.",
    plannedStart: new Date(2026, 10, 7, 18, 0).toISOString(),
    plannedEnd: new Date(2026, 10, 7, 20, 0).toISOString(),
    config: {
      courts: [],
      matchFormat: "doubles",
      targetMatchMinutes: 15,
      changeoverMinutes: 2,
    },
    attendingPlayerCount: 0,
    attendingGuestCount: 0,
    ...overrides,
  };
}

function renderEditor(draft = draftWith()) {
  return render(
    <SessionSetupEditor draft={draft} initialClubCourts={clubCourts} />,
  );
}

const SAVE_WAIT = { timeout: 3000 };

describe("SessionSetupEditor", () => {
  beforeEach(() => {
    saveSessionDraftMock.mockReset();
    // Leaving with unsaved edits saves once more on unmount (cleanup).
    saveSessionDraftMock.mockResolvedValue({ ok: true });
    discardSessionDraftMock.mockReset();
    addClubCourtMock.mockReset();
  });

  afterEach(cleanup);

  it("starts as saved without saving again", async () => {
    renderEditor();
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveSessionDraftMock).not.toHaveBeenCalled();
  });

  it("sets the end time from a duration chip and saves after edits settle", async () => {
    saveSessionDraftMock.mockResolvedValue({ ok: true });
    renderEditor();

    const chip90 = screen.getByRole("button", { name: "90 min" });
    expect(screen.getByRole("button", { name: "120 min" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(chip90);
    expect(screen.getByLabelText("End time")).toHaveValue("19:30");
    expect(chip90).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText(/90 minutes, calculated from start and end/),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");

    await waitFor(
      () => expect(screen.getByRole("status")).toHaveTextContent("Saved"),
      SAVE_WAIT,
    );
    expect(saveSessionDraftMock).toHaveBeenCalledTimes(1);
    expect(saveSessionDraftMock.mock.calls[0][0]).toMatchObject({
      sessionId: SESSION_ID,
      plannedEnd: new Date(2026, 10, 7, 19, 30).toISOString(),
    });
  });

  it("recomputes the duration from a typed end time and marks it custom", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("End time"), {
      target: { value: "19:45" },
    });
    expect(
      screen.getByText(/105 minutes, calculated from start and end/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Custom · 105 min" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the length when the start moves", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Start time"), {
      target: { value: "18:30" },
    });
    expect(screen.getByLabelText("End time")).toHaveValue("20:30");
  });

  it("reads an earlier end time as the next day and saves it", async () => {
    saveSessionDraftMock.mockResolvedValue({ ok: true });
    renderEditor();
    fireEvent.change(screen.getByLabelText("End time"), {
      target: { value: "01:00" },
    });
    expect(screen.getByText("(next day)")).toBeInTheDocument();
    expect(screen.getByLabelText("End time")).toHaveAccessibleDescription(
      "(next day)",
    );
    expect(
      screen.getByText(/420 minutes, calculated from start and end/),
    ).toBeInTheDocument();
    await waitFor(
      () => expect(screen.getByRole("status")).toHaveTextContent("Saved"),
      SAVE_WAIT,
    );
    expect(saveSessionDraftMock.mock.calls[0][0]).toMatchObject({
      plannedEnd: new Date(2026, 10, 8, 1, 0).toISOString(),
    });
  });

  it("sets an overnight end from a chip late in the evening (23:00 + 120 min)", () => {
    renderEditor(
      draftWith({
        plannedStart: new Date(2026, 10, 7, 23, 0).toISOString(),
        plannedEnd: new Date(2026, 10, 8, 0, 30).toISOString(),
      }),
    );
    // A draft ending after midnight loads as valid.
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByText("(next day)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "120 min" }));
    expect(screen.getByLabelText("End time")).toHaveValue("01:00");
    expect(screen.getByRole("button", { name: "120 min" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByText(/must be after/)).not.toBeInTheDocument();
  });

  it("moves the end past midnight with the start, keeping the length", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Start time"), {
      target: { value: "22:30" },
    });
    expect(screen.getByLabelText("End time")).toHaveValue("00:30");
    expect(screen.getByText("(next day)")).toBeInTheDocument();
    expect(
      screen.getByText(/120 minutes, calculated from start and end/),
    ).toBeInTheDocument();
  });

  it("flags a session longer than 12 hours and doesn't save", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("End time"), {
      target: { value: "17:00" },
    });
    expect(screen.getByLabelText("End time")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      screen.getByText("A session can last at most 12 hours."),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Not saved: fix the highlighted fields",
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveSessionDraftMock).not.toHaveBeenCalled();
  });

  it("requires a session name", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "" },
    });
    expect(screen.getByText("Enter a session name.")).toBeInTheDocument();
  });

  it("says once, in the summary, when the session is shorter than one round", () => {
    renderEditor(
      draftWith({
        attendingPlayerCount: 8,
        config: {
          courts: [
            { courtId: clubCourts[0].id, name: "Court 1", format: "doubles" },
          ],
          matchFormat: "doubles",
          targetMatchMinutes: 15,
          changeoverMinutes: 2,
        },
      }),
    );
    fireEvent.change(screen.getByLabelText("End time"), {
      target: { value: "18:10" },
    });
    expect(screen.getAllByText(/Fewer than one full round/)).toHaveLength(1);
    expect(
      screen.getByText(
        "Fewer than one full round: a 15-minute match plus 2-minute changeover doesn't fit in 10 min.",
      ),
    ).toBeInTheDocument();
  });

  it("saves edits made during a save right after it, newest wins", async () => {
    let resolveFirstSave!: (result: { ok: false; message: string }) => void;
    saveSessionDraftMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstSave = resolve;
        }),
    );
    let resolveSecondSave!: (result: { ok: true }) => void;
    saveSessionDraftMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecondSave = resolve;
        }),
    );
    renderEditor();

    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "First edit" },
    });
    await waitFor(
      () => expect(saveSessionDraftMock).toHaveBeenCalledTimes(1),
      SAVE_WAIT,
    );
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Second edit" },
    });
    // The second edit settles while the first save is still open: it queues.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveSessionDraftMock).toHaveBeenCalledTimes(1);

    // The first (stale) result neither marks it saved nor failed.
    resolveFirstSave({ ok: false, message: "Stale failure" });
    await waitFor(() => expect(saveSessionDraftMock).toHaveBeenCalledTimes(2));
    expect(saveSessionDraftMock.mock.calls[1][0]).toMatchObject({
      name: "Second edit",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    expect(screen.queryByText(/Stale failure/)).not.toBeInTheDocument();

    resolveSecondSave({ ok: true });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Saved"),
    );
    expect(saveSessionDraftMock).toHaveBeenCalledTimes(2);
  });

  it("still saves an edit made just before leaving the page", () => {
    saveSessionDraftMock.mockResolvedValue({ ok: true });
    const { unmount } = renderEditor();
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Last-second edit" },
    });
    unmount();
    expect(saveSessionDraftMock).toHaveBeenCalledTimes(1);
    expect(saveSessionDraftMock.mock.calls[0][0]).toMatchObject({
      name: "Last-second edit",
    });
  });

  it("doesn't save on leaving when nothing changed or the edit is invalid", () => {
    const { unmount } = renderEditor();
    unmount();
    const second = renderEditor();
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "" },
    });
    second.unmount();
    expect(saveSessionDraftMock).not.toHaveBeenCalled();
  });

  it("asks before closing the tab only while there are unsaved edits", async () => {
    saveSessionDraftMock.mockResolvedValue({ ok: true });
    renderEditor();
    const fireBeforeUnload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fireBeforeUnload()).toBe(false);
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Unsaved" },
    });
    expect(fireBeforeUnload()).toBe(true);
    await waitFor(
      () => expect(screen.getByRole("status")).toHaveTextContent("Saved"),
      SAVE_WAIT,
    );
    // The listener is removed by an effect after the "Saved" render.
    await waitFor(() => expect(fireBeforeUnload()).toBe(false));
  });

  it("shows a failed save with a retry that saves again", async () => {
    saveSessionDraftMock.mockResolvedValueOnce({
      ok: false,
      message: "Something went wrong. Try again in a moment.",
    });
    renderEditor();
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Sunday social" },
    });
    await waitFor(
      () =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "Not saved. Something went wrong.",
        ),
      SAVE_WAIT,
    );

    saveSessionDraftMock.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(
      () => expect(screen.getByRole("status")).toHaveTextContent("Saved"),
      SAVE_WAIT,
    );
    expect(saveSessionDraftMock).toHaveBeenCalledTimes(2);
    expect(saveSessionDraftMock.mock.calls[1][0]).toMatchObject({
      name: "Sunday social",
    });
  });

  it("selects courts, updates the capacity line and limits formats to what the courts support", () => {
    renderEditor(
      draftWith({ attendingPlayerCount: 10, attendingGuestCount: 2 }),
    );
    const courtTile = (name: RegExp) => screen.getByRole("button", { name });

    // The singles-only court can't be picked for doubles, and looks disabled
    // per DESIGN.md (transparent, placeholder text) with the reason shown.
    expect(courtTile(/Singles court/)).toBeDisabled();
    expect(courtTile(/Singles court/)).toHaveClass(
      "bg-transparent",
      "text-placeholder",
      "border-inner-border",
    );
    expect(courtTile(/Singles court/)).toHaveTextContent("Singles only");
    fireEvent.click(courtTile(/Court 1/));
    fireEvent.click(screen.getByRole("button", { name: "Add a court" }));
    expect(courtTile(/Court 1/)).toHaveAttribute("aria-pressed", "true");
    expect(courtTile(/Court 2/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("2 courts").length).toBeGreaterThan(0);
    expect(screen.getByText("8 on court")).toBeInTheDocument();
    expect(screen.getByText("2 waiting")).toBeInTheDocument();

    // Singles: the singles-only court becomes available; doubles then isn't.
    fireEvent.click(screen.getByRole("button", { name: "Singles · 1 v 1" }));
    fireEvent.click(courtTile(/Singles court/));
    expect(
      screen.getByRole("button", { name: "Doubles · 2 v 2" }),
    ).toBeDisabled();
    expect(screen.getByText("6 on court")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove a court" }));
    expect(courtTile(/Singles court/)).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Doubles · 2 v 2" }),
    ).toBeEnabled();
  });

  it("summarises the session with the capacity diagram and the estimate", () => {
    renderEditor(
      draftWith({
        attendingPlayerCount: 15,
        attendingGuestCount: 1,
        config: {
          courts: clubCourts.slice(0, 2).map((court) => ({
            courtId: court.id,
            name: court.name,
            format: "doubles" as const,
          })),
          matchFormat: "doubles",
          targetMatchMinutes: 15,
          changeoverMinutes: 2,
        },
      }),
    );
    const summary = within(
      screen.getByRole("complementary", { name: "Session summary and start" }),
    );
    expect(summary.getByText("Sat 7 Nov · 18:00 – 20:00")).toBeInTheDocument();
    expect(summary.getByText("(14 members + 1 guest)")).toBeInTheDocument();
    expect(summary.getByText("2 · doubles")).toBeInTheDocument();
    const diagram = summary.getByRole("img", {
      name: "Capacity: 2 courts of 4 players, 8 on court, 7 waiting",
    });
    // Waiting dots: 3 grey, then the next 4 up in blue at the right-hand end.
    const waitingDotColours = Array.from(
      diagram.querySelectorAll(".bg-drag-handle, .bg-blue"),
      (dot) => (dot.classList.contains("bg-blue") ? "blue" : "grey"),
    );
    expect(waitingDotColours).toEqual([
      "grey",
      "grey",
      "grey",
      "blue",
      "blue",
      "blue",
      "blue",
    ]);
    expect(
      summary.getByText(/About 7 rounds fit in 120 min, so expect/),
    ).toHaveTextContent(
      "About 7 rounds fit in 120 min, so expect 3–4 games per player.",
    );
    expect(
      summary.getByRole("button", { name: /Start pickleball session/i }),
    ).toBeDisabled();
  });

  it("says when there are not enough players", () => {
    renderEditor(
      draftWith({
        config: {
          courts: [
            { courtId: clubCourts[0].id, name: "Court 1", format: "doubles" },
          ],
          matchFormat: "doubles",
          targetMatchMinutes: 15,
          changeoverMinutes: 2,
        },
      }),
    );
    expect(
      screen.getByText(
        "Not enough players: a court needs 4 and 0 are attending.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("No players attending yet.")).toBeInTheDocument();
  });

  it("adds a club court and selects it", async () => {
    saveSessionDraftMock.mockResolvedValue({ ok: true });
    addClubCourtMock.mockResolvedValue({
      ok: true,
      court: {
        id: "c0000000-0000-4000-8000-000000000004",
        name: "Court 4",
        supportedFormats: ["doubles", "singles"],
      },
    });
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add court" }));
    expect(screen.getByLabelText("Court name")).toHaveValue("Court 4");
    fireEvent.click(screen.getByRole("button", { name: "Singles" }));
    fireEvent.click(screen.getByRole("button", { name: "Add court" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Court 4/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(addClubCourtMock).toHaveBeenCalledWith({
      name: "Court 4",
      supportedFormats: ["doubles"],
    });
  });

  it("shows why adding a court failed", async () => {
    addClubCourtMock.mockResolvedValue({
      ok: false,
      message: "A court called Court 1 already exists. Choose another name.",
    });
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add court" }));
    fireEvent.change(screen.getByLabelText("Court name"), {
      target: { value: "Court 1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add court" }));
    expect(
      await screen.findByText(
        "A court called Court 1 already exists. Choose another name.",
      ),
    ).toBeInTheDocument();
  });

  it("discards only after confirming", async () => {
    discardSessionDraftMock.mockResolvedValue({ ok: true });
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(discardSessionDraftMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, discard" }));
    await waitFor(() =>
      expect(discardSessionDraftMock).toHaveBeenCalledWith(SESSION_ID),
    );
  });
});
