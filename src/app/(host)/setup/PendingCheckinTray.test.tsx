import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveCheckin,
  closeCheckinAlreadyCheckedIn,
  listPendingCheckins,
  rejectCheckin,
} from "@/server/checkin/hostCheckinActions";
import type {
  HostCheckinDecisionResult,
  PendingCheckinRequest,
} from "@/server/checkin/hostCheckinResults";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import {
  PENDING_CHECKINS_POLL_INTERVAL_MS,
  PendingCheckinTray,
} from "./PendingCheckinTray";
import { DECIDED_ROW_VISIBLE_MS } from "./pendingCheckinTrayState";

vi.mock("@/server/checkin/hostCheckinActions", () => ({
  listPendingCheckins: vi.fn(),
  approveCheckin: vi.fn(),
  rejectCheckin: vi.fn(),
  closeCheckinAlreadyCheckedIn: vi.fn(),
}));

const listMock = vi.mocked(listPendingCheckins);
const approveMock = vi.mocked(approveCheckin);
const rejectMock = vi.mocked(rejectCheckin);
const closeMock = vi.mocked(closeCheckinAlreadyCheckedIn);

const NOW = Date.parse("2026-11-07T18:10:00.000Z");

const kai: PendingCheckinRequest = {
  checkinRequestId: "a0000000-0000-4000-8000-000000000001",
  createdAt: "2026-11-07T18:09:00.000Z",
  memberId: null,
  firstName: "Kai",
  lastName: "Moreno",
  requestedSkillLevel: "beginner",
  savedSkillLevel: null,
  isAlreadyAttending: false,
  isPossibleDuplicate: false,
};
const grace: PendingCheckinRequest = {
  checkinRequestId: "a0000000-0000-4000-8000-000000000002",
  createdAt: "2026-11-07T18:06:00.000Z",
  memberId: "b0000000-0000-4000-8000-000000000002",
  firstName: "Grace",
  lastName: "Kim",
  requestedSkillLevel: null,
  savedSkillLevel: "beginner",
  isAlreadyAttending: true,
  isPossibleDuplicate: false,
};
const kaiParticipant: DraftParticipant = {
  participantId: "e0000000-0000-4000-8000-000000000001",
  memberId: "b0000000-0000-4000-8000-000000000001",
  isGuest: false,
  firstName: "Kai",
  lastName: "Moreno",
  skillLevel: "beginner",
  isMemberActive: true,
};

function listing(...requests: PendingCheckinRequest[]) {
  return { ok: true as const, requests };
}

/** Lets resolved server calls and React updates land. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderTray() {
  const onParticipantApproved = vi.fn();
  const onAttendanceChangedElsewhere = vi.fn();
  const rendered = render(
    <PendingCheckinTray
      onParticipantApproved={onParticipantApproved}
      onAttendanceChangedElsewhere={onAttendanceChangedElsewhere}
    />,
  );
  return { ...rendered, onParticipantApproved, onAttendanceChangedElsewhere };
}

function setPageHidden(isHidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => isHidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  listMock.mockReset();
  approveMock.mockReset();
  rejectMock.mockReset();
  closeMock.mockReset();
});

afterEach(() => {
  cleanup();
  setPageHidden(false);
  vi.useRealTimers();
});

describe("PendingCheckinTray", () => {
  it("shows the empty state with a grey 0 badge", async () => {
    listMock.mockResolvedValue(listing());
    renderTray();
    await settle();
    expect(
      screen.getByRole("heading", { name: "Check-ins waiting (0)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "No check-ins waiting. Players scan the social's QR code or tap the sticker to check in.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Approve to add them to Who's playing. Oldest first."),
    ).not.toBeInTheDocument();
    // Increment 4 adds the Sticker and QR page and this button.
    expect(
      screen.queryByRole("link", { name: /Show QR code/ }),
    ).not.toBeInTheDocument();
  });

  it("lists rows oldest first with their chips, and no Approve for a member already attending", async () => {
    listMock.mockResolvedValue(listing(grace, kai));
    renderTray();
    await settle();
    expect(
      screen.getByRole("heading", { name: "Check-ins waiting (2)" }),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Grace Kim"),
      expect.stringContaining("Kai Moreno"),
    ]);
    expect(rows[0]).toHaveTextContent("Member");
    expect(rows[0]).toHaveTextContent("4 min ago");
    expect(rows[0]).toHaveTextContent(
      "Already checked in to this session. They can't be added twice.",
    );
    expect(rows[1]).toHaveTextContent("New player");
    expect(rows[1]).toHaveTextContent("1 min ago");
    expect(
      screen.queryByRole("button", { name: "Approve Grace Kim" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Close Grace Kim's request: already checked in",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reject Grace Kim" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approve Kai Moreno" }),
    ).toBeInTheDocument();
  });

  it("approves: busy row, then the attendee goes to the editor and the message leaves after about 4 s", async () => {
    listMock.mockResolvedValue(listing(kai));
    let answerApprove: (result: HostCheckinDecisionResult) => void = () => {};
    approveMock.mockReturnValue(
      new Promise((resolve) => {
        answerApprove = resolve;
      }),
    );
    const { onParticipantApproved } = renderTray();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Approve Kai Moreno" }));
    await settle();
    expect(approveMock).toHaveBeenCalledWith(kai.checkinRequestId);
    expect(screen.getByRole("button", { name: "Approving…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reject Kai Moreno" }),
    ).toBeDisabled();

    answerApprove({ kind: "approved", participant: kaiParticipant });
    await settle();
    expect(onParticipantApproved).toHaveBeenCalledWith(kaiParticipant);
    expect(screen.getByText("Added to Who's playing")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Check-ins waiting (0)" }),
    ).toBeInTheDocument();

    await advance(DECIDED_ROW_VISIBLE_MS - 1);
    expect(screen.getByText("Added to Who's playing")).toBeInTheDocument();
    await advance(1);
    expect(
      screen.queryByText("Added to Who's playing"),
    ).not.toBeInTheDocument();
  });

  it("shows a failed approve with Retry, and Retry approves again", async () => {
    listMock.mockResolvedValue(listing(kai));
    approveMock.mockResolvedValueOnce({ kind: "failed" });
    approveMock.mockResolvedValueOnce({ kind: "approved", participant: null });
    const { onParticipantApproved } = renderTray();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Approve Kai Moreno" }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't approve. Check your connection and retry.",
    );
    expect(
      screen.getByRole("button", { name: "Reject Kai Moreno" }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry approving Kai Moreno" }),
    );
    await settle();
    expect(approveMock).toHaveBeenCalledTimes(2);
    expect(onParticipantApproved).toHaveBeenCalledWith(null);
    expect(screen.getByText("Added to Who's playing")).toBeInTheDocument();
  });

  it("counts an approve with no answer within 15 s as failed", async () => {
    listMock.mockResolvedValue(listing(kai));
    approveMock.mockReturnValue(new Promise(() => {}));
    renderTray();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Approve Kai Moreno" }));
    await advance(15_000);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't approve.");
  });

  it("switches a refused Approve to the already-checked-in row and asks Who's playing to re-read", async () => {
    const graceNotYetAttending = { ...grace, isAlreadyAttending: false };
    listMock.mockResolvedValue(listing(graceNotYetAttending));
    approveMock.mockResolvedValue({ kind: "already_in_session" });
    const { onAttendanceChangedElsewhere } = renderTray();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Approve Grace Kim" }));
    await settle();
    expect(
      screen.getByText("Added by another host a moment ago."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve Grace Kim" }),
    ).not.toBeInTheDocument();
    expect(onAttendanceChangedElsewhere).toHaveBeenCalledTimes(1);
  });

  it("closes an already-attending request and rejects another, each with its message", async () => {
    listMock.mockResolvedValue(listing(grace, kai));
    closeMock.mockResolvedValue({ kind: "closed" });
    rejectMock.mockResolvedValue({ kind: "rejected" });
    renderTray();
    await settle();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Close Grace Kim's request: already checked in",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reject Kai Moreno" }));
    await settle();
    expect(closeMock).toHaveBeenCalledWith(grace.checkinRequestId);
    expect(rejectMock).toHaveBeenCalledWith(kai.checkinRequestId);
    expect(
      screen.getByText(
        "Request closed. Their phone shows they're already checked in.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Check-in rejected. The player sees "Please speak to the host".',
      ),
    ).toBeInTheDocument();
  });

  it("says when another host decided first", async () => {
    listMock.mockResolvedValue(listing(kai));
    rejectMock.mockResolvedValue({ kind: "already_decided" });
    renderTray();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Reject Kai Moreno" }));
    await settle();
    expect(
      screen.getByText("Already decided by another host"),
    ).toBeInTheDocument();
  });

  it("warns about a possible duplicate and keeps Approve", async () => {
    listMock.mockResolvedValue(listing({ ...kai, isPossibleDuplicate: true }));
    renderTray();
    await settle();
    expect(
      screen.getByText(
        "Possible duplicate: same name as someone already checked in.",
        { exact: false },
      ),
    ).toHaveTextContent(
      "A matching name doesn't mean it's the same person. Check with them before approving.",
    );
    expect(
      screen.getByRole("button", { name: "Approve Kai Moreno" }),
    ).toBeEnabled();
  });

  it("polls every 5 s, picks up new requests, and re-reads attendance when one leaves without a decision here", async () => {
    listMock.mockResolvedValueOnce(listing());
    listMock.mockResolvedValueOnce(listing(kai));
    listMock.mockResolvedValueOnce(listing());
    const { onAttendanceChangedElsewhere } = renderTray();
    await settle();
    expect(listMock).toHaveBeenCalledTimes(1);

    await advance(PENDING_CHECKINS_POLL_INTERVAL_MS);
    expect(screen.getByText("Kai Moreno")).toBeInTheDocument();
    expect(onAttendanceChangedElsewhere).not.toHaveBeenCalled();

    await advance(PENDING_CHECKINS_POLL_INTERVAL_MS);
    expect(screen.queryByText("Kai Moreno")).not.toBeInTheDocument();
    expect(onAttendanceChangedElsewhere).toHaveBeenCalledTimes(1);
  });

  it("sends no new poll while one is still on its way, even after it timed out", async () => {
    let answerFirstPoll: (value: ReturnType<typeof listing>) => void = () => {};
    listMock.mockReturnValueOnce(
      new Promise((resolve) => {
        answerFirstPoll = resolve;
      }),
    );
    listMock.mockResolvedValue(listing(kai));
    renderTray();
    await advance(PENDING_CHECKINS_POLL_INTERVAL_MS * 4);
    // Timed out after 15 s: shown as a failed refresh, but still in flight.
    expect(screen.getByText(/Couldn't refresh check-ins/)).toBeInTheDocument();
    setPageHidden(false);
    await settle();
    expect(listMock).toHaveBeenCalledTimes(1);

    answerFirstPoll(listing());
    await settle();
    await advance(PENDING_CHECKINS_POLL_INTERVAL_MS);
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Kai Moreno")).toBeInTheDocument();
  });

  it("pauses while the page is hidden and reads again when shown", async () => {
    listMock.mockResolvedValue(listing());
    renderTray();
    await settle();
    setPageHidden(true);
    await advance(PENDING_CHECKINS_POLL_INTERVAL_MS * 3);
    expect(listMock).toHaveBeenCalledTimes(1);
    setPageHidden(false);
    await settle();
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("stops polling once unmounted", async () => {
    listMock.mockResolvedValue(listing());
    const { unmount } = renderTray();
    await settle();
    unmount();
    await advance(PENDING_CHECKINS_POLL_INTERVAL_MS * 3);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flags a failed refresh with words", async () => {
    listMock.mockResolvedValueOnce(listing(kai));
    listMock.mockResolvedValueOnce({ ok: false });
    renderTray();
    await settle();
    await advance(PENDING_CHECKINS_POLL_INTERVAL_MS);
    expect(
      screen.getByText(
        "Couldn't refresh check-ins. Check your connection; this retries every few seconds.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Kai Moreno")).toBeInTheDocument();
  });
});
