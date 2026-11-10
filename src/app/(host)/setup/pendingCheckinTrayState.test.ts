// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { PendingCheckinRequest } from "@/server/checkin/hostCheckinResults";
import {
  INITIAL_TRAY_STATE,
  displayedSkillLevel,
  levelChangeLabel,
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
    memberId: null,
    firstName: "Kai",
    lastName: `Moreno${index}`,
    requestedSkillLevel: "beginner",
    savedSkillLevel: null,
    isAlreadyAttending: false,
    isPossibleDuplicate: false,
    ...overrides,
  };
}

const grace = pendingRequest(1, {
  memberId: "b0000000-0000-4000-8000-000000000001",
  firstName: "Grace",
  lastName: "Kim",
  requestedSkillLevel: null,
  savedSkillLevel: "beginner",
});
const kai = pendingRequest(2);
const peter = pendingRequest(3, {
  memberId: "b0000000-0000-4000-8000-000000000003",
  firstName: "Peter",
  lastName: "Lindqvist",
  requestedSkillLevel: "intermediate",
  savedSkillLevel: "advanced",
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

  it("switches a row to already attending on the next poll and counts a change elsewhere", () => {
    const before = apply(INITIAL_TRAY_STATE, polled([grace]));
    const after = apply(
      before,
      polled([{ ...grace, isAlreadyAttending: true }]),
    );
    expect(
      trayRowView(rowFor(after, grace)).buttons.map((b) => b.kind),
    ).toEqual(["close", "reject"]);
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
    [{ kind: "closed" } as const, "closed"],
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

  it("turns a refused Approve into the already-checked-in row with the note", () => {
    const state = apply(loaded, {
      type: "decision_finished",
      checkinRequestId: grace.checkinRequestId,
      action: "approve",
      result: { kind: "already_in_session" },
    });
    const view = trayRowView(rowFor(state, grace));
    expect(view.attentions).toEqual(["alreadyAttending"]);
    expect(view.showsAddedByAnotherHost).toBe(true);
    expect(view.buttons.map((b) => b.kind)).toEqual(["close", "reject"]);
    expect(state.attendanceChangesSeenElsewhere).toBe(
      loaded.attendanceChangesSeenElsewhere + 1,
    );
  });

  it("turns a refused Close back into Approve / Reject", () => {
    const attending = apply(
      INITIAL_TRAY_STATE,
      polled([{ ...grace, isAlreadyAttending: true }]),
    );
    const state = apply(attending, {
      type: "decision_finished",
      checkinRequestId: grace.checkinRequestId,
      action: "close",
      result: { kind: "not_already_in_session" },
    });
    const view = trayRowView(rowFor(state, grace));
    expect(view.attentions).toEqual([]);
    expect(view.buttons.map((b) => b.kind)).toEqual(["approve", "reject"]);
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

  it("never offers Approve for a member already attending", () => {
    const view = viewOf({ ...grace, isAlreadyAttending: true });
    expect(view.surface).toBe("attention");
    expect(view.attentions).toEqual(["alreadyAttending"]);
    expect(view.showsAddedByAnotherHost).toBe(false);
    expect(view.buttons.map((b) => b.kind)).toEqual(["close", "reject"]);
  });

  it("warns about a possible duplicate and keeps Approve and Reject", () => {
    const view = viewOf({ ...kai, isPossibleDuplicate: true });
    expect(view.surface).toBe("attention");
    expect(view.attentions).toEqual(["possibleDuplicate"]);
    expect(view.buttons.map((b) => b.kind)).toEqual(["approve", "reject"]);
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

  it("keeps the primary action and retries a failed reject", () => {
    const view = viewOf(
      { ...grace, isAlreadyAttending: true },
      { kind: "failed", action: "reject" },
    );
    expect(view.attentions).toEqual([
      "alreadyAttending",
      { failedAction: "reject" },
    ]);
    expect(view.buttons.map((b) => [b.kind, b.action])).toEqual([
      ["close", "close"],
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

describe("levels", () => {
  it("shows the level a member chose with the level it replaces", () => {
    expect(displayedSkillLevel(peter)).toBe("intermediate");
    expect(levelChangeLabel(peter)).toBe("level changed from Advanced");
  });

  it("shows the saved level when a member kept it", () => {
    expect(displayedSkillLevel(grace)).toBe("beginner");
    expect(levelChangeLabel(grace)).toBeNull();
  });

  it("says nothing changed when the chosen level is the saved one", () => {
    expect(
      levelChangeLabel({ ...peter, requestedSkillLevel: "advanced" }),
    ).toBeNull();
  });

  it("says nothing changed for a member with no saved level, or a new player", () => {
    expect(levelChangeLabel({ ...peter, savedSkillLevel: null })).toBeNull();
    expect(levelChangeLabel(kai)).toBeNull();
    expect(displayedSkillLevel(kai)).toBe("beginner");
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
