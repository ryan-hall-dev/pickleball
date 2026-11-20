"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  INNER_BOX_TEXT_INPUT_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import { useMessages } from "@/i18n/LocaleProvider";
import type { Messages } from "@/i18n/messages";
import { GENDERS, genderSchema, type Gender } from "@/server/participantRules";
import { SkillChip } from "@/components/SkillChip";
import { settleWithin } from "@/lib/settleWithin";
import {
  approveCheckin,
  listPendingCheckins,
  rejectCheckin,
} from "@/server/checkin/hostCheckinActions";
import type {
  HostCheckinDecisionResult,
  ListPendingCheckinsResult,
  PendingCheckinRequest,
} from "@/server/checkin/hostCheckinResults";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import { QrCodeIcon } from "../checkin-link/CheckinLinkIcons";
import { STICKER_AND_QR_PAGE_PATH } from "../checkin-link/checkinLinkPaths";
import { CheckIcon } from "./CheckIcon";
import {
  DECIDED_ROW_VISIBLE_MS,
  INITIAL_TRAY_STATE,
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
  (
    checkinRequestId: string,
    missingGender?: Gender,
  ) => Promise<HostCheckinDecisionResult>
> = {
  approve: approveCheckin,
  reject: rejectCheckin,
};

const HEADING_ID = "pending-checkins-heading";

/**
 * The host pending check-in tray (H00-H04): the open session's requests,
 * polled every 5 s while the page is visible, with Approve / Reject (Reject
 * only when the name is already in the session). `onParticipantApproved`
 * gets the attendee this host approved (null: approved, but not read back);
 * `onAttendanceChangedElsewhere` runs when the requests suggest another host
 * changed the attendee list (a request left without a decision here, or a
 * request's name became taken), so Who's playing re-reads it.
 */
export function PendingCheckinTray({
  onParticipantApproved,
  onAttendanceChangedElsewhere,
  approveDecision = approveCheckin,
  onWaitingCountChange,
}: {
  onParticipantApproved: (participant: DraftParticipant | null) => void;
  onAttendanceChangedElsewhere: () => void;
  /** Live supplies client event metadata; draft approval keeps its existing path. */
  approveDecision?: (
    requestId: string,
    missingGender?: Gender,
  ) => Promise<HostCheckinDecisionResult>;
  /** Live shows the count on its Check-ins link. */
  onWaitingCountChange?: (waitingCount: number) => void;
}) {
  const text = useMessages().host.tray;
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
    async (
      checkinRequestId: string,
      action: TrayDecisionAction,
      missingGender?: Gender,
    ) => {
      dispatch({ type: "decision_started", checkinRequestId, action });
      const decision =
        action === "approve" ? approveDecision : DECISION_FUNCTIONS[action];
      const result = await settleWithin(
        missingGender
          ? decision(checkinRequestId, missingGender)
          : decision(checkinRequestId),
        SERVER_CALL_TIMEOUT_MS,
        FAILED_DECISION,
      );
      dispatch({ type: "decision_finished", checkinRequestId, action, result });
      if (result.kind === "approved") {
        onParticipantApproved(result.participant);
      }
    },
    [onParticipantApproved, approveDecision],
  );

  const expireDecidedRow = useCallback((checkinRequestId: string) => {
    dispatch({ type: "decided_row_expired", checkinRequestId });
  }, []);

  const waitingCount = waitingRequestCount(state.rows);
  const isWaiting = waitingCount > 0;
  useEffect(() => {
    onWaitingCountChange?.(waitingCount);
  }, [waitingCount, onWaitingCountChange]);

  return (
    <section
      aria-labelledby={HEADING_ID}
      className={`rounded-card border bg-card px-4 py-4 lg:px-[22px] lg:py-5 compact:rounded-2xl compact:p-3 ${
        isWaiting ? "border-blue-edge" : "border-card-border"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3 compact:flex-nowrap compact:gap-2.5">
        <span
          aria-hidden="true"
          className={`flex size-8 shrink-0 items-center justify-center rounded-[10px] font-extrabold tabular-nums compact:size-7 compact:text-sm ${
            isWaiting
              ? "bg-blue text-on-blue"
              : "bg-inner-border text-text-soft"
          }`}
        >
          {waitingCount}
        </span>
        <div className="min-w-0 flex-[1_1_240px] compact:flex-1">
          <h2 id={HEADING_ID} className="text-xl font-bold compact:text-base">
            {text.heading} <span className="sr-only">({waitingCount})</span>
          </h2>
          {isWaiting && (
            <p className="mt-0.5 text-[13px] text-muted compact:text-xs">
              {text.intro}
            </p>
          )}
        </div>
        {/* Always in the header, empty or not (decision #8, H02). */}
        <Link
          href={STICKER_AND_QR_PAGE_PATH}
          className={`${OUTLINE_BUTTON_CLASS_NAME} shrink-0 gap-2 whitespace-nowrap`}
        >
          <QrCodeIcon />
          {text.showQrCode}
        </Link>
      </div>
      {state.isRefreshFailing && (
        <div className="mt-3">
          <AttentionMessage>{text.refreshFailing}</AttentionMessage>
        </div>
      )}
      {state.rows.length > 0 ? (
        // New rows and decided messages are announced; the minute-by-minute
        // "2 min ago" text changes are not (aria-relevant="additions").
        <ul
          aria-live="polite"
          aria-relevant="additions"
          className="mt-4 flex flex-col gap-2 compact:mt-2.5"
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
        <div className="mt-3.5 flex items-center gap-3 rounded-[18px] border border-dashed border-outline px-4 py-3.5 text-sm text-text-soft compact:mt-2.5 compact:rounded-xl compact:px-3 compact:py-2 compact:text-xs">
          <InfoBadge />
          <span>{text.empty}</span>
        </div>
      ) : (
        !state.isRefreshFailing && (
          <p className="mt-3 text-sm text-muted">{text.looking}</p>
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
  onDecide: (
    checkinRequestId: string,
    action: TrayDecisionAction,
    missingGender?: Gender,
  ) => void;
  onDecidedRowExpired: (checkinRequestId: string) => void;
}) {
  const messages = useMessages();
  const text = messages.host.tray;
  const { request } = row;
  const [missingGender, setMissingGender] = useState("");
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
      className={`flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-[18px] border px-3 py-2.5 compact:gap-x-2.5 compact:gap-y-2 compact:rounded-xl compact:py-2 ${
        ROW_SURFACE_CLASS_NAMES[view.surface]
      }`}
    >
      <div className="flex min-w-0 flex-[999_1_260px] items-center gap-3">
        <InitialsAvatar name={name} tone={avatarTone} />
        <div className="min-w-0">
          <p
            className={`text-[15px] font-semibold break-words compact:text-sm ${
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
                  {text.addedByAnotherHost}
                </p>
              )}
            </>
          )}
        </div>
      </div>
      {!request.gender && !isDecided && (
        <select
          aria-label={text.genderFor(name)}
          disabled={isWorking}
          value={missingGender}
          onChange={(event) => setMissingGender(event.target.value)}
          className={INNER_BOX_TEXT_INPUT_CLASS_NAME}
        >
          <option value="">{text.chooseGender}</option>
          {GENDERS.map((gender) => (
            <option key={gender} value={gender}>
              {messages.genders[gender]}
            </option>
          ))}
        </select>
      )}
      {view.buttons.length > 0 && (
        <div className="flex flex-[1_1_236px] flex-wrap justify-end gap-2">
          {view.buttons.map((rowButton) => (
            <RowButton
              key={rowButton.kind}
              rowButton={{
                ...rowButton,
                isDisabled:
                  rowButton.isDisabled ||
                  (rowButton.action === "approve" &&
                    !request.gender &&
                    !genderSchema.safeParse(missingGender).success),
              }}
              name={name}
              onPress={() =>
                onDecide(
                  checkinRequestId,
                  rowButton.action,
                  !request.gender &&
                    genderSchema.safeParse(missingGender).success
                    ? genderSchema.parse(missingGender)
                    : undefined,
                )
              }
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
  const messages = useMessages();
  return (
    <div className="mt-[3px] flex flex-wrap items-center gap-1.5 text-xs text-muted">
      <SkillChip skillLevel={request.skillLevel} />
      <span>
        {request.gender
          ? messages.genders[request.gender]
          : messages.host.tray.genderMissing}
      </span>
      <span className="tabular-nums">
        {relativeTimeLabel(request.createdAt, nowMs, messages.host.tray)}
      </span>
    </div>
  );
}

function RowAttention({ attention }: { attention: TrayRowAttention }) {
  const text = useMessages().host.tray;
  const [headline, detail] =
    attention === "nameAlreadyInSession"
      ? [text.nameAlreadyIn, text.cantAddTwice]
      : attention === "sessionChanged"
        ? [text.sessionChanged, text.sessionChangedDetail]
        : [
            attention.failedAction === "approve"
              ? text.couldNotApprove
              : text.couldNotReject,
            text.checkConnection,
          ];
  const isFailure = attention !== "nameAlreadyInSession";
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

function DecidedMessage({ outcome }: { outcome: TrayDecidedOutcome }) {
  const text = useMessages().host.tray;
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
      {text[outcome]}
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

function rowButtonWords(
  rowButton: TrayRowButton,
  name: string,
  messages: Messages,
): { label: string; accessibleName: string } {
  const text = messages.host.tray;
  switch (rowButton.kind) {
    case "approve":
      return { label: text.approve, accessibleName: text.approveName(name) };
    case "reject":
      return { label: text.reject, accessibleName: text.rejectName(name) };
    case "retry":
      return {
        label: messages.host.common.retry,
        accessibleName:
          rowButton.action === "approve"
            ? text.retryApproving(name)
            : text.retryRejecting(name),
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
  const messages = useMessages();
  const { label, accessibleName } = rowButtonWords(rowButton, name, messages);
  const isBlue = rowButton.kind !== "reject";
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={rowButton.isDisabled}
      aria-label={rowButton.isBusy ? undefined : accessibleName}
      className={`${isBlue ? SECONDARY_BUTTON_CLASS_NAME : OUTLINE_BUTTON_CLASS_NAME} flex-[1_1_0] gap-2 whitespace-nowrap lg:max-w-[140px] compact:max-w-none`}
    >
      {rowButton.isBusy ? (
        <>
          <Spinner />
          {rowButton.action === "approve"
            ? messages.host.tray.approving
            : messages.host.tray.rejecting}
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
