import { startSimpleSession } from "@/server/setup/startSimpleSession";
import {
  act,
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
  readSessionDraft,
  saveSimpleSessionDraft,
  setDraftParticipantDetails,
  type SaveSessionDraftResult,
} from "@/server/setup/setupActions";
import type {
  ClubCourt,
  DraftParticipant,
  SessionDraft,
} from "@/server/setup/setupDraft";
import { recommendedRotationPreferences } from "@/server/setup/setupRules";
import { polyfillDialogForTests } from "./dialogTestPolyfill";
import { forgetOwnDraftWrites } from "./ownDraftWrites";
import { SessionSetupEditor } from "./SessionSetupEditor";

// The check-in tray polls on its own (PendingCheckinTray.test.tsx): none here.
vi.mock("@/server/checkin/hostCheckinActions", () => ({
  listPendingCheckins: vi.fn(async () => ({ ok: true, requests: [] })),
  approveCheckin: vi.fn(),
  rejectCheckin: vi.fn(),
  closeCheckinAlreadyCheckedIn: vi.fn(),
}));

vi.mock("@/server/setup/setupActions", () => ({
  saveSimpleSessionDraft: vi.fn(),
  setDraftParticipantDetails: vi.fn(),
  discardSessionDraft: vi.fn(),
  addClubCourt: vi.fn(),
  startSessionDraft: vi.fn(),
  addDraftParticipant: vi.fn(),
  removeDraftParticipant: vi.fn(),
  saveSetup: vi.fn(),
  applySavedSetup: vi.fn(),
  readSessionDraft: vi.fn(),
}));

polyfillDialogForTests();

const saveSimpleSessionDraftMock = vi.mocked(saveSimpleSessionDraft);
const readSessionDraftMock = vi.mocked(readSessionDraft);

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

/** An attendee list of `count` players. */
function participantsFor(count: number): DraftParticipant[] {
  return Array.from({ length: count }, (_, index) => ({
    participantId: `e0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    firstName: "Player",
    lastName: String(index),
    skillLevel: "intermediate",
    gender: "male" as const,
  }));
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
      courts: [
        { courtId: clubCourts[0].id, name: "Court 1", format: "doubles" },
      ],
      matchFormat: "doubles",
      targetMatchMinutes: 15,
      changeoverMinutes: 2,
      rotation: recommendedRotationPreferences(),
      appliedSavedSetupId: null,
    },
    participants: participantsFor(4),
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

function renderEditor(draft = draftWith()) {
  return render(
    <SessionSetupEditor draft={draft} socialName="Riverside Picklers" />,
  );
}

const SAVE_WAIT = { timeout: 3000 };

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/server/setup/startSimpleSession", () => ({
  startSimpleSession: vi.fn(),
}));
const CONFLICT = {
  ok: false,
  message:
    "Setup was changed by another host, tab or device. Reload to see the latest — your unsaved changes here will be lost.",
  isConflict: true,
} as const;
function deferredSave() {
  let resolveSave!: (result: SaveSessionDraftResult) => void;
  saveSimpleSessionDraftMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
  );
  return (result: SaveSessionDraftResult) => resolveSave(result);
}
function editThenLeave(sessionName: string) {
  const editor = renderEditor(draftWith({ draftRevision: 3 }));
  fireEvent.change(screen.getByLabelText("Session name"), {
    target: { value: sessionName },
  });
  editor.unmount();
  editor.container.remove();
  expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1);
}
beforeEach(() => {
  vi.clearAllMocks();
  saveSimpleSessionDraftMock.mockReset();
  saveSimpleSessionDraftMock.mockResolvedValue({ ok: true, draftRevision: 1 });
  vi.mocked(setDraftParticipantDetails).mockReset();
  readSessionDraftMock.mockReset();
  forgetOwnDraftWrites();
});
afterEach(cleanup);
describe("short Setup and preserved draft safety", () => {
  it("blocks overlapping setup changes while completing participant details", async () => {
    const participant = { ...participantsFor(1)[0], gender: null };
    let finish!: (result: SaveSessionDraftResult) => void;
    vi.mocked(setDraftParticipantDetails).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderEditor(draftWith({ participants: [participant], draftRevision: 4 }));
    fireEvent.change(
      screen.getByRole("combobox", {
        name: `Gender for ${participant.firstName} ${participant.lastName}`,
      }),
      { target: { value: "female" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() =>
      expect(vi.mocked(setDraftParticipantDetails)).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByLabelText("Session name")).toBeDisabled();
    await act(async () => finish({ ok: true, draftRevision: 5 }));
    await waitFor(() =>
      expect(screen.getByLabelText("Session name")).toBeEnabled(),
    );
  });

  it("completes legacy details with the current revision and autosaves the next edit without a false conflict", async () => {
    const participant = {
      ...participantsFor(1)[0],
      gender: null,
      skillLevel: null,
    };
    vi.mocked(setDraftParticipantDetails).mockResolvedValue({
      ok: true,
      draftRevision: 5,
    });
    renderEditor(draftWith({ draftRevision: 4, participants: [participant] }));
    const name = `${participant.firstName} ${participant.lastName}`;
    fireEvent.change(
      screen.getByRole("combobox", { name: `Gender for ${name}` }),
      { target: { value: "female" } },
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: `Level for ${name}` }),
      { target: { value: "beginner" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() =>
      expect(vi.mocked(setDraftParticipantDetails)).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        participantId: participant.participantId,
        gender: "female",
        skillLevel: "beginner",
        expectedDraftRevision: 4,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Saving…" }),
      ).not.toBeInTheDocument(),
    );
    saveSimpleSessionDraftMock.mockResolvedValue({
      ok: true,
      draftRevision: 6,
    });
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Courts" },
    });
    await waitFor(
      () =>
        expect(saveSimpleSessionDraftMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ name: "Courts" }),
          5,
        ),
      SAVE_WAIT,
    );
    expect(
      screen.queryByRole("region", { name: "Setup changed elsewhere" }),
    ).not.toBeInTheDocument();
  });

  it("starts as saved without saving again", async () => {
    renderEditor();
    expect(saveStatus()).toHaveTextContent("Saved");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveSimpleSessionDraftMock).not.toHaveBeenCalled();
  });

  it("saves edits made during a save right after it, newest wins", async () => {
    let resolveFirstSave!: (result: { ok: false; message: string }) => void;
    saveSimpleSessionDraftMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstSave = resolve;
        }),
    );
    let resolveSecondSave!: (result: {
      ok: true;
      draftRevision: number;
    }) => void;
    saveSimpleSessionDraftMock.mockImplementationOnce(
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
      () => expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1),
      SAVE_WAIT,
    );
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Second edit" },
    });
    // The second edit settles while the first save is still open: it queues.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1);

    // The first (stale) result neither marks it saved nor failed.
    resolveFirstSave({ ok: false, message: "Stale failure" });
    await waitFor(() =>
      expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(2),
    );
    expect(saveSimpleSessionDraftMock.mock.calls[1][0]).toMatchObject({
      name: "Second edit",
    });
    expect(saveStatus()).toHaveTextContent("Saving…");
    expect(screen.queryByText(/Stale failure/)).not.toBeInTheDocument();

    resolveSecondSave({ ok: true, draftRevision: 2 });
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
    expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(2);
  });

  it("still saves an edit made just before leaving the page", () => {
    saveSimpleSessionDraftMock.mockResolvedValue({
      ok: true,
      draftRevision: 1,
    });
    const { unmount } = renderEditor();
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Last-second edit" },
    });
    unmount();
    expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1);
    expect(saveSimpleSessionDraftMock.mock.calls[0][0]).toMatchObject({
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
    expect(saveSimpleSessionDraftMock).not.toHaveBeenCalled();
  });

  it("asks before closing the tab only while there are unsaved edits", async () => {
    saveSimpleSessionDraftMock.mockResolvedValue({
      ok: true,
      draftRevision: 1,
    });
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
    saveSimpleSessionDraftMock.mockResolvedValueOnce({
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

    saveSimpleSessionDraftMock.mockResolvedValueOnce({
      ok: true,
      draftRevision: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(
      () => expect(saveStatus()).toHaveTextContent("Saved"),
      SAVE_WAIT,
    );
    expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(2);
    expect(saveSimpleSessionDraftMock.mock.calls[1][0]).toMatchObject({
      name: "Sunday social",
    });
  });

  it("builds each save on the revision the last one returned", async () => {
    saveSimpleSessionDraftMock
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
      () => expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(2),
      SAVE_WAIT,
    );
    expect(
      saveSimpleSessionDraftMock.mock.calls.map((call) => call[1]),
    ).toEqual([7, 8]);
  });

  it("stops autosaving, keeps the edits and offers a reload", async () => {
    saveSimpleSessionDraftMock.mockResolvedValue(CONFLICT);
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
      "Setup was changed by another host, tab or device. Reload to see the latest \u2014 your unsaved changes here will be lost.",
    );
    expect(
      within(banner).getByRole("button", { name: "Reload" }),
    ).toBeInTheDocument();
    expect(saveStatus()).toHaveTextContent("! Not saved: changed elsewhere");
    expect(screen.getByLabelText("Session name")).toHaveValue("Stale tab edit");

    // No more writes: not on further edits, not on leaving the page.
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Another edit" },
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
    unmount();
    expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1);
  });

  it("saves on being hidden (cached route) and keeps the new revision on return", async () => {
    saveSimpleSessionDraftMock
      .mockResolvedValueOnce({ ok: true, draftRevision: 1 })
      .mockResolvedValueOnce({ ok: true, draftRevision: 2 });
    const editor = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <SessionSetupEditor
          draft={draftWith()}
          socialName="Riverside Picklers"
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
      expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1),
    );
    expect(saveSimpleSessionDraftMock.mock.calls[0]).toEqual([
      expect.objectContaining({ name: "Before hiding" }),
      0,
    ]);

    rerender(editor("visible"));
    await new Promise((resolve) => setTimeout(resolve, 900));
    // Nothing re-saved on return: the hidden flush counted as saved.
    expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "After return" },
    });
    await waitFor(
      () => expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(2),
      SAVE_WAIT,
    );
    expect(saveSimpleSessionDraftMock.mock.calls[1][1]).toBe(1);
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
    expect(
      screen.queryByRole("region", { name: "Setup changed elsewhere" }),
    ).not.toBeInTheDocument();
  });

  it("waits for it, re-reads the draft, then saves on the new revision", async () => {
    const resolveFlush = deferredSave();
    editThenLeave("Flushed on leaving");
    readSessionDraftMock.mockResolvedValue({
      ok: true,
      draft: draftWith({ name: "Flushed on leaving", draftRevision: 4 }),
    });

    // Editor B was rendered from page data read before the flush landed.
    renderEditor(draftWith({ draftRevision: 3 }));
    expect(saveStatus()).toHaveTextContent("Saving…");
    expect(screen.getByLabelText("Session name")).toBeDisabled();
    expect(screen.getByLabelText("Session name")).toHaveValue(
      "Saturday social",
    );
    expect(readSessionDraftMock).not.toHaveBeenCalled();

    resolveFlush({ ok: true, draftRevision: 4 });
    await waitFor(() =>
      expect(screen.getByLabelText("Session name")).toBeEnabled(),
    );
    expect(readSessionDraftMock).toHaveBeenCalledWith(SESSION_ID);
    expect(screen.getByLabelText("Session name")).toHaveValue(
      "Flushed on leaving",
    );
    expect(saveStatus()).toHaveTextContent("Saved");

    saveSimpleSessionDraftMock.mockResolvedValue({
      ok: true,
      draftRevision: 5,
    });
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "After coming back" },
    });
    await waitFor(
      () => expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(2),
      SAVE_WAIT,
    );
    expect(saveSimpleSessionDraftMock.mock.calls[1]).toEqual([
      expect.objectContaining({
        name: "After coming back",
      }),
      4,
    ]);
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
    expect(
      screen.queryByRole("region", { name: "Setup changed elsewhere" }),
    ).not.toBeInTheDocument();
  });

  it("waits in the same commit as the unmount (a remount)", async () => {
    const resolveFlush = deferredSave();
    readSessionDraftMock.mockResolvedValue({
      ok: true,
      draft: draftWith({ name: "Remounted edit", draftRevision: 1 }),
    });
    const editor = (instance: string) => (
      <SessionSetupEditor
        key={instance}
        draft={draftWith()}
        socialName="Riverside Picklers"
      />
    );
    const { rerender } = render(editor("A"));
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Remounted edit" },
    });
    // A unmounts and B mounts in one commit: B renders before A's
    // cleanup starts the flush.
    rerender(editor("B"));
    expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByLabelText("Session name")).toBeDisabled(),
    );
    expect(saveStatus()).toHaveTextContent("Saving…");

    resolveFlush({ ok: true, draftRevision: 1 });
    await waitFor(() =>
      expect(screen.getByLabelText("Session name")).toHaveValue(
        "Remounted edit",
      ),
    );
    expect(screen.getByLabelText("Session name")).toBeEnabled();
    expect(saveStatus()).toHaveTextContent("Saved");
  });

  it("re-reads when the flush already landed but the page data predates it", async () => {
    saveSimpleSessionDraftMock.mockResolvedValueOnce({
      ok: true,
      draftRevision: 4,
    });
    editThenLeave("Landed first");
    // The flush's response arrives before editor B's page data.
    await new Promise((resolve) => setTimeout(resolve, 0));
    readSessionDraftMock.mockResolvedValue({
      ok: true,
      draft: draftWith({ name: "Landed first", draftRevision: 4 }),
    });
    renderEditor(draftWith({ draftRevision: 3 }));
    await waitFor(() =>
      expect(screen.getByLabelText("Session name")).toHaveValue("Landed first"),
    );
    expect(screen.getByLabelText("Session name")).toBeEnabled();
    expect(readSessionDraftMock).toHaveBeenCalledTimes(1);
  });

  it("uses the page data as is when it already includes this tab's writes", async () => {
    saveSimpleSessionDraftMock.mockResolvedValueOnce({
      ok: true,
      draftRevision: 4,
    });
    editThenLeave("Already loaded");
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderEditor(draftWith({ name: "Already loaded", draftRevision: 4 }));
    expect(saveStatus()).toHaveTextContent("Saved");
    expect(screen.getByLabelText("Session name")).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readSessionDraftMock).not.toHaveBeenCalled();
  });

  it("shows the conflict banner when the flush was refused", async () => {
    const resolveFlush = deferredSave();
    editThenLeave("Refused on leaving");
    renderEditor(draftWith({ draftRevision: 3 }));
    expect(saveStatus()).toHaveTextContent("Saving…");

    resolveFlush(CONFLICT);
    expect(
      await screen.findByRole("region", {
        name: "Setup changed elsewhere",
      }),
    ).toBeInTheDocument();
    expect(saveStatus()).toHaveTextContent("! Not saved: changed elsewhere");
    expect(readSessionDraftMock).not.toHaveBeenCalled();
    // Like any conflict: nothing more is written from here.
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Edit after conflict" },
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1);
  });

  it("shows a conflict once: coming back later re-reads fresh data with no banner", async () => {
    const resolveFlush = deferredSave();
    editThenLeave("Refused on leaving");
    const editorB = renderEditor(draftWith({ draftRevision: 3 }));
    resolveFlush(CONFLICT);
    await screen.findByRole("region", { name: "Setup changed elsewhere" });
    editorB.unmount();
    editorB.container.remove();

    // Back again (client navigation): the other device's draft, fresh.
    readSessionDraftMock.mockResolvedValue({
      ok: true,
      draft: draftWith({ name: "From the other device", draftRevision: 9 }),
    });
    const editorC = renderEditor(
      draftWith({ name: "From the other device", draftRevision: 9 }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Session name")).toBeEnabled(),
    );
    expect(readSessionDraftMock).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("region", { name: "Setup changed elsewhere" }),
    ).not.toBeInTheDocument();
    expect(saveStatus()).toHaveTextContent("Saved");
    saveSimpleSessionDraftMock.mockResolvedValue({
      ok: true,
      draftRevision: 10,
    });
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Editing again" },
    });
    await waitFor(
      () => expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(2),
      SAVE_WAIT,
    );
    expect(saveSimpleSessionDraftMock.mock.calls[1][1]).toBe(9);
    await waitFor(() => expect(saveStatus()).toHaveTextContent("Saved"));
    editorC.unmount();
    editorC.container.remove();

    // The conflict is over: the next visit with current data just loads.
    renderEditor(
      draftWith({
        name: "From the other device",
        location: "Editing again",
        draftRevision: 10,
      }),
    );
    expect(saveStatus()).toHaveTextContent("Saved");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readSessionDraftMock).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("region", { name: "Setup changed elsewhere" }),
    ).not.toBeInTheDocument();
  });

  it("stops waiting after 15 s and asks for a reload", async () => {
    deferredSave(); // Never answers.
    editThenLeave("Never answered");
    vi.useFakeTimers();
    try {
      renderEditor(draftWith({ draftRevision: 3 }));
      expect(saveStatus()).toHaveTextContent("Saving…");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_900);
      });
      expect(saveStatus()).toHaveTextContent("Saving…");
      expect(screen.getByLabelText("Session name")).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(saveStatus()).toHaveTextContent("! Not saved: reload the page");
      expect(screen.getByLabelText("Session name")).toBeEnabled();
      expect(readSessionDraftMock).not.toHaveBeenCalled();
      // Nothing is written from the stale screen.
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Edit on a stale screen" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a reload when the draft can't be re-read", async () => {
    const resolveFlush = deferredSave();
    editThenLeave("Unreadable after");
    readSessionDraftMock.mockRejectedValue(new Error("offline"));
    renderEditor(draftWith({ draftRevision: 3 }));

    resolveFlush({ ok: true, draftRevision: 4 });
    await waitFor(() =>
      expect(saveStatus()).toHaveTextContent("! Not saved: reload the page"),
    );
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Edit on a stale screen" },
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(saveSimpleSessionDraftMock).toHaveBeenCalledTimes(1);
  });
});

it("saves only the short Setup fields and removes retired controls", async () => {
  renderEditor();
  expect(
    screen.queryByLabelText("Location (optional)"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Saved setups" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("switch", { name: "Rotate opponents" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Court count"), {
    target: { value: "3" },
  });
  fireEvent.change(screen.getByLabelText("Session duration (minutes)"), {
    target: { value: "90" },
  });
  await waitFor(
    () =>
      expect(saveSimpleSessionDraftMock).toHaveBeenCalledWith(
        {
          sessionId: SESSION_ID,
          name: "Saturday social",
          courtCount: 3,
          durationMinutes: 90,
        },
        0,
      ),
    SAVE_WAIT,
  );
});

it("starts only after confirmation and navigates to the live destination", async () => {
  vi.mocked(startSimpleSession).mockResolvedValue({
    ok: true,
    seq: 1,
    occurredAt: 1,
    wasDuplicate: false,
  });
  renderEditor(draftWith({ draftRevision: 7 }));
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  expect(startSimpleSession).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Start Saturday social?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(startSimpleSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  push.mockImplementationOnce(() => {
    expect(dialog).not.toHaveAttribute("open");
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Confirm start" }),
  );
  await waitFor(() => expect(push).toHaveBeenCalledWith("/live"));
  expect(startSimpleSession).toHaveBeenCalledWith({
    sessionId: SESSION_ID,
    eventId: expect.any(String),
    expectedDraftRevision: 7,
  });
});

it("keeps settings locked and reuses the action UUID after an uncertain start", async () => {
  vi.mocked(startSimpleSession).mockReset();
  vi.mocked(startSimpleSession)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({
      ok: true,
      seq: 1,
      occurredAt: 1,
      wasDuplicate: true,
    });
  renderEditor();
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm start" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Session name")).toBeDisabled();
  expect(push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry start" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/live"));
  expect(vi.mocked(startSimpleSession).mock.calls[1][0].eventId).toBe(
    vi.mocked(startSimpleSession).mock.calls[0][0].eventId,
  );
});

it("blocks Start for unfinished players, missing details, invalid count or too few players", () => {
  const editor = renderEditor(draftWith({ participants: participantsFor(3) }));
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  editor.unmount();
  const second = renderEditor(
    draftWith({
      participants: [
        { ...participantsFor(4)[0], gender: null },
        ...participantsFor(4).slice(1),
      ],
    }),
  );
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  second.unmount();
  renderEditor();
  fireEvent.change(screen.getByLabelText("Court count"), {
    target: { value: "0" },
  });
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
});
