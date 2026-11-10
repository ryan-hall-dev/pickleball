"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import { SkillChip } from "@/components/SkillChip";
import { settleWithin } from "@/lib/settleWithin";
import {
  approveCheckin,
  closeCheckinAlreadyCheckedIn,
  listPendingCheckins,
  rejectCheckin,
} from "@/server/checkin/hostCheckinActions";
import type {
  HostCheckinDecisionResult,
  ListPendingCheckinsResult,
  PendingCheckinRequest,
} from "@/server/checkin/hostCheckinResults";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import { CheckIcon } from "./CheckIcon";
import {
  DECIDED_ROW_VISIBLE_MS,
  INITIAL_TRAY_STATE,
  displayedSkillLevel,
  levelChangeLabel,
  relativeTimeLabel,
  trayReducer,
  trayRowView,
  waitingRequestCount,
  type TrayDecidedOutcome,
  type TrayDecisionAction,
  type TrayRow,
  type TrayRowAttention,
  type TrayRowButton,
} from "./pendingCheckinTrayState";

/** Plan: the tray lists new requests within 5 s. */
export const PENDING_CHECKINS_POLL_INTERVAL_MS = 5_000;
/** A server call with no answer by then counts as failed (Retry). */
const SERVER_CALL_TIMEOUT_MS = 15_000;

const FAILED_LIST: ListPendingCheckinsResult = { ok: false };
const FAILED_DECISION: HostCheckinDecisionResult = { kind: "failed" };

const DECISION_FUNCTIONS: Record<
  TrayDecisionAction,
  (checkinRequestId: string) => Promise<HostCheckinDecisionResult>
> = {
  approve: approveCheckin,
  reject: rejectCheckin,
  close: closeCheckinAlreadyCheckedIn,
};

const HEADING_ID = "pending-checkins-heading";

/**
 * The host pending check-in tray (H00-H04): the open session's requests,
 * polled every 5 s while the page is visible, with Approve / Reject, or
 * Close for a member who is already attending. `onParticipantApproved` gets
 * the attendee this host approved (null: approved, but not read back);
 * `onAttendanceChangedElsewhere` runs when the requests suggest another host
 * changed the attendee list (a request left without a decision here, or a
 * member became attending), so Who's playing re-reads it.
 */
export function PendingCheckinTray({
  onParticipantApproved,
  onAttendanceChangedElsewhere,
}: {
  onParticipantApproved: (participant: DraftParticipant | null) => void;
  onAttendanceChangedElsewhere: () => void;
}) {
  const [state, dispatch] = useReducer(trayReducer, INITIAL_TRAY_STATE);
  const [nowMs, setNowMs] = useState(() => Date.now());

  usePendingCheckinsPolling(dispatch, setNowMs);

  const onAttendanceChangedElsewhereRef = useRef(onAttendanceChangedElsewhere);
  useEffect(() => {
    onAttendanceChangedElsewhereRef.current = onAttendanceChangedElsewhere;
  });
  useEffect(() => {
    if (state.attendanceChangesSeenElsewhere > 0) {
      onAttendanceChangedElsewhereRef.current();
    }
  }, [state.attendanceChangesSeenElsewhere]);

  const decide = useCallback(
    async (checkinRequestId: string, action: TrayDecisionAction) => {
      dispatch({ type: "decision_started", checkinRequestId, action });
      const result = await settleWithin(
        DECISION_FUNCTIONS[action](checkinRequestId),
        SERVER_CALL_TIMEOUT_MS,
        FAILED_DECISION,
      );
      dispatch({ type: "decision_finished", checkinRequestId, action, result });
      if (result.kind === "approved") {
        onParticipantApproved(result.participant);
      }
    },
    [onParticipantApproved],
  );

  const expireDecidedRow = useCallback((checkinRequestId: string) => {
    dispatch({ type: "decided_row_expired", checkinRequestId });
  }, []);

  const waitingCount = waitingRequestCount(state.rows);
  const isWaiting = waitingCount > 0;

  return (
    <section
      aria-labelledby={HEADING_ID}
      className={`rounded-card border bg-card px-4 py-4 sm:px-[22px] sm:py-5 ${
        isWaiting ? "border-blue-edge" : "border-card-border"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className={`flex size-8 shrink-0 items-center justify-center rounded-[10px] font-extrabold tabular-nums ${
            isWaiting
              ? "bg-blue text-on-blue"
              : "bg-inner-border text-text-soft"
          }`}
        >
          {waitingCount}
        </span>
        <div className="min-w-0 flex-[1_1_240px]">
          <h2 id={HEADING_ID} className="text-xl font-bold">
            Check-ins waiting <span className="sr-only">({waitingCount})</span>
          </h2>
          {isWaiting && (
            <p className="mt-0.5 text-[13px] text-muted">
              Approve to add them to Who&apos;s playing. Oldest first.
            </p>
          )}
        </div>
      </div>
      {state.isRefreshFailing && (
        <div className="mt-3">
          <AttentionMessage>
            Couldn&apos;t refresh check-ins. Check your connection; this retries
            every few seconds.
          </AttentionMessage>
        </div>
      )}
      {state.rows.length > 0 ? (
        // New rows and decided messages are announced; the minute-by-minute
        // "2 min ago" text changes are not (aria-relevant="additions").
        <ul
          aria-live="polite"
          aria-relevant="additions"
          className="mt-4 flex flex-col gap-2"
        >
          {state.rows.map((row) => (
            <PendingCheckinRow
              key={row.request.checkinRequestId}
              row={row}
              nowMs={nowMs}
              onDecide={decide}
              onDecidedRowExpired={expireDecidedRow}
            />
          ))}
        </ul>
      ) : state.hasLoaded ? (
        <div className="mt-3.5 flex items-center gap-3 rounded-[18px] border border-dashed border-outline px-4 py-3.5 text-sm text-text-soft">
          <InfoBadge />
          <span>
            No check-ins waiting. Players scan the social&apos;s QR code or tap
            the sticker to check in.
          </span>
        </div>
      ) : (
        !state.isRefreshFailing && (
          <p className="mt-3 text-sm text-muted">Looking for check-ins…</p>
        )
      )}
    </section>
  );
}

/**
 * Reads the pending requests now and every 5 s, skipping while the page is
 * hidden or a read is still on its way, and reading again as soon as the
 * page is shown. Each read is numbered so a
 * slow answer can't replace a newer one (the reducer drops it).
 */
function usePendingCheckinsPolling(
  dispatch: (event: {
    type: "poll_finished";
    pollSequence: number;
    result: ListPendingCheckinsResult;
  }) => void,
  setNowMs: (nowMs: number) => void,
) {
  const pollSequenceRef = useRef(0);
  /**
   * Set until the server call itself settles (not the 15 s timeout): Next
   * runs server actions one at a time per page, so polls piling up behind a
   * hung one would also hold back autosave and Approve.
   */
  const isPollInFlightRef = useRef(false);
  useEffect(() => {
    let isStopped = false;
    function readPendingCheckins() {
      if (document.hidden || isPollInFlightRef.current) return;
      isPollInFlightRef.current = true;
      pollSequenceRef.current += 1;
      const pollSequence = pollSequenceRef.current;
      const listCall = listPendingCheckins();
      void listCall.then(
        () => {
          isPollInFlightRef.current = false;
        },
        () => {
          isPollInFlightRef.current = false;
        },
      );
      void settleWithin(listCall, SERVER_CALL_TIMEOUT_MS, FAILED_LIST).then(
        (result) => {
          if (isStopped) return;
          setNowMs(Date.now());
          dispatch({ type: "poll_finished", pollSequence, result });
        },
      );
    }
    readPendingCheckins();
    const interval = setInterval(
      readPendingCheckins,
      PENDING_CHECKINS_POLL_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", readPendingCheckins);
    return () => {
      isStopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", readPendingCheckins);
    };
  }, [dispatch, setNowMs]);
}

const ROW_SURFACE_CLASS_NAMES = {
  neutral: "border-inner-border bg-inner",
  attention: "border-orange-edge bg-orange-surface-row",
  lime: "border-lime-edge bg-lime-surface",
} as const;

function fullName(request: PendingCheckinRequest): string {
  return `${request.firstName} ${request.lastName}`;
}

function PendingCheckinRow({
  row,
  nowMs,
  onDecide,
  onDecidedRowExpired,
}: {
  row: TrayRow;
  nowMs: number;
  onDecide: (checkinRequestId: string, action: TrayDecisionAction) => void;
  onDecidedRowExpired: (checkinRequestId: string) => void;
}) {
  const { request } = row;
  const view = trayRowView(row);
  const { checkinRequestId } = request;
  const isDecided = view.decidedOutcome !== null;

  useEffect(() => {
    if (!isDecided) return;
    const timeout = setTimeout(
      () => onDecidedRowExpired(checkinRequestId),
      DECIDED_ROW_VISIBLE_MS,
    );
    return () => clearTimeout(timeout);
  }, [isDecided, checkinRequestId, onDecidedRowExpired]);

  const name = fullName(request);
  const avatarTone =
    view.surface === "lime"
      ? "playing"
      : view.surface === "attention"
        ? "attention"
        : "waiting";
  const isWorking = row.activity.kind === "working";

  return (
    <li
      aria-busy={isWorking || undefined}
      className={`flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-[18px] border px-3 py-2.5 ${
        ROW_SURFACE_CLASS_NAMES[view.surface]
      }`}
    >
      <div className="flex min-w-0 flex-[999_1_260px] items-center gap-3">
        <InitialsAvatar name={name} tone={avatarTone} />
        <div className="min-w-0">
          <p
            className={`truncate text-[15px] font-semibold ${
              view.decidedOutcome === "decidedElsewhere" ? "text-muted" : ""
            }`}
          >
            {name}
          </p>
          {view.decidedOutcome ? (
            <DecidedMessage outcome={view.decidedOutcome} />
          ) : (
            <>
              <RequestDetails request={request} nowMs={nowMs} />
              {view.attentions.map((attention) => (
                <RowAttention
                  key={
                    typeof attention === "string"
                      ? attention
                      : `failed-${attention.failedAction}`
                  }
                  attention={attention}
                />
              ))}
              {view.showsAddedByAnotherHost && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-text-soft">
                  <InfoBadge />
                  Added by another host a moment ago.
                </p>
              )}
            </>
          )}
        </div>
      </div>
      {view.buttons.length > 0 && (
        <div className="flex flex-[1_1_236px] flex-wrap justify-end gap-2">
          {view.buttons.map((rowButton) => (
            <RowButton
              key={rowButton.kind}
              rowButton={rowButton}
              name={name}
              onPress={() => onDecide(checkinRequestId, rowButton.action)}
            />
          ))}
        </div>
      )}
    </li>
  );
}

function RequestDetails({
  request,
  nowMs,
}: {
  request: PendingCheckinRequest;
  nowMs: number;
}) {
  const levelChange = levelChangeLabel(request);
  return (
    <div className="mt-[3px] flex flex-wrap items-center gap-1.5 text-xs text-muted">
      {request.memberId ? (
        <span className="shrink-0 rounded-full bg-inner-border px-2 py-[3px] text-xs font-semibold text-text-soft">
          Member
        </span>
      ) : (
        <span className="shrink-0 rounded-full border border-blue-edge bg-blue-surface px-2 py-0.5 text-[11px] font-bold tracking-[0.08em] text-link uppercase">
          New player
        </span>
      )}
      <SkillChip skillLevel={displayedSkillLevel(request)} />
      {levelChange && (
        <>
          <span>{levelChange}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span className="tabular-nums">
        {relativeTimeLabel(request.createdAt, nowMs)}
      </span>
    </div>
  );
}

const FAILED_ACTION_WORDS: Record<TrayDecisionAction, string> = {
  approve: "Couldn't approve.",
  reject: "Couldn't reject.",
  close: "Couldn't close the request.",
};

function RowAttention({ attention }: { attention: TrayRowAttention }) {
  const [headline, detail] =
    attention === "alreadyAttending"
      ? ["Already checked in to this session.", "They can't be added twice."]
      : attention === "possibleDuplicate"
        ? [
            "Possible duplicate: same name as someone already checked in.",
            "A matching name doesn't mean it's the same person. Check with them before approving.",
          ]
        : [
            FAILED_ACTION_WORDS[attention.failedAction],
            "Check your connection and retry.",
          ];
  const isFailure = typeof attention !== "string";
  return (
    <p
      role={isFailure ? "alert" : undefined}
      className="mt-1.5 flex items-start gap-1.5 text-[13px] font-semibold text-orange-soft"
    >
      <span
        aria-hidden="true"
        className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-orange text-[11px] font-extrabold text-on-orange"
      >
        !
      </span>
      <span>
        {headline}{" "}
        <span className="font-normal text-orange-text">{detail}</span>
      </span>
    </p>
  );
}

const DECIDED_MESSAGES: Record<TrayDecidedOutcome, string> = {
  approved: "Added to Who's playing",
  rejected: 'Check-in rejected. The player sees "Please speak to the host".',
  closed: "Request closed. Their phone shows they're already checked in.",
  decidedElsewhere: "Already decided by another host",
};

function DecidedMessage({ outcome }: { outcome: TrayDecidedOutcome }) {
  const isApproved = outcome === "approved";
  return (
    <p
      role="status"
      className={`mt-[3px] flex items-center gap-1.5 text-[13px] ${
        isApproved ? "text-lime-soft" : "text-text-soft"
      }`}
    >
      {isApproved ? (
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-lime text-on-lime">
          <CheckIcon sizePx={12} />
        </span>
      ) : (
        <InfoBadge />
      )}
      {DECIDED_MESSAGES[outcome]}
    </p>
  );
}

function InfoBadge() {
  return (
    <span
      aria-hidden="true"
      className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-inner-border text-[11px] font-extrabold text-text"
    >
      i
    </span>
  );
}

const BUSY_WORDS: Record<TrayDecisionAction, string> = {
  approve: "Approving…",
  reject: "Rejecting…",
  close: "Closing…",
};

function rowButtonWords(
  rowButton: TrayRowButton,
  name: string,
): { label: string; accessibleName: string } {
  switch (rowButton.kind) {
    case "approve":
      return { label: "Approve", accessibleName: `Approve ${name}` };
    case "close":
      return {
        label: "Close: already checked in",
        accessibleName: `Close ${name}'s request: already checked in`,
      };
    case "reject":
      return { label: "Reject", accessibleName: `Reject ${name}` };
    case "retry":
      return {
        label: "Retry",
        accessibleName:
          rowButton.action === "approve"
            ? `Retry approving ${name}`
            : rowButton.action === "reject"
              ? `Retry rejecting ${name}`
              : `Retry closing ${name}'s request`,
      };
  }
}

function RowButton({
  rowButton,
  name,
  onPress,
}: {
  rowButton: TrayRowButton;
  name: string;
  onPress: () => void;
}) {
  const { label, accessibleName } = rowButtonWords(rowButton, name);
  const isBlue = rowButton.kind !== "reject";
  const isWide = rowButton.kind === "close";
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={rowButton.isDisabled}
      aria-label={rowButton.isBusy ? undefined : accessibleName}
      className={`${isBlue ? SECONDARY_BUTTON_CLASS_NAME : OUTLINE_BUTTON_CLASS_NAME} gap-2 whitespace-nowrap ${
        isWide
          ? "flex-[2_1_auto] max-sm:max-w-none sm:max-w-[260px]"
          : "flex-[1_1_0] max-sm:max-w-none sm:max-w-[140px]"
      }`}
    >
      {rowButton.isBusy ? (
        <>
          <Spinner />
          {BUSY_WORDS[rowButton.action]}
        </>
      ) : (
        <>
          {rowButton.kind === "approve" && <CheckIcon sizePx={16} />}
          {label}
        </>
      )}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      className="animate-spin motion-reduce:animate-none"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  );
}
