// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { PendingCheckinRequest } from "@/server/checkin/hostCheckinResults";
import {
  INITIAL_TRAY_STATE,
  relativeTimeLabel,
  trayReducer,
  trayRowView,
  waitingRequestCount,
  type TrayEvent,
  type TrayRow,
  type TrayState,
} from "./pendingCheckinTrayState";

function pendingRequest(
  index: number,
  overrides: Partial<PendingCheckinRequest> = {},
): PendingCheckinRequest {
  return {
    checkinRequestId: `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    createdAt: new Date(Date.UTC(2026, 10, 7, 18, index)).toISOString(),
    firstName: "Kai",
    lastName: `Moreno${index}`,
    skillLevel: "beginner",
    gender: "male" as const,
    isNameAlreadyInSession: false,
    ...overrides,
  };
}

const grace = pendingRequest(1, { firstName: "Grace", lastName: "Kim" });
const kai = pendingRequest(2);
const peter = pendingRequest(3, {
  firstName: "Peter",
  lastName: "Lindqvist",
  skillLevel: "intermediate",
  gender: "male" as const,
});

let pollSequence = 0;
function polled(requests: PendingCheckinRequest[]): TrayEvent {
  pollSequence += 1;
  return {
    type: "poll_finished",
    pollSequence,
    result: { ok: true, requests },
  };
}

function pollFailed(): TrayEvent {
  pollSequence += 1;
  return { type: "poll_finished", pollSequence, result: { ok: false } };
}

function apply(state: TrayState, ...events: TrayEvent[]): TrayState {
  return events.reduce(trayReducer, state);
}

function rowFor(state: TrayState, request: PendingCheckinRequest): TrayRow {
  const row = state.rows.find(
    (candidate) =>
      candidate.request.checkinRequestId === request.checkinRequestId,
  );
  if (!row) throw new Error(`no row for ${request.firstName}`);
  return row;
}

function idsOf(state: TrayState): string[] {
  return state.rows.map((row) => row.request.checkinRequestId);
}

describe("trayReducer: polling", () => {
  it("lists requests oldest first and marks the tray loaded", () => {
    const state = apply(INITIAL_TRAY_STATE, polled([peter, grace, kai]));
    expect(state.hasLoaded).toBe(true);
    expect(idsOf(state)).toEqual([
      grace.checkinRequestId,
      kai.checkinRequestId,
      peter.checkinRequestId,
    ]);
    expect(waitingRequestCount(state.rows)).toBe(3);
  });

  it("drops an answer older than one already applied", () => {
    const newer: TrayEvent = {
      type: "poll_finished",
      pollSequence: 10,
      result: { ok: true, requests: [kai] },
    };
    const olderArrivingLate: TrayEvent = {
      type: "poll_finished",
      pollSequence: 9,
      result: { ok: true, requests: [kai, grace] },
    };
    const state = apply(INITIAL_TRAY_STATE, newer, olderArrivingLate);
    expect(idsOf(state)).toEqual([kai.checkinRequestId]);
  });

  it("keeps the rows shown and flags a failed refresh until one succeeds", () => {
    const afterFailure = apply(INITIAL_TRAY_STATE, polled([kai]), pollFailed());
    expect(afterFailure.isRefreshFailing).toBe(true);
    expect(idsOf(afterFailure)).toEqual([kai.checkinRequestId]);
    expect(apply(afterFailure, polled([kai])).isRefreshFailing).toBe(false);
  });

  it("switches a row to Reject only when its name becomes taken, and counts a change elsewhere", () => {
    const before = apply(INITIAL_TRAY_STATE, polled([grace]));
    const after = apply(
      before,
      polled([{ ...grace, isNameAlreadyInSession: true }]),
    );
    expect(
      trayRowView(rowFor(after, grace)).buttons.map((b) => b.kind),
    ).toEqual(["reject"]);
    expect(after.attendanceChangesSeenElsewhere).toBe(
      before.attendanceChangesSeenElsewhere + 1,
    );
  });

  it("drops a request another host decided and counts a change elsewhere", () => {
    const before = apply(INITIAL_TRAY_STATE, polled([grace, kai]));
    const after = apply(before, polled([grace]));
    expect(idsOf(after)).toEqual([grace.checkinRequestId]);
    expect(after.attendanceChangesSeenElsewhere).toBe(
      before.attendanceChangesSeenElsewhere + 1,
    );
  });

  it("counts nothing when the same requests come back", () => {
    const before = apply(INITIAL_TRAY_STATE, polled([grace, kai]));
    expect(
      apply(before, polled([grace, kai])).attendanceChangesSeenElsewhere,
    ).toBe(before.attendanceChangesSeenElsewhere);
  });

  it("keeps a row this tab is deciding when it leaves the poll (its own approval landed)", () => {
    const before = apply(INITIAL_TRAY_STATE, polled([kai]), {
      type: "decision_started",
      checkinRequestId: kai.checkinRequestId,
      action: "approve",
    });
    const after = apply(before, polled([]));
    expect(idsOf(after)).toEqual([kai.checkinRequestId]);
    expect(after.attendanceChangesSeenElsewhere).toBe(
      before.attendanceChangesSeenElsewhere,
    );
  });

  it("never brings back a row decided here, even from a poll that started earlier", () => {
    const decided = apply(
      INITIAL_TRAY_STATE,
      polled([kai]),
      {
        type: "decision_finished",
        checkinRequestId: kai.checkinRequestId,
        action: "reject",
        result: { kind: "rejected" },
      },
      { type: "decided_row_expired", checkinRequestId: kai.checkinRequestId },
    );
    expect(idsOf(decided)).toEqual([]);
    expect(idsOf(apply(decided, polled([kai])))).toEqual([]);
  });
});

describe("trayReducer: decisions", () => {
  const loaded = apply(INITIAL_TRAY_STATE, polled([grace, kai]));

  it.each([
    [{ kind: "approved", participant: null } as const, "approved"],
    [{ kind: "rejected" } as const, "rejected"],
    [{ kind: "already_decided" } as const, "decidedElsewhere"],
  ])("shows %o as the decided message %s", (result, outcome) => {
    const state = apply(loaded, {
      type: "decision_finished",
      checkinRequestId: kai.checkinRequestId,
      action: "approve",
      result,
    });
    expect(trayRowView(rowFor(state, kai)).decidedOutcome).toBe(outcome);
    expect(waitingRequestCount(state.rows)).toBe(1);
  });

  it("asks Who's playing to re-read when another host decided first, not after its own decision", () => {
    const decidedElsewhere = apply(loaded, {
      type: "decision_finished",
      checkinRequestId: kai.checkinRequestId,
      action: "approve",
      result: { kind: "already_decided" },
    });
    expect(decidedElsewhere.attendanceChangesSeenElsewhere).toBe(
      loaded.attendanceChangesSeenElsewhere + 1,
    );
    const rejectedHere = apply(loaded, {
      type: "decision_finished",
      checkinRequestId: kai.checkinRequestId,
      action: "reject",
      result: { kind: "rejected" },
    });
    expect(rejectedHere.attendanceChangesSeenElsewhere).toBe(
      loaded.attendanceChangesSeenElsewhere,
    );
  });

  it("removes a decided row once it expires", () => {
    const state = apply(
      loaded,
      {
        type: "decision_finished",
        checkinRequestId: kai.checkinRequestId,
        action: "approve",
        result: { kind: "approved", participant: null },
      },
      { type: "decided_row_expired", checkinRequestId: kai.checkinRequestId },
    );
    expect(idsOf(state)).toEqual([grace.checkinRequestId]);
  });

  it("turns an Approve refused for a name clash into a Reject-only row with the note", () => {
    const state = apply(loaded, {
      type: "decision_finished",
      checkinRequestId: grace.checkinRequestId,
      action: "approve",
      result: { kind: "name_already_in_session" },
    });
    const row = rowFor(state, grace);
    expect(row.request.isNameAlreadyInSession).toBe(true);
    const view = trayRowView(row);
    expect(view.attentions).toEqual(["nameAlreadyInSession"]);
    expect(view.showsAddedByAnotherHost).toBe(true);
    expect(view.buttons.map((b) => b.kind)).toEqual(["reject"]);
    expect(state.attendanceChangesSeenElsewhere).toBe(
      loaded.attendanceChangesSeenElsewhere + 1,
    );
  });

  it("keeps a failed row with Retry", () => {
    const state = apply(loaded, {
      type: "decision_finished",
      checkinRequestId: kai.checkinRequestId,
      action: "approve",
      result: { kind: "failed" },
    });
    const view = trayRowView(rowFor(state, kai));
    expect(view.attentions).toEqual([{ failedAction: "approve" }]);
    expect(view.buttons.map((b) => [b.kind, b.action])).toEqual([
      ["retry", "approve"],
      ["reject", "reject"],
    ]);
  });

  it("keeps a row whose live approval hit a changed session pending, with a fresh Approve", () => {
    const state = apply(loaded, {
      type: "decision_finished",
      checkinRequestId: kai.checkinRequestId,
      action: "approve",
      result: { kind: "session_changed" },
    });
    const view = trayRowView(rowFor(state, kai));
    // Never shown as approved, and a later poll may still list it.
    expect(view.decidedOutcome).toBeNull();
    expect(state.locallyDecidedRequestIds.has(kai.checkinRequestId)).toBe(
      false,
    );
    expect(waitingRequestCount(state.rows)).toBe(
      waitingRequestCount(loaded.rows),
    );
    expect(view.surface).toBe("attention");
    expect(view.attentions).toEqual(["sessionChanged"]);
    expect(view.buttons).toEqual([
      { kind: "approve", action: "approve", isDisabled: false, isBusy: false },
      { kind: "reject", action: "reject", isDisabled: false, isBusy: false },
    ]);
    // The conflict note survives the next poll until the host acts again.
    const repolled = apply(state, polled(loaded.rows.map((r) => r.request)));
    expect(trayRowView(rowFor(repolled, kai)).attentions).toEqual([
      "sessionChanged",
    ]);
  });
});

describe("trayRowView", () => {
  function viewOf(
    request: PendingCheckinRequest,
    activity: TrayRow["activity"] = { kind: "idle" },
  ) {
    return trayRowView({ request, activity });
  }

  it("offers Approve and Reject on an ordinary row", () => {
    const view = viewOf(kai);
    expect(view.surface).toBe("neutral");
    expect(view.attentions).toEqual([]);
    expect(view.buttons).toEqual([
      { kind: "approve", action: "approve", isDisabled: false, isBusy: false },
      { kind: "reject", action: "reject", isDisabled: false, isBusy: false },
    ]);
  });

  it("never offers Approve for a name already in the session (Reject only)", () => {
    const view = viewOf({ ...grace, isNameAlreadyInSession: true });
    expect(view.surface).toBe("attention");
    expect(view.attentions).toEqual(["nameAlreadyInSession"]);
    expect(view.showsAddedByAnotherHost).toBe(false);
    expect(view.buttons.map((b) => b.kind)).toEqual(["reject"]);
  });

  it("disables both buttons while approving and marks Approve busy", () => {
    const view = viewOf(kai, { kind: "working", action: "approve" });
    expect(view.buttons).toEqual([
      { kind: "approve", action: "approve", isDisabled: true, isBusy: true },
      { kind: "reject", action: "reject", isDisabled: true, isBusy: false },
    ]);
  });

  it("marks Reject busy while rejecting", () => {
    const view = viewOf(kai, { kind: "working", action: "reject" });
    expect(view.buttons.map((b) => [b.kind, b.isBusy, b.isDisabled])).toEqual([
      ["approve", false, true],
      ["reject", true, true],
    ]);
  });

  it("keeps Approve and retries a failed reject", () => {
    const view = viewOf(kai, { kind: "failed", action: "reject" });
    expect(view.attentions).toEqual([{ failedAction: "reject" }]);
    expect(view.buttons.map((b) => [b.kind, b.action])).toEqual([
      ["approve", "approve"],
      ["retry", "reject"],
    ]);
  });

  it("retries only Reject on a clashing row", () => {
    const view = viewOf(
      { ...grace, isNameAlreadyInSession: true },
      { kind: "failed", action: "reject" },
    );
    expect(view.attentions).toEqual([
      "nameAlreadyInSession",
      { failedAction: "reject" },
    ]);
    expect(view.buttons.map((b) => [b.kind, b.action])).toEqual([
      ["retry", "reject"],
    ]);
  });

  it("shows only the message once decided", () => {
    const approved = viewOf(kai, { kind: "decided", outcome: "approved" });
    expect(approved).toMatchObject({
      surface: "lime",
      decidedOutcome: "approved",
      buttons: [],
      attentions: [],
    });
    expect(
      viewOf(kai, { kind: "decided", outcome: "decidedElsewhere" }).surface,
    ).toBe("neutral");
  });
});

describe("relativeTimeLabel", () => {
  const sentAt = "2026-11-07T18:00:00.000Z";
  const sentAtMs = Date.parse(sentAt);

  it.each([
    [0, "Just now"],
    [59_999, "Just now"],
    [60_000, "1 min ago"],
    [2 * 60_000 + 30_000, "2 min ago"],
    [59 * 60_000, "59 min ago"],
    [60 * 60_000, "1 h ago"],
    [125 * 60_000, "2 h ago"],
    // The browser's clock a little behind the database's.
    [-30_000, "Just now"],
  ])("%i ms after sending reads %s", (elapsedMs, label) => {
    expect(relativeTimeLabel(sentAt, sentAtMs + elapsedMs)).toBe(label);
  });
});
