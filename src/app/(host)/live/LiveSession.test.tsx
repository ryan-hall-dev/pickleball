// Regression coverage for B1: a definitive rejection on /live must release the
// controls, a conflict must refresh and release them, and only an uncertain
// outcome (timeout, lost response, server error) keeps the same-event-id retry.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity } from "react";
import { approveCheckin } from "@/server/checkin/hostCheckinActions";
import { readLiveSession, writeLiveAction } from "@/server/live/liveActions";
import { addLivePlayer } from "@/server/live/liveAddPlayer";
import type {
  LiveSessionView,
  LiveWriteInput,
  LiveWriteResult,
  ReadLiveResult,
} from "@/server/live/liveTypes";
import { LiveSession } from "./LiveSession";

vi.mock("@/server/live/liveActions", () => ({
  readLiveSession: vi.fn(),
  writeLiveAction: vi.fn(),
}));
vi.mock("@/server/live/liveAddPlayer", () => ({ addLivePlayer: vi.fn() }));
vi.mock("@/server/checkin/hostCheckinActions", () => ({
  approveCheckin: vi.fn(),
}));
// The tray polls its own server action; these scenarios only need the
// approve function Live hands it.
const tray = vi.hoisted(() => ({
  approveDecision: undefined as
    | ((requestId: string, gender?: "male" | "female") => Promise<unknown>)
    | undefined,
}));
vi.mock("../setup/PendingCheckinTray", () => ({
  PendingCheckinTray: (props: {
    approveDecision: NonNullable<typeof tray.approveDecision>;
  }) => {
    tray.approveDecision = props.approveDecision;
    return <section aria-label="Check-ins waiting" />;
  },
}));

const readMock = vi.mocked(readLiveSession);
const approveMock = vi.mocked(approveCheckin);
const writeMock = vi.mocked(writeLiveAction);
const addMock = vi.mocked(addLivePlayer);

const NOW = Date.parse("2026-11-15T18:00:00.000Z");
const SESSION_ID = "d0000000-0000-4000-8000-000000000001";
const ANA = "p0000000-0000-4000-8000-000000000001";

function sessionView(lastSeq: number): LiveSessionView {
  return {
    sessionId: SESSION_ID,
    name: "Saturday social",
    phase: "live",
    lastSeq,
    now: NOW,
    startedAt: NOW - 600_000,
    endedAt: null,
    deadline: NOW + 3_600_000,
    timeIsUp: false,
    undoOptions: [],
    courts: [
      {
        courtId: "c0000000-0000-4000-8000-000000000001",
        name: "Court 1",
        activeMatch: null,
        called: null,
        suggestion: null,
      },
    ],
    players: [
      {
        participantId: ANA,
        name: "Ana Brown",
        skill: "intermediate",
        gender: "female",
        status: "waiting",
        currentWaitMs: 300_000,
        returnsAt: null,
        skipSeq: null,
        calledCourtId: null,
        calledCourtName: null,
      },
      {
        participantId: "p0000000-0000-4000-8000-000000000002",
        name: "Ben Chen",
        skill: "beginner",
        gender: "male",
        status: "waiting",
        currentWaitMs: 120_000,
        returnsAt: null,
        skipSeq: null,
        calledCourtId: null,
        calledCourtName: null,
      },
    ],
  };
}

function readResult(lastSeq: number): ReadLiveResult {
  return { ok: true, status: "session", session: sessionView(lastSeq) };
}

const REJECTED: LiveWriteResult = {
  ok: false,
  message: "Session time is up; finish the active games.",
  outcome: "rejected",
};
const CONFLICT: LiveWriteResult = {
  ok: false,
  message: "Updated by another host. Review the refreshed session.",
  outcome: "conflict",
};
const UNKNOWN: LiveWriteResult = {
  ok: false,
  message:
    "Couldn't save that action. Retry it after checking your connection.",
  outcome: "unknown",
};
const SAVED: LiveWriteResult = { ok: true, seq: 8, wasDuplicate: false };

/** Lets the mocked server calls and React's updates settle under fake timers. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
}

const restAna = () => screen.getByRole("button", { name: "Rest Ana Brown" });
const retryButton = () =>
  screen.queryByRole("button", { name: "Retry last action" });

async function renderLive() {
  render(<LiveSession initialResult={readResult(7)} />);
  await settle();
  expect(restAna()).toBeEnabled();
}

function writeInputs(): LiveWriteInput[] {
  return writeMock.mock.calls.map(([input]) => input);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  readMock.mockReset();
  writeMock.mockReset();
  approveMock.mockReset();
  addMock.mockReset();
  readMock.mockResolvedValue(readResult(7));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LiveSession write outcomes", () => {
  it("shows a definitive rejection and releases the controls for a new action", async () => {
    writeMock.mockResolvedValueOnce(REJECTED).mockResolvedValueOnce(SAVED);
    await renderLive();

    fireEvent.click(restAna());
    await settle();

    expect(screen.getByText(REJECTED.message)).toBeInTheDocument();
    expect(retryButton()).toBeNull();
    expect(restAna()).toBeEnabled();

    fireEvent.click(restAna());
    await settle();

    const [first, second] = writeInputs();
    expect(first.command).toEqual({ kind: "rest", participantId: ANA });
    expect(second.command).toEqual(first.command);
    // A fresh action, not a retry of the refused one.
    expect(second.eventId).not.toBe(first.eventId);
    expect(screen.queryByText(REJECTED.message)).toBeNull();
  });

  it("refreshes after a conflict and lets the host act on the new state", async () => {
    writeMock.mockResolvedValueOnce(CONFLICT).mockResolvedValueOnce(SAVED);
    await renderLive();
    const readsBefore = readMock.mock.calls.length;
    readMock.mockResolvedValue(readResult(9));

    fireEvent.click(restAna());
    await settle();

    expect(screen.getByText(CONFLICT.message)).toBeInTheDocument();
    expect(readMock.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(retryButton()).toBeNull();
    expect(restAna()).toBeEnabled();

    fireEvent.click(restAna());
    await settle();

    const [first, second] = writeInputs();
    expect(first.expectedLastSeq).toBe(7);
    expect(second.expectedLastSeq).toBe(9);
    expect(second.eventId).not.toBe(first.eventId);
  });

  it("keeps a same-event retry, and only that, after an uncertain outcome", async () => {
    writeMock.mockResolvedValueOnce(UNKNOWN).mockResolvedValueOnce(SAVED);
    await renderLive();

    fireEvent.click(restAna());
    await settle();

    expect(screen.getByText(UNKNOWN.message)).toBeInTheDocument();
    expect(retryButton()).toBeEnabled();
    expect(restAna()).toBeDisabled();

    fireEvent.click(retryButton()!);
    await settle();

    const [first, second] = writeInputs();
    expect(second).toEqual(first);
    expect(retryButton()).toBeNull();
    expect(restAna()).toBeEnabled();
  });

  it("treats a timed-out write as uncertain and retries it with the same event id", async () => {
    writeMock
      .mockReturnValueOnce(new Promise<LiveWriteResult>(() => {}))
      .mockResolvedValueOnce({ ok: true, seq: 8, wasDuplicate: true });
    await renderLive();

    fireEvent.click(restAna());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await settle();

    expect(
      screen.getByText(
        "Couldn't confirm that action. Retry to check whether it was saved.",
      ),
    ).toBeInTheDocument();
    expect(retryButton()).toBeEnabled();
    expect(restAna()).toBeDisabled();

    fireEvent.click(retryButton()!);
    await settle();

    const [first, second] = writeInputs();
    expect(second).toEqual(first);
    expect(retryButton()).toBeNull();
    expect(restAna()).toBeEnabled();
  });
});

describe("LiveSession check-in approval outcomes", () => {
  const REQUEST_ID = "a0000000-0000-4000-8000-000000000001";

  async function approveFromTray() {
    let decision: unknown;
    await act(async () => {
      const pending = tray.approveDecision!(REQUEST_ID, "female");
      await vi.advanceTimersByTimeAsync(20);
      decision = await pending;
    });
    return decision;
  }
  const approveMetadata = () =>
    approveMock.mock.calls.map(([, , live]) => live);

  it("reports a stale-sequence conflict as a conflict, refreshes, and retries on the new sequence", async () => {
    approveMock
      .mockResolvedValueOnce({ kind: "session_changed" })
      .mockResolvedValueOnce({ kind: "approved", participant: null });
    await renderLive();
    const readsBefore = readMock.mock.calls.length;
    readMock.mockResolvedValue(readResult(9));

    // Not turned into a success (or anything else) on the way to the tray.
    expect(await approveFromTray()).toEqual({ kind: "session_changed" });
    expect(readMock.mock.calls.length).toBeGreaterThan(readsBefore);

    expect(await approveFromTray()).toEqual({
      kind: "approved",
      participant: null,
    });
    const [first, second] = approveMetadata();
    expect(first?.expectedLastSeq).toBe(7);
    expect(second?.expectedLastSeq).toBe(9);
    // The refused event was never written, so the same id is safe to reuse.
    expect(second?.eventId).toBe(first?.eventId);
  });

  it("keeps the same event id when the outcome is uncertain, and never reports success for it", async () => {
    approveMock
      .mockResolvedValueOnce({ kind: "failed" })
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce({ kind: "approved", participant: null });
    await renderLive();

    expect(await approveFromTray()).toEqual({ kind: "failed" });
    // A lost response is uncertain too: failed, not approved, and no throw.
    expect(await approveFromTray()).toEqual({ kind: "failed" });
    expect(await approveFromTray()).toMatchObject({ kind: "approved" });

    const [first, second, third] = approveMetadata();
    expect(first?.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.eventId).toBe(first?.eventId);
    expect(third?.eventId).toBe(first?.eventId);
  });
});

describe("LiveSession polling lifecycle", () => {
  it("resumes polling after Activity hides an in-flight read", async () => {
    const view = render(
      <Activity mode="visible">
        <LiveSession initialResult={readResult(7)} />
      </Activity>,
    );
    await settle();
    let resolveRead!: (value: ReadLiveResult) => void;
    readMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    view.rerender(
      <Activity mode="hidden">
        <LiveSession initialResult={readResult(7)} />
      </Activity>,
    );
    await act(async () => {
      resolveRead(readResult(8));
    });
    view.rerender(
      <Activity mode="visible">
        <LiveSession initialResult={readResult(7)} />
      </Activity>,
    );
    await settle();
    const readsAfterReturn = readMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(readMock).toHaveBeenCalledTimes(readsAfterReturn + 1);
  });

  it("does not queue another poll after a timeout while its server call is still pending", async () => {
    await renderLive();
    const readsBeforePoll = readMock.mock.calls.length;
    let resolveRead!: (value: ReadLiveResult) => void;
    readMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(readMock).toHaveBeenCalledTimes(readsBeforePoll + 1);
    await act(async () => {
      resolveRead(readResult(7));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(readMock).toHaveBeenCalledTimes(readsBeforePoll + 2);
  });
});

describe("LiveSession glanceable controls", () => {
  it("explains why the session cannot end while a game is active", async () => {
    const session = sessionView(7);
    session.courts[0].activeMatch = {
      matchId: "a0000000-0000-4000-8000-000000000001",
      startedAt: NOW,
      teamA: [session.players[0].participantId],
      teamB: [session.players[1].participantId],
    };
    const response = { ok: true, status: "session", session } as const;
    readMock.mockResolvedValue(response);
    render(<LiveSession initialResult={response} />);
    await settle();
    const end = screen.getByRole("button", { name: "End session" });
    expect(end).toBeDisabled();
    expect(end).toHaveAccessibleDescription(
      "Finish the active games before ending the session.",
    );
  });

  it("reads once when selecting a court and reads again when refreshing that same court", async () => {
    await renderLive();
    const readsBefore = readMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Prepare next four" }));
    await settle();
    expect(readMock).toHaveBeenCalledTimes(readsBefore + 1);
    expect(readMock).toHaveBeenLastCalledWith({
      sessionId: SESSION_ID,
      prepareCourtId: sessionView(7).courts[0].courtId,
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh next four" }));
    await settle();
    expect(readMock).toHaveBeenCalledTimes(readsBefore + 2);
    expect(readMock).toHaveBeenLastCalledWith({
      sessionId: SESSION_ID,
      prepareCourtId: sessionView(7).courts[0].courtId,
    });
  });
});

describe("LiveSession layout", () => {
  it("shows check-ins first, then waiting players, then courts", async () => {
    await renderLive();
    const checkIns = screen.getByRole("region", { name: "Check-ins waiting" });
    const waiting = screen.getByRole("region", { name: /^Waiting/ });
    const courts = screen.getByRole("heading", { name: "Courts & Up next" });
    const follows = (earlier: Element, later: Element) =>
      Boolean(
        earlier.compareDocumentPosition(later) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    expect(follows(checkIns, waiting)).toBe(true);
    expect(follows(waiting, courts)).toBe(true);
    // The jump links follow the same order.
    expect(
      screen
        .getAllByRole("link")
        .map((link) => link.textContent)
        .filter((text) => ["Check-ins", "Waiting", "Courts"].includes(text!)),
    ).toEqual(["Check-ins", "Waiting", "Courts"]);
  });
});

function withDeadline(deadline: number, lastSeq = 7): LiveSessionView {
  const view = sessionView(lastSeq);
  const wall = Date.now();
  return {
    ...view,
    now: wall,
    deadline,
    timeIsUp: wall >= deadline,
  };
}

describe("LiveSession scheduled end", () => {
  it("shows a prominent notice with an enabled End session when time is up and no game is on court", async () => {
    const response = {
      ok: true,
      status: "session",
      session: { ...sessionView(7), timeIsUp: true, deadline: NOW - 1 },
    } as const;
    readMock.mockResolvedValue(response);
    render(<LiveSession initialResult={response} />);
    await settle();
    const notice = screen.getByRole("region", { name: /Session time is up/ });
    expect(notice).toHaveTextContent("No new groups can be called");
    expect(notice).toHaveTextContent("Waiting times keep counting");
    const end = within(notice).getByRole("button", { name: "End session" });
    expect(end).toBeEnabled();
  });

  it("names the active courts, ends nothing for the host and keeps End locked until they finish", async () => {
    const session = { ...sessionView(7), timeIsUp: true, deadline: NOW - 1 };
    session.courts[0].activeMatch = {
      matchId: "a0000000-0000-4000-8000-000000000001",
      startedAt: NOW,
      teamA: [session.players[0].participantId],
      teamB: [session.players[1].participantId],
    };
    const response = { ok: true, status: "session", session } as const;
    readMock.mockResolvedValue(response);
    render(<LiveSession initialResult={response} />);
    await settle();
    const notice = screen.getByRole("region", { name: /Session time is up/ });
    expect(notice).toHaveTextContent("Still on court: Court 1");
    expect(notice).toHaveTextContent("Nothing is ended for you");
    expect(
      within(notice).getByRole("button", { name: "End session" }),
    ).toBeDisabled();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("crosses the deadline while the tab is open and stops offering new calls", async () => {
    readMock.mockImplementation(async () => ({
      ok: true,
      status: "session",
      session: withDeadline(NOW + 60_000),
    }));
    render(
      <LiveSession
        initialResult={{
          ok: true,
          status: "session",
          session: withDeadline(NOW + 60_000),
        }}
      />,
    );
    await settle();
    expect(
      screen.queryByRole("region", { name: /Session time is up/ }),
    ).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(
      screen.getByRole("region", { name: /Session time is up/ }),
    ).toBeVisible();
    expect(
      screen.getByText("Time is up: no new groups or games."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Call these four" }),
    ).toBeNull();
  });

  it("is correct the moment an old, throttled tab becomes visible, before any server answer", async () => {
    const initial = {
      ok: true,
      status: "session",
      session: withDeadline(NOW + 600_000),
    } as const;
    readMock.mockResolvedValue(initial);
    render(<LiveSession initialResult={initial} />);
    await settle();
    expect(
      screen.queryByRole("region", { name: /Session time is up/ }),
    ).toBeNull();
    let hidden = true;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    try {
      // Background tabs freeze timers: the wall clock moves, no tick runs.
      readMock.mockReturnValue(new Promise(() => {}));
      vi.setSystemTime(NOW + 700_000);
      hidden = false;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(
        screen.getByRole("region", { name: /Session time is up/ }),
      ).toBeVisible();
    } finally {
      Reflect.deleteProperty(document, "hidden");
    }
  });

  it("shows the session as ended when another host ends it", async () => {
    await renderLive();
    readMock.mockResolvedValue({
      ok: true,
      status: "session",
      session: { ...sessionView(8), phase: "ended", endedAt: NOW },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(screen.getByText("Session ended")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Add player/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rest Ana Brown" })).toBeNull();
  });
});

describe("LiveSession add player", () => {
  async function openForm() {
    await renderLive();
    fireEvent.click(screen.getByRole("button", { name: "Add player" }));
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Walk" },
    });
    fireEvent.change(screen.getByLabelText("Last name"), {
      target: { value: "In" },
    });
    fireEvent.change(screen.getByLabelText("Gender"), {
      target: { value: "female" },
    });
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "beginner" },
    });
  }
  const submitForm = () =>
    fireEvent.click(
      screen.getByRole("button", {
        name: /Add to waiting list|Retry add player/,
      }),
    );

  it("sits beside the check-ins and refuses an incomplete form without calling the server", async () => {
    await renderLive();
    fireEvent.click(screen.getByRole("button", { name: "Add player" }));
    submitForm();
    expect(addMock).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a first name.")).toBeVisible();
    expect(screen.getByText("Choose a level.")).toBeVisible();
  });

  it("sends a double click once and closes only after a confirmed save", async () => {
    let finish: (value: LiveWriteResult) => void = () => {};
    addMock.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await openForm();
    submitForm();
    // Enter pressed again while the first save is still in flight.
    fireEvent.submit(screen.getByRole("form", { name: "Add player" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await settle();
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("form", { name: "Add player" })).toBeVisible();
    await act(async () => {
      finish(SAVED);
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen.queryByRole("form", { name: "Add player" })).toBeNull();
    expect(addMock.mock.calls[0][0]).toMatchObject({
      firstName: "Walk",
      lastName: "In",
      sessionId: SESSION_ID,
      expectedLastSeq: 7,
    });
  });

  it("keeps the form and the same event id after an uncertain answer, then retries without a second add", async () => {
    addMock.mockResolvedValueOnce(UNKNOWN).mockResolvedValueOnce(SAVED);
    await openForm();
    submitForm();
    await settle();
    expect(screen.getByText(UNKNOWN.ok ? "" : UNKNOWN.message)).toBeVisible();
    // While the answer is unresolved the details are locked: an edit could
    // otherwise turn a possibly-saved add into a second person.
    for (const label of ["First name", "Last name", "Gender", "Level"])
      expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    submitForm();
    await settle();
    expect(addMock).toHaveBeenCalledTimes(2);
    expect(addMock.mock.calls[1][0]).toEqual(addMock.mock.calls[0][0]);
    expect(screen.queryByRole("form", { name: "Add player" })).toBeNull();
  });

  it("lets two different people share a name: after a confirmed add, the next add gets its own event id", async () => {
    addMock.mockResolvedValue(SAVED);
    await openForm();
    submitForm();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add player" }));
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Walk" },
    });
    fireEvent.change(screen.getByLabelText("Last name"), {
      target: { value: "In" },
    });
    fireEvent.change(screen.getByLabelText("Gender"), {
      target: { value: "male" },
    });
    fireEvent.change(screen.getByLabelText("Level"), {
      target: { value: "advanced" },
    });
    submitForm();
    await settle();
    expect(addMock).toHaveBeenCalledTimes(2);
    expect(addMock.mock.calls[1][0].eventId).not.toBe(
      addMock.mock.calls[0][0].eventId,
    );
    expect(addMock.mock.calls[1][0]).toMatchObject({
      firstName: "Walk",
      lastName: "In",
      gender: "male",
    });
  });

  it("refreshes after a stale sequence, adds nobody, and retries on the new sequence", async () => {
    addMock
      .mockResolvedValueOnce({
        ok: false,
        message: "The session changed before this was saved. Nobody was added.",
        outcome: "conflict",
      })
      .mockResolvedValueOnce(SAVED);
    await openForm();
    readMock.mockResolvedValue(readResult(9));
    submitForm();
    await settle();
    expect(screen.getByText(/Nobody was added/)).toBeVisible();
    expect(screen.getByRole("form", { name: "Add player" })).toBeVisible();
    submitForm();
    await settle();
    expect(addMock.mock.calls[1][0].expectedLastSeq).toBe(9);
    expect(screen.queryByRole("form", { name: "Add player" })).toBeNull();
  });
});

describe("LiveSession prepared courts", () => {
  const courtId = "c0000000-0000-4000-8000-000000000001";
  const [ana, ben] = [
    "p0000000-0000-4000-8000-000000000001",
    "p0000000-0000-4000-8000-000000000002",
  ];

  it("shows a prepared group with its teams and a Start game button, and nobody is playing yet", async () => {
    const session = sessionView(7);
    session.courts[0].called = {
      calledEventId: "e0000000-0000-4000-8000-000000000001",
      teamA: [ana, "p0000000-0000-4000-8000-000000000003"],
      teamB: [ben, "p0000000-0000-4000-8000-000000000004"],
    };
    const response = { ok: true, status: "session", session } as const;
    readMock.mockResolvedValue(response);
    writeMock.mockResolvedValue(SAVED);
    render(<LiveSession initialResult={response} />);
    await settle();
    const card = screen.getByRole("article", { name: "Court 1" });
    expect(card).toHaveTextContent("Group prepared");
    expect(card).not.toHaveTextContent("No game on this court");
    expect(within(card).getByText("Ana Brown")).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: "Start game" }));
    await settle();
    expect(writeInputs()[0].command).toMatchObject({
      kind: "start",
      courtId,
      calledEventId: "e0000000-0000-4000-8000-000000000001",
    });
    expect(
      within(card).queryByRole("button", { name: "Call these four" }),
    ).toBeNull();
  });

  it("explains a free court that is waiting for enough players", async () => {
    await renderLive();
    const card = screen.getByRole("article", { name: "Court 1" });
    expect(card).toHaveTextContent("Court free");
    expect(card).toHaveTextContent("Waiting for four available players");
  });
});
