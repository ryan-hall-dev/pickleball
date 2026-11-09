import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addClubCourt,
  applySavedSetup,
  discardSessionDraft,
  saveSessionDraft,
  saveSetup,
} from "@/server/setup/setupActions";
import type {
  ClubCourt,
  DraftParticipant,
  SavedSetupSummary,
  SessionDraft,
} from "@/server/setup/setupDraft";
import type { RotationObjective } from "@/engine";
import { recommendedRotationPreferences } from "@/server/setup/setupRules";
import { SessionSetupEditor } from "./SessionSetupEditor";

vi.mock("@/server/setup/setupActions", () => ({
  saveSessionDraft: vi.fn(),
  discardSessionDraft: vi.fn(),
  addClubCourt: vi.fn(),
  startSessionDraft: vi.fn(),
  setDraftMemberAttendance: vi.fn(),
  addDraftGuest: vi.fn(),
  removeDraftGuest: vi.fn(),
  saveSetup: vi.fn(),
  applySavedSetup: vi.fn(),
}));

const saveSessionDraftMock = vi.mocked(saveSessionDraft);
const discardSessionDraftMock = vi.mocked(discardSessionDraft);
const addClubCourtMock = vi.mocked(addClubCourt);
const saveSetupMock = vi.mocked(saveSetup);
const applySavedSetupMock = vi.mocked(applySavedSetup);

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

/** An attendee list of `memberCount` members and `guestCount` guests. */
function participantsFor(
  memberCount: number,
  guestCount: number,
): DraftParticipant[] {
  const participant = (index: number, isGuest: boolean): DraftParticipant => ({
    participantId: `e0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    memberId: isGuest
      ? null
      : `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    isGuest,
    firstName: isGuest ? "Guest" : "Member",
    lastName: String(index),
    skillLevel: null,
    isMemberActive: isGuest ? null : true,
  });
  return [
    ...Array.from({ length: memberCount }, (_, index) =>
      participant(index, false),
    ),
    ...Array.from({ length: guestCount }, (_, index) =>
      participant(memberCount + index, true),
    ),
  ];
}

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
      rotation: recommendedRotationPreferences(),
      appliedSavedSetupId: null,
    },
    participants: [],
    draftRevision: 0,
    ...overrides,
  };
}

/**
 * The autosave status. Scoped to the rendered editor: dnd-kit's drag
 * announcements are another (visually hidden) status region, portalled to
 * the end of <body>.
 */
function saveStatus() {
  return within(document.body.firstElementChild as HTMLElement).getByRole(
    "status",
  );
}

function renderEditor(
  draft = draftWith(),
  savedSetups: SavedSetupSummary[] = [],
) {
  return render(
    <SessionSetupEditor
      draft={draft}
      initialClubCourts={clubCourts}
      activeMembers={[]}
      canAddCourts
      initialSavedSetups={savedSetups}
    />,
  );
}

const SAVE_WAIT = { timeout: 3000 };

describe("SessionSetupEditor", () => {
  beforeEach(() => {
    saveSessionDraftMock.mockReset();
    // Leaving with unsaved edits saves once more on unmount (cleanup).
    saveSessionDraftMock.mockResolvedValue({ ok: true, draftRevision: 1 });
    discardSessionDraftMock.mockReset();
    addClubCourtMock.mockReset();
    saveSetupMock.mockReset();
    applySavedSetupMock.mockReset();
  });

  afterEach(cleanup);

  it("starts as saved without saving again", async () => {
    renderEditor();
    expect(saveStatus()).toHaveTextContent("Saved");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveSessionDraftMock).not.toHaveBeenCalled();
  });

  it("sets the end time from a duration chip and saves after edits settle", async () => {
    saveSessionDraftMock.mockResolvedValue({ ok: true, draftRevision: 1 });
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
    expect(saveStatus()).toHaveTextContent("Saving…");

    await waitFor(
      () => expect(saveStatus()).toHaveTextContent("Saved"),
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
    saveSessionDraftMock.mockResolvedValue({ ok: true, draftRevision: 1 });
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
      () => expect(saveStatus()).toHaveTextContent("Saved"),
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
    expect(saveStatus()).toHaveTextContent("Saved");
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
    expect(saveStatus()).toHaveTextContent(
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
        participants: participantsFor(8, 0),
        config: {
          courts: [
            { courtId: clubCourts[0].id, name: "Court 1", format: "doubles" },
          ],
          matchFormat: "doubles",
          targetMatchMinutes: 15,
          changeoverMinutes: 2,
          rotation: recommendedRotationPreferences(),
          appliedSavedSetupId: null,
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
    let resolveSecondSave!: (result: {
      ok: true;
      draftRevision: number;
    }) => void;
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
    expect(saveStatus()).toHaveTextContent("Saving…");
    expect(screen.queryByText(/Stale failure/)).not.toBeInTheDocument();

    resolveSecondSave({ ok: true, draftRevision: 2 });
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
    expect(saveSessionDraftMock).toHaveBeenCalledTimes(2);
  });

  it("still saves an edit made just before leaving the page", () => {
    saveSessionDraftMock.mockResolvedValue({ ok: true, draftRevision: 1 });
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
    saveSessionDraftMock.mockResolvedValue({ ok: true, draftRevision: 1 });
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
      () => expect(saveStatus()).toHaveTextContent("Saved"),
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
        expect(saveStatus()).toHaveTextContent(
          "Not saved. Something went wrong.",
        ),
      SAVE_WAIT,
    );

    saveSessionDraftMock.mockResolvedValueOnce({ ok: true, draftRevision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(
      () => expect(saveStatus()).toHaveTextContent("Saved"),
      SAVE_WAIT,
    );
    expect(saveSessionDraftMock).toHaveBeenCalledTimes(2);
    expect(saveSessionDraftMock.mock.calls[1][0]).toMatchObject({
      name: "Sunday social",
    });
  });

  it("selects courts, updates the capacity line and limits formats to what the courts support", () => {
    renderEditor(draftWith({ participants: participantsFor(8, 2) }));
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
        participants: participantsFor(14, 1),
        config: {
          courts: clubCourts.slice(0, 2).map((court) => ({
            courtId: court.id,
            name: court.name,
            format: "doubles" as const,
          })),
          matchFormat: "doubles",
          targetMatchMinutes: 15,
          changeoverMinutes: 2,
          rotation: recommendedRotationPreferences(),
          appliedSavedSetupId: null,
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
    // Ready: the stepper, checklist and START agree.
    expect(
      within(summary.getByRole("list", { name: "Setup checklist" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Done: Session details complete",
      "Done: Enough players for all 2 courts",
    ]);
    expect(
      summary.getByRole("button", { name: /Start pickleball session/i }),
    ).toBeEnabled();
    expect(
      within(screen.getByRole("list", { name: "Setup steps" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Details, done",
      "Courts, done",
      "Players, done",
      "Rotation, done",
      "5Review & start, ready",
    ]);
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
          rotation: recommendedRotationPreferences(),
          appliedSavedSetupId: null,
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
    saveSessionDraftMock.mockResolvedValue({ ok: true, draftRevision: 1 });
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

  it("autosaves rotation changes with the draft and shows the top priority in the summary", async () => {
    saveSessionDraftMock.mockResolvedValue({ ok: true, draftRevision: 1 });
    renderEditor();
    const summary = within(
      screen.getByRole("complementary", { name: "Session summary and start" }),
    );
    expect(summary.getByText("Equal games first")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Move Shortest waits up" }),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Allow manual assignments" }),
    );
    expect(summary.getByText("Shortest waits first")).toBeInTheDocument();
    await waitFor(
      () => expect(saveStatus()).toHaveTextContent("Saved"),
      SAVE_WAIT,
    );
    expect(saveSessionDraftMock).toHaveBeenCalledTimes(1);
    expect(saveSessionDraftMock.mock.calls[0][0].rotation).toEqual({
      objectiveOrder: [
        "shortestWaits",
        "equalGames",
        "playingTime",
        "fullCourts",
        "noBackToBack",
        "mixPartners",
      ],
      rules: {
        ...recommendedRotationPreferences().rules,
        allowManualAssignments: false,
      },
    });
  });

  it("loads a draft's saved rotation", () => {
    renderEditor(
      draftWith({
        config: {
          ...draftWith().config,
          rotation: {
            objectiveOrder: [
              "mixPartners",
              "equalGames",
              "shortestWaits",
              "playingTime",
              "fullCourts",
              "noBackToBack",
            ],
            rules: {
              ...recommendedRotationPreferences().rules,
              longestWaitFirst: false,
            },
          },
        },
      }),
    );
    expect(saveStatus()).toHaveTextContent("Saved");
    expect(
      screen.getByRole("button", { name: "Move Mix up partners up" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Favour longer waits" }),
    ).toHaveAttribute("aria-checked", "false");
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

  describe("changes made in another tab or device", () => {
    const CONFLICT = {
      ok: false as const,
      message:
        "Setup was changed in another tab or by another device. Reload to see the latest \u2014 your unsaved changes here will be lost.",
      isConflict: true as const,
    };

    it("builds each save on the revision the last one returned", async () => {
      saveSessionDraftMock
        .mockResolvedValueOnce({ ok: true, draftRevision: 8 })
        .mockResolvedValueOnce({ ok: true, draftRevision: 9 });
      renderEditor(draftWith({ draftRevision: 7 }));
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "First" },
      });
      await waitFor(
        () => expect(saveStatus()).toHaveTextContent("Saved"),
        SAVE_WAIT,
      );
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Second" },
      });
      await waitFor(
        () => expect(saveSessionDraftMock).toHaveBeenCalledTimes(2),
        SAVE_WAIT,
      );
      expect(saveSessionDraftMock.mock.calls.map((call) => call[1])).toEqual([
        7, 8,
      ]);
    });

    it("stops autosaving, keeps the edits and offers a reload", async () => {
      saveSessionDraftMock.mockResolvedValue(CONFLICT);
      const { unmount } = renderEditor();
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Stale tab edit" },
      });
      const banner = await screen.findByRole(
        "region",
        { name: "Setup changed elsewhere" },
        SAVE_WAIT,
      );
      expect(banner).toHaveTextContent(
        "Setup was changed in another tab or by another device. Reload to see the latest \u2014 your unsaved changes here will be lost.",
      );
      expect(
        within(banner).getByRole("button", { name: "Reload" }),
      ).toBeInTheDocument();
      expect(saveStatus()).toHaveTextContent("! Not saved: changed elsewhere");
      expect(screen.getByLabelText("Session name")).toHaveValue(
        "Stale tab edit",
      );

      // No more writes: not on further edits, not on leaving the page.
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Another edit" },
      });
      fireEvent.click(
        screen.getByRole("switch", { name: "Allow manual assignments" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 900));
      const beforeUnload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(beforeUnload);
      expect(beforeUnload.defaultPrevented).toBe(true);
      unmount();
      expect(saveSessionDraftMock).toHaveBeenCalledTimes(1);
    });

    it("saves on being hidden (cached route) and keeps the new revision on return", async () => {
      saveSessionDraftMock
        .mockResolvedValueOnce({ ok: true, draftRevision: 1 })
        .mockResolvedValueOnce({ ok: true, draftRevision: 2 });
      const editor = (mode: "visible" | "hidden") => (
        <Activity mode={mode}>
          <SessionSetupEditor
            draft={draftWith()}
            initialClubCourts={clubCourts}
            activeMembers={[]}
            canAddCourts
            initialSavedSetups={[]}
          />
        </Activity>
      );
      const { rerender } = render(editor("visible"));
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Before hiding" },
      });
      // Navigating away within the autosave delay: Next hides the route.
      rerender(editor("hidden"));
      await waitFor(() =>
        expect(saveSessionDraftMock).toHaveBeenCalledTimes(1),
      );
      expect(saveSessionDraftMock.mock.calls[0]).toEqual([
        expect.objectContaining({ name: "Before hiding" }),
        0,
      ]);

      rerender(editor("visible"));
      await new Promise((resolve) => setTimeout(resolve, 900));
      // Nothing re-saved on return: the hidden flush counted as saved.
      expect(saveSessionDraftMock).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "After return" },
      });
      await waitFor(
        () => expect(saveSessionDraftMock).toHaveBeenCalledTimes(2),
        SAVE_WAIT,
      );
      expect(saveSessionDraftMock.mock.calls[1][1]).toBe(1);
      await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
      expect(
        screen.queryByRole("region", { name: "Setup changed elsewhere" }),
      ).not.toBeInTheDocument();
    });

    it("offers no saved-setup actions after a conflict", async () => {
      saveSessionDraftMock.mockResolvedValue(CONFLICT);
      renderEditor(draftWith(), [
        {
          setupId: "f0000000-0000-4000-8000-000000000001",
          name: "Saturday Social",
          lastUsedAt: new Date(2026, 9, 31, 20, 0).toISOString(),
          courtCount: 2,
          topObjective: "shortestWaits",
        },
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Saved setups" }));
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Stale edit" },
      });
      await screen.findByRole(
        "region",
        { name: "Setup changed elsewhere" },
        SAVE_WAIT,
      );
      expect(
        screen.getByRole("button", { name: "Save this setup" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Saved setups" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Use Saturday Social" }),
      ).toBeDisabled();
      expect(
        screen.queryByRole("region", { name: "Reuse a saved setup" }),
      ).not.toBeInTheDocument();
      expect(applySavedSetupMock).not.toHaveBeenCalled();
    });

    it("applies nothing when the draft changed elsewhere", async () => {
      applySavedSetupMock.mockResolvedValue(CONFLICT);
      renderEditor(draftWith({ draftRevision: 4 }), [
        {
          setupId: "f0000000-0000-4000-8000-000000000001",
          name: "Saturday Social",
          lastUsedAt: new Date(2026, 9, 31, 20, 0).toISOString(),
          courtCount: 2,
          topObjective: "shortestWaits",
        },
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Use this setup" }));
      expect(
        await screen.findByRole("region", { name: "Setup changed elsewhere" }),
      ).toBeInTheDocument();
      expect(applySavedSetupMock).toHaveBeenCalledWith(
        expect.objectContaining({ expectedDraftRevision: 4 }),
      );
      expect(screen.getByLabelText("Session name")).toHaveValue(
        "Saturday social",
      );
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Edit after conflict" },
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(saveSessionDraftMock).not.toHaveBeenCalled();
    });
  });

  describe("stepper and checklist", () => {
    it("shows Players · 1 to fix for a half-filled guest form, and START waits", () => {
      renderEditor(
        draftWith({
          participants: participantsFor(8, 0),
          config: {
            ...draftWith().config,
            courts: [
              { courtId: clubCourts[0].id, name: "Court 1", format: "doubles" },
            ],
          },
        }),
      );
      const start = screen.getByRole("button", {
        name: /Start pickleball session/i,
      });
      expect(start).toBeEnabled();

      fireEvent.change(screen.getByLabelText("First name"), {
        target: { value: "Kai" },
      });
      const steps = within(screen.getByRole("list", { name: "Setup steps" }));
      expect(steps.getByText(/Players · 1 to fix/)).toHaveTextContent(
        "Players · 1 to fix, needs attention",
      );
      expect(
        screen.getByText(
          "Guest form has an unfinished entry: add Kai's last name or clear it",
        ),
      ).toBeInTheDocument();
      expect(start).toBeDisabled();
      expect(
        screen.getByText("Finish the checklist to start."),
      ).toBeInTheDocument();

      // Clearing the entry fixes it.
      fireEvent.change(screen.getByLabelText("First name"), {
        target: { value: "" },
      });
      expect(steps.getByText(/^Players/)).toHaveTextContent("Players, done");
      expect(start).toBeEnabled();
    });

    it("enables START only once saved, and says what it will do when pressed", async () => {
      renderEditor(
        draftWith({
          participants: participantsFor(8, 0),
          config: {
            ...draftWith().config,
            courts: [
              { courtId: clubCourts[0].id, name: "Court 1", format: "doubles" },
            ],
          },
        }),
      );
      const start = screen.getByRole("button", {
        name: /Start pickleball session/i,
      });
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Renamed" },
      });
      expect(start).toBeDisabled();
      expect(
        screen.getByText("Waiting for your changes to save."),
      ).toBeInTheDocument();
      await waitFor(() => expect(start).toBeEnabled(), SAVE_WAIT);

      fireEvent.click(start);
      expect(
        screen.getByText(
          "Starting a session arrives in the next update. Your setup is saved.",
        ),
      ).toHaveAttribute("role", "status");
    });

    it("a new draft: courts and players not started, and START is off", () => {
      renderEditor();
      expect(
        within(screen.getByRole("list", { name: "Setup steps" }))
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "Details, done",
        "2Courts, not started",
        "3Players, not started",
        "Rotation, done",
        "5Review & start, not started",
      ]);
      expect(screen.getByText("Add at least one court")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Start pickleball session/i }),
      ).toBeDisabled();
    });
  });

  describe("saved setups", () => {
    const saturdaySetup: SavedSetupSummary = {
      setupId: "f0000000-0000-4000-8000-000000000001",
      name: "Saturday Social",
      lastUsedAt: new Date(2026, 9, 31, 20, 0).toISOString(),
      courtCount: 2,
      topObjective: "shortestWaits",
    };
    const thursdaySetup: SavedSetupSummary = {
      setupId: "f0000000-0000-4000-8000-000000000002",
      name: "Thursday Ladder",
      lastUsedAt: new Date(2026, 9, 20, 20, 0).toISOString(),
      courtCount: 1,
      topObjective: "equalGames",
    };

    it("offers the most recent setup in the reuse banner until dismissed", () => {
      renderEditor(draftWith(), [saturdaySetup, thursdaySetup]);
      const banner = screen.getByRole("region", {
        name: "Reuse a saved setup",
      });
      expect(banner).toHaveTextContent(
        "Reuse \u201cSaturday Social\u201d · last used 31 Oct · 2 courts · Shortest waits first",
      );
      fireEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));
      expect(
        screen.queryByRole("region", { name: "Reuse a saved setup" }),
      ).not.toBeInTheDocument();
    });

    it("doesn't offer a setup when there are none, or one was already applied", () => {
      renderEditor();
      expect(
        screen.queryByRole("region", { name: "Reuse a saved setup" }),
      ).not.toBeInTheDocument();
      cleanup();
      renderEditor(
        draftWith({
          config: {
            ...draftWith().config,
            appliedSavedSetupId: saturdaySetup.setupId,
          },
        }),
        [saturdaySetup],
      );
      expect(
        screen.queryByRole("region", { name: "Reuse a saved setup" }),
      ).not.toBeInTheDocument();
    });

    it("lists saved setups, with an empty state", () => {
      renderEditor();
      fireEvent.click(screen.getByRole("button", { name: "Saved setups" }));
      expect(screen.getByText(/No saved setups yet/)).toBeInTheDocument();
      cleanup();
      renderEditor(draftWith(), [saturdaySetup, thursdaySetup]);
      const toggle = screen.getByRole("button", { name: "Saved setups" });
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      const list = screen.getByRole("region", { name: "Saved setups" });
      expect(
        within(list)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "Saturday Sociallast used 31 Oct · 2 courts · Shortest waits firstUse",
        "Thursday Ladderlast used 20 Oct · 1 court · Equal games firstUse",
      ]);
    });

    it("saves the latest edits first, applies the setup and takes the server's draft", async () => {
      const callOrder: string[] = [];
      saveSessionDraftMock.mockImplementation(async () => {
        callOrder.push("saveSessionDraft");
        return { ok: true as const, draftRevision: 1 };
      });
      const appliedRotation = {
        ...recommendedRotationPreferences(),
        objectiveOrder: [
          "shortestWaits",
          "equalGames",
          "playingTime",
          "fullCourts",
          "noBackToBack",
          "mixPartners",
        ] as RotationObjective[],
      };
      applySavedSetupMock.mockImplementation(async () => {
        callOrder.push("applySavedSetup");
        return {
          ok: true,
          notice: "Court 5 is no longer available and was left out.",
          savedSetups: [saturdaySetup],
          draft: draftWith({
            name: "Edited name",
            location: "Riverside courts",
            plannedEnd: new Date(2026, 10, 7, 19, 30).toISOString(),
            config: {
              courts: [
                {
                  courtId: clubCourts[1].id,
                  name: "Court 2",
                  format: "doubles",
                },
              ],
              matchFormat: "doubles",
              targetMatchMinutes: 12,
              changeoverMinutes: 3,
              rotation: appliedRotation,
              appliedSavedSetupId: saturdaySetup.setupId,
            },
          }),
        };
      });
      renderEditor(draftWith(), [saturdaySetup]);

      // An edit still waiting for the autosave delay.
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Edited name" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Use this setup" }));
      expect(
        await screen.findByText(
          "Using \u201cSaturday Social\u201d. Court 5 is no longer available and was left out.",
        ),
      ).toBeInTheDocument();
      expect(callOrder).toEqual(["saveSessionDraft", "applySavedSetup"]);
      expect(saveSessionDraftMock.mock.calls[0][0]).toMatchObject({
        name: "Edited name",
      });
      // Loaded at revision 0; the flush saved revision 1; apply builds on it.
      expect(saveSessionDraftMock.mock.calls[0][1]).toBe(0);
      expect(applySavedSetupMock).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        setupId: saturdaySetup.setupId,
        expectedDraftRevision: 1,
      });

      // The editor shows the applied values, and they count as saved.
      expect(screen.getByLabelText("Location (optional)")).toHaveValue(
        "Riverside courts",
      );
      expect(screen.getByLabelText("End time")).toHaveValue("19:30");
      expect(screen.getByRole("button", { name: /Court 2/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByRole("button", { name: "Move Shortest waits up" }),
      ).toBeDisabled();
      expect(
        screen.queryByRole("region", { name: "Reuse a saved setup" }),
      ).not.toBeInTheDocument();
      expect(saveStatus()).toHaveTextContent("Saved");
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(saveSessionDraftMock).toHaveBeenCalledTimes(1);
    });

    it("refuses to apply over invalid edits and changes nothing", async () => {
      renderEditor(draftWith(), [saturdaySetup]);
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Use this setup" }));
      expect(
        await screen.findByText(
          "Fix the highlighted fields first, then use \u201cSaturday Social\u201d.",
        ),
      ).toBeInTheDocument();
      expect(applySavedSetupMock).not.toHaveBeenCalled();
      expect(saveSessionDraftMock).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Session name")).toHaveValue("");
      expect(
        screen.getByRole("region", { name: "Reuse a saved setup" }),
      ).toBeInTheDocument();
    });

    it("waits for a save in flight, keeps that edit, and locks the form while applying", async () => {
      let resolveSave!: (result: { ok: true; draftRevision: number }) => void;
      saveSessionDraftMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          }),
      );
      let resolveApply!: (
        result: Awaited<ReturnType<typeof applySavedSetup>>,
      ) => void;
      applySavedSetupMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveApply = resolve;
          }),
      );
      renderEditor(draftWith(), [saturdaySetup]);
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Kept edit" },
      });
      await waitFor(
        () => expect(saveSessionDraftMock).toHaveBeenCalledTimes(1),
        SAVE_WAIT,
      );

      fireEvent.click(screen.getByRole("button", { name: "Use this setup" }));
      // Locked while applying.
      expect(screen.getByLabelText("Session name")).toBeDisabled();
      expect(
        screen.getByRole("switch", { name: "Allow manual assignments" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Save this setup" }),
      ).toBeDisabled();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(applySavedSetupMock).not.toHaveBeenCalled();

      resolveSave({ ok: true, draftRevision: 1 });
      await waitFor(() => expect(applySavedSetupMock).toHaveBeenCalledTimes(1));
      // The in-flight save carried the edit, so nothing was saved twice.
      expect(saveSessionDraftMock).toHaveBeenCalledTimes(1);
      expect(saveSessionDraftMock.mock.calls[0][0]).toMatchObject({
        name: "Kept edit",
      });

      resolveApply({
        ok: true,
        notice: null,
        savedSetups: [saturdaySetup],
        draft: draftWith({
          name: "Kept edit",
          config: {
            ...draftWith().config,
            appliedSavedSetupId: saturdaySetup.setupId,
          },
        }),
      });
      expect(
        await screen.findByText("Using \u201cSaturday Social\u201d."),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Session name")).toHaveValue("Kept edit");
      expect(screen.getByLabelText("Session name")).toBeEnabled();
    });

    it("keeps a court added since the page loaded", async () => {
      applySavedSetupMock.mockResolvedValue({
        ok: true,
        notice: null,
        savedSetups: [saturdaySetup],
        draft: draftWith({
          config: {
            ...draftWith().config,
            courts: [
              {
                courtId: "c0000000-0000-4000-8000-000000000009",
                name: "New court",
                format: "doubles",
              },
            ],
            appliedSavedSetupId: saturdaySetup.setupId,
          },
        }),
      });
      renderEditor(draftWith(), [saturdaySetup]);
      fireEvent.click(screen.getByRole("button", { name: "Use this setup" }));
      expect(
        await screen.findByRole("button", { name: /New court/ }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(saveStatus()).toHaveTextContent("Saved");
    });

    it("says to reload, and stops autosaving, when the setup applied but couldn't be read back", async () => {
      applySavedSetupMock.mockResolvedValue({
        ok: false,
        message:
          "The setup was applied, but the page couldn't refresh. Reload the page.",
        requiresReload: true,
      });
      renderEditor(draftWith(), [saturdaySetup]);
      fireEvent.click(screen.getByRole("button", { name: "Use this setup" }));
      await waitFor(() =>
        expect(saveStatus()).toHaveTextContent("! Not saved: reload the page"),
      );
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Stale edit" },
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(saveSessionDraftMock).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: /Start pickleball session/i }),
      ).toBeDisabled();
    });

    it("doesn't apply when the latest edits can't be saved first", async () => {
      saveSessionDraftMock.mockResolvedValue({
        ok: false,
        message: "Something went wrong. Try again in a moment.",
      });
      renderEditor(draftWith(), [saturdaySetup]);
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Edited name" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Use this setup" }));
      expect(
        await screen.findByText(
          /Your latest edits couldn't be saved, so \u201cSaturday Social\u201d wasn't applied/,
        ),
      ).toBeInTheDocument();
      expect(applySavedSetupMock).not.toHaveBeenCalled();
    });

    it("saves this setup under a name, validating it first", async () => {
      saveSetupMock.mockResolvedValue({
        ok: true,
        message: "Replaced \u201cSaturday social\u201d.",
        savedSetups: [saturdaySetup],
      });
      renderEditor();
      fireEvent.click(screen.getByRole("button", { name: "Save this setup" }));
      const nameInput = screen.getByLabelText("Setup name");
      expect(nameInput).toHaveValue("Saturday social");

      fireEvent.change(nameInput, { target: { value: "  " } });
      fireEvent.click(screen.getByRole("button", { name: "Save setup" }));
      expect(nameInput).toHaveAttribute("aria-invalid", "true");
      expect(nameInput).toHaveAccessibleDescription("Name this setup.");
      expect(saveSetupMock).not.toHaveBeenCalled();

      fireEvent.change(nameInput, { target: { value: "Saturday social" } });
      fireEvent.click(screen.getByRole("button", { name: "Save setup" }));
      expect(
        await screen.findByText("Replaced \u201cSaturday social\u201d."),
      ).toBeInTheDocument();
      expect(saveSetupMock).toHaveBeenCalledWith({
        setupName: "Saturday social",
        draft: expect.objectContaining({
          sessionId: SESSION_ID,
          name: "Saturday social",
          rotation: recommendedRotationPreferences(),
        }),
      });
      expect(screen.queryByLabelText("Setup name")).not.toBeInTheDocument();
    });

    it("won't save a setup while the form has errors, and shows a server refusal", async () => {
      saveSetupMock.mockResolvedValue({
        ok: false,
        message: "Something went wrong. Try again in a moment.",
      });
      renderEditor();
      fireEvent.change(screen.getByLabelText("End time"), {
        target: { value: "17:00" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save this setup" }));
      fireEvent.click(screen.getByRole("button", { name: "Save setup" }));
      expect(
        await screen.findByText(
          "Fix the highlighted fields first, then save the setup.",
        ),
      ).toBeInTheDocument();
      expect(saveSetupMock).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText("End time"), {
        target: { value: "20:00" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save setup" }));
      expect(
        await screen.findByText("Something went wrong. Try again in a moment."),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Setup name")).toBeInTheDocument();
    });
  });
});
