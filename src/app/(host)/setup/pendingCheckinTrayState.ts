// Pure state and view rules for the host pending check-in tray (M5,
// docs/designs/m5/host-tray.html H00-H04). No React here, so it's unit tested
// directly. The tray polls the open session's pending requests every 5 s;
// each row also has this tab's own activity (approving, failed, decided...).
import {
  SKILL_LEVEL_LABELS,
  type SkillLevel,
} from "@/server/members/memberSearch";
import type {
  HostCheckinDecisionResult,
  ListPendingCheckinsResult,
  PendingCheckinRequest,
} from "@/server/checkin/hostCheckinResults";

export type TrayDecisionAction = "approve" | "reject" | "close";

/** How a row was decided, for the one-line message shown before it leaves. */
export type TrayDecidedOutcome =
  "approved" | "rejected" | "closed" | "decidedElsewhere";

/** This tab's own activity on a row. */
export type TrayRowActivity =
  | { kind: "idle" }
  | { kind: "working"; action: TrayDecisionAction }
  | { kind: "failed"; action: TrayDecisionAction }
  /** Approve was refused: the member became attending meanwhile (H03). */
  | { kind: "approveStopped" }
  | { kind: "decided"; outcome: TrayDecidedOutcome };

export interface TrayRow {
  request: PendingCheckinRequest;
  activity: TrayRowActivity;
}

export interface TrayState {
  /** Oldest first. */
  rows: TrayRow[];
  /** The first poll has answered (until then there is no empty state). */
  hasLoaded: boolean;
  /** The latest poll failed (the rows shown are from an earlier one). */
  isRefreshFailing: boolean;
  /** The newest poll applied; older answers arriving late are dropped. */
  latestAppliedPollSequence: number;
  /** Decided here: a poll that started before the decision can't bring them back. */
  locallyDecidedRequestIds: ReadonlySet<string>;
  /**
   * Counts the times the attendee list looked changed by someone else (a
   * request left without a decision here, a member became attending, or an
   * Approve/Close was refused), so Who's playing re-reads it.
   */
  attendanceChangesSeenElsewhere: number;
}

export type TrayEvent =
  | {
      type: "poll_finished";
      pollSequence: number;
      result: ListPendingCheckinsResult;
    }
  | {
      type: "decision_started";
      checkinRequestId: string;
      action: TrayDecisionAction;
    }
  | {
      type: "decision_finished";
      checkinRequestId: string;
      action: TrayDecisionAction;
      result: HostCheckinDecisionResult;
    }
  | { type: "decided_row_expired"; checkinRequestId: string };

/** Decided rows show their message for this long, then leave (README #6). */
export const DECIDED_ROW_VISIBLE_MS = 4_000;

export const INITIAL_TRAY_STATE: TrayState = {
  rows: [],
  hasLoaded: false,
  isRefreshFailing: false,
  latestAppliedPollSequence: 0,
  locallyDecidedRequestIds: new Set(),
  attendanceChangesSeenElsewhere: 0,
};

function byOldestFirst(first: TrayRow, second: TrayRow): number {
  const byCreatedAt =
    Date.parse(first.request.createdAt) - Date.parse(second.request.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return first.request.checkinRequestId < second.request.checkinRequestId
    ? -1
    : 1;
}

/** Rows whose state only this tab knows: they stay after leaving the poll. */
function isKeptWithoutPoll(activity: TrayRowActivity): boolean {
  return activity.kind === "working" || activity.kind === "decided";
}

function mergePolledRequests(
  state: TrayState,
  polledRequests: readonly PendingCheckinRequest[],
): TrayState {
  const previousRowsById = new Map(
    state.rows.map((row) => [row.request.checkinRequestId, row]),
  );
  const polledRows: TrayRow[] = polledRequests
    .filter(
      (request) =>
        !state.locallyDecidedRequestIds.has(request.checkinRequestId),
    )
    .map((request) => ({
      request,
      activity: previousRowsById.get(request.checkinRequestId)?.activity ?? {
        kind: "idle",
      },
    }));
  const polledIds = new Set(
    polledRows.map((row) => row.request.checkinRequestId),
  );
  const rowsKeptWithoutPoll = state.rows.filter(
    (row) =>
      !polledIds.has(row.request.checkinRequestId) &&
      isKeptWithoutPoll(row.activity),
  );
  const leftWithoutDecisionHere = state.rows.some(
    (row) =>
      !polledIds.has(row.request.checkinRequestId) &&
      !isKeptWithoutPoll(row.activity),
  );
  const memberBecameAttending = polledRows.some(
    (row) =>
      row.request.isAlreadyAttending &&
      previousRowsById.get(row.request.checkinRequestId)?.request
        .isAlreadyAttending === false,
  );
  return {
    ...state,
    rows: [...polledRows, ...rowsKeptWithoutPoll].sort(byOldestFirst),
    attendanceChangesSeenElsewhere:
      state.attendanceChangesSeenElsewhere +
      (leftWithoutDecisionHere || memberBecameAttending ? 1 : 0),
  };
}

function updateRow(
  state: TrayState,
  checkinRequestId: string,
  update: (row: TrayRow) => TrayRow,
): TrayState {
  return {
    ...state,
    rows: state.rows.map((row) =>
      row.request.checkinRequestId === checkinRequestId ? update(row) : row,
    ),
  };
}

function decideRow(
  state: TrayState,
  checkinRequestId: string,
  outcome: TrayDecidedOutcome,
): TrayState {
  return {
    ...updateRow(state, checkinRequestId, (row) => ({
      ...row,
      activity: { kind: "decided", outcome },
    })),
    locallyDecidedRequestIds: new Set([
      ...state.locallyDecidedRequestIds,
      checkinRequestId,
    ]),
  };
}

function finishDecision(
  state: TrayState,
  checkinRequestId: string,
  action: TrayDecisionAction,
  result: HostCheckinDecisionResult,
): TrayState {
  switch (result.kind) {
    case "approved":
      return decideRow(state, checkinRequestId, "approved");
    case "rejected":
      return decideRow(state, checkinRequestId, "rejected");
    case "closed":
      return decideRow(state, checkinRequestId, "closed");
    case "already_decided":
      // Another host's decision (or this tab's own that timed out) may have
      // added an attendee, and the row is filtered from later polls now.
      return {
        ...decideRow(state, checkinRequestId, "decidedElsewhere"),
        attendanceChangesSeenElsewhere:
          state.attendanceChangesSeenElsewhere + 1,
      };
    case "already_in_session":
      return {
        ...updateRow(state, checkinRequestId, (row) => ({
          request: { ...row.request, isAlreadyAttending: true },
          activity: { kind: "approveStopped" },
        })),
        attendanceChangesSeenElsewhere:
          state.attendanceChangesSeenElsewhere + 1,
      };
    case "not_already_in_session":
      // The member left the session meanwhile: back to Approve / Reject.
      return {
        ...updateRow(state, checkinRequestId, (row) => ({
          request: { ...row.request, isAlreadyAttending: false },
          activity: { kind: "idle" },
        })),
        attendanceChangesSeenElsewhere:
          state.attendanceChangesSeenElsewhere + 1,
      };
    case "failed":
      return updateRow(state, checkinRequestId, (row) => ({
        ...row,
        activity: { kind: "failed", action },
      }));
  }
}

export function trayReducer(state: TrayState, event: TrayEvent): TrayState {
  switch (event.type) {
    case "poll_finished": {
      if (event.pollSequence <= state.latestAppliedPollSequence) return state;
      const polled = {
        ...state,
        latestAppliedPollSequence: event.pollSequence,
      };
      if (!event.result.ok) return { ...polled, isRefreshFailing: true };
      return {
        ...mergePolledRequests(polled, event.result.requests),
        hasLoaded: true,
        isRefreshFailing: false,
      };
    }
    case "decision_started":
      return updateRow(state, event.checkinRequestId, (row) => ({
        ...row,
        activity: { kind: "working", action: event.action },
      }));
    case "decision_finished":
      return finishDecision(
        state,
        event.checkinRequestId,
        event.action,
        event.result,
      );
    case "decided_row_expired":
      return {
        ...state,
        rows: state.rows.filter(
          (row) => row.request.checkinRequestId !== event.checkinRequestId,
        ),
      };
  }
}

/** Requests still waiting for a decision (the count badge). */
export function waitingRequestCount(rows: readonly TrayRow[]): number {
  return rows.filter((row) => row.activity.kind !== "decided").length;
}

export type TrayRowButtonKind = "approve" | "close" | "reject" | "retry";

export interface TrayRowButton {
  kind: TrayRowButtonKind;
  /** The action it runs (Retry re-runs the failed one). */
  action: TrayDecisionAction;
  isDisabled: boolean;
  /** This button's action is on its way (spinner + "Approving…"). */
  isBusy: boolean;
}

export type TrayRowAttention =
  | "alreadyAttending"
  | "possibleDuplicate"
  | { failedAction: TrayDecisionAction };

export interface TrayRowView {
  surface: "neutral" | "attention" | "lime";
  /** Orange `!` lines, in order (status is never colour alone). */
  attentions: TrayRowAttention[];
  /** "Added by another host a moment ago." after a refused Approve. */
  showsAddedByAnotherHost: boolean;
  /** Set once decided: the message shown before the row leaves. */
  decidedOutcome: TrayDecidedOutcome | null;
  buttons: TrayRowButton[];
}

function button(
  kind: TrayRowButtonKind,
  action: TrayDecisionAction,
  activity: TrayRowActivity,
): TrayRowButton {
  const isWorking = activity.kind === "working";
  return {
    kind,
    action,
    isDisabled: isWorking,
    isBusy: isWorking && activity.action === action && kind !== "retry",
  };
}

/** Which buttons and messages a row shows (H01, H03). */
export function trayRowView(row: TrayRow): TrayRowView {
  const { request, activity } = row;
  if (activity.kind === "decided") {
    return {
      surface: activity.outcome === "approved" ? "lime" : "neutral",
      attentions: [],
      showsAddedByAnotherHost: false,
      decidedOutcome: activity.outcome,
      buttons: [],
    };
  }
  const isAlreadyAttending =
    request.isAlreadyAttending || activity.kind === "approveStopped";
  // An attending member is never approved again: Close replaces Approve.
  const primaryAction: TrayDecisionAction = isAlreadyAttending
    ? "close"
    : "approve";
  const attentions: TrayRowAttention[] = [];
  if (isAlreadyAttending) attentions.push("alreadyAttending");
  else if (request.isPossibleDuplicate) attentions.push("possibleDuplicate");
  if (activity.kind === "failed") {
    attentions.push({ failedAction: activity.action });
  }
  const buttons =
    activity.kind === "failed"
      ? activity.action === "reject"
        ? [
            button(primaryAction, primaryAction, activity),
            button("retry", "reject", activity),
          ]
        : [
            button("retry", activity.action, activity),
            button("reject", "reject", activity),
          ]
      : [
          button(primaryAction, primaryAction, activity),
          button("reject", "reject", activity),
        ];
  return {
    surface: attentions.length > 0 ? "attention" : "neutral",
    attentions,
    showsAddedByAnotherHost: activity.kind === "approveStopped",
    decidedOutcome: null,
    buttons,
  };
}

/** The level chip: the level the player chose, else the member's saved one. */
export function displayedSkillLevel(
  request: PendingCheckinRequest,
): SkillLevel | null {
  return request.requestedSkillLevel ?? request.savedSkillLevel;
}

/**
 * "level changed from Advanced" when a member chose a level other than their
 * saved one (README #4); null otherwise (new players have no saved level).
 */
export function levelChangeLabel(
  request: PendingCheckinRequest,
): string | null {
  const { memberId, requestedSkillLevel, savedSkillLevel } = request;
  if (
    memberId === null ||
    requestedSkillLevel === null ||
    savedSkillLevel === null ||
    requestedSkillLevel === savedSkillLevel
  ) {
    return null;
  }
  return `level changed from ${SKILL_LEVEL_LABELS[savedSkillLevel]}`;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/** "Just now", "2 min ago", "1 h ago" (a clock a little ahead reads as just now). */
export function relativeTimeLabel(createdAtIso: string, nowMs: number): string {
  const minutes = Math.floor(
    (nowMs - Date.parse(createdAtIso)) / MS_PER_MINUTE,
  );
  if (minutes < 1) return "Just now";
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min ago`;
  return `${Math.floor(minutes / MINUTES_PER_HOUR)} h ago`;
}
