"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  CARD_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { courtName } from "@/i18n/courtName";
import { useMessages } from "@/i18n/LocaleProvider";
import { translateMessage } from "@/i18n/messages";
import { en } from "@/i18n/messages/en";
import { settleWithin } from "@/lib/settleWithin";
import { approveCheckin } from "@/server/checkin/hostCheckinActions";
import type { HostCheckinDecisionResult } from "@/server/checkin/hostCheckinResults";
import { addLivePlayer } from "@/server/live/liveAddPlayer";
import { readLiveSession, writeLiveAction } from "@/server/live/liveActions";
import type {
  LiveCommand,
  LiveSessionView,
  LiveWriteInput,
  LiveWriteResult,
  ReadLiveResult,
} from "@/server/live/liveTypes";
import type { Gender } from "@/server/participantRules";
import type { DraftParticipantInput } from "@/server/setup/setupRules";
import { PendingCheckinTray } from "../setup/PendingCheckinTray";
import { LiveAddPlayer, type AddPlayerOutcome } from "./LiveAddPlayer";
import { failureText, type ShownFailure } from "./liveFailure";
import { TimeUpNotice } from "./TimeUpNotice";
import { LiveCourtCard } from "./LiveCourtCard";
import { LiveWaiting } from "./LiveWaiting";

const TIMEOUT_MS = 15_000;
// English like every server message; shown through translateMessage.
const READ_FAILURE: ReadLiveResult = {
  ok: false,
  message: en.serverMessages.live.couldNotRefresh,
};
const WRITE_FAILURE: LiveWriteResult = {
  ok: false,
  message: en.serverMessages.live.couldNotConfirm,
  outcome: "unknown",
};

export function LiveSession({
  initialResult,
}: {
  initialResult: ReadLiveResult;
}) {
  const messages = useMessages();
  const text = messages.host.live;
  const [result, setResult] = useState(initialResult);
  const [message, setMessage] = useState<ShownFailure | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [failedWrite, setFailedWrite] = useState<LiveWriteInput | null>(null);
  const [prepareCourtId, setPrepareCourtId] = useState<string>();
  // The wall-clock moment the latest server answer arrived, and "now" on this
  // device. The session clock is server time plus real elapsed time, so a tab
  // that was throttled in the background is right the instant it wakes up.
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [wallNow, setWallNow] = useState<number | null>(null);
  const [endConfirmation, setEndConfirmation] = useState(false);
  const endDialog = useRef<HTMLDialogElement>(null);
  const latestSession = useRef<LiveSessionView | null>(
    initialResult.ok && initialResult.status === "session"
      ? initialResult.session
      : null,
  );
  const prepareRef = useRef(prepareCourtId);
  const readNumber = useRef(0);
  const pendingReads = useRef(0);
  const working = useRef(false);
  const checkinEvents = useRef(new Map<string, string>());
  const refresh = useCallback(async (isStopped?: () => boolean) => {
    const number = ++readNumber.current;
    const session = latestSession.current;
    pendingReads.current += 1;
    const readCall = readLiveSession({
      ...(session ? { sessionId: session.sessionId } : {}),
      prepareCourtId: prepareRef.current,
    });
    // Hold the polling guard until the actual call settles, even while hidden
    // or after its display timeout: queued actions must not accumulate.
    void readCall.then(
      () => {
        pendingReads.current -= 1;
      },
      () => {
        pendingReads.current -= 1;
      },
    );
    const response = await settleWithin(readCall, TIMEOUT_MS, READ_FAILURE);
    if (isStopped?.() || number !== readNumber.current) return;
    if (!response.ok) {
      setMessage({ message: response.message });
      return;
    }
    if (response.status === "session") {
      if (
        latestSession.current &&
        response.session.lastSeq < latestSession.current.lastSeq
      )
        return;
      latestSession.current = response.session;
    }
    setResult(response);
    setReceivedAt(Date.now());
    setWallNow(Date.now());
  }, []);
  useEffect(() => {
    let stopped = false;
    prepareRef.current = prepareCourtId;
    void refresh(() => stopped);
    return () => {
      stopped = true;
    };
  }, [prepareCourtId, refresh]);
  useEffect(() => {
    let stopped = false;
    const poll = () => {
      if (document.hidden || pendingReads.current > 0) return;
      void refresh(() => stopped);
    };
    const interval = setInterval(poll, 5_000);
    const timer = setInterval(() => setWallNow(Date.now()), 1000);
    const wake = () => {
      if (!document.hidden) setWallNow(Date.now());
    };
    document.addEventListener("visibilitychange", wake);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      clearInterval(interval);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);
  // Another host may end the session while this confirmation is open.
  const endedElsewhere =
    result.ok &&
    result.status === "session" &&
    result.session.phase === "ended";
  const confirmationOpen = endConfirmation && !endedElsewhere;
  useEffect(() => {
    const dialog = endDialog.current;
    if (confirmationOpen && dialog && !dialog.open) dialog.showModal();
    if (!confirmationOpen && dialog?.open) dialog.close();
  }, [confirmationOpen]);

  const submit = useCallback(
    async (input: LiveWriteInput) => {
      if (working.current) return;
      working.current = true;
      setIsWorking(true);
      setMessage(null);
      const response = await settleWithin(
        writeLiveAction(input),
        TIMEOUT_MS,
        WRITE_FAILURE,
      );
      if (response.ok) {
        setFailedWrite(null);
        if (latestSession.current)
          latestSession.current = {
            ...latestSession.current,
            lastSeq: Math.max(latestSession.current.lastSeq, response.seq),
          };
      } else {
        setMessage(response);
        // Only an unknown outcome keeps the same event id for a retry. A
        // rejection or a conflict is settled: the refresh below shows the real
        // state and the host carries on.
        setFailedWrite(response.outcome === "unknown" ? input : null);
      }
      await refresh();
      working.current = false;
      setIsWorking(false);
    },
    [refresh],
  );
  const act = useCallback(
    (command: LiveCommand) => {
      const session = latestSession.current;
      if (!session || working.current || failedWrite) return;
      void submit({
        sessionId: session.sessionId,
        eventId: crypto.randomUUID(),
        expectedLastSeq: session.lastSeq,
        command,
      });
    },
    [submit, failedWrite],
  );
  const approve = useCallback(
    async (requestId: string, gender?: Gender) => {
      const session = latestSession.current;
      if (!session) return { kind: "failed" as const };
      // One event id per request for as long as it is on this screen: a retry
      // after an uncertain answer (failed, timed out) must settle the same
      // event, and a refused one (session_changed) never wrote it, so reusing
      // it is safe too.
      const eventId =
        checkinEvents.current.get(requestId) ?? crypto.randomUUID();
      checkinEvents.current.set(requestId, eventId);
      let decision: HostCheckinDecisionResult;
      try {
        decision = await approveCheckin(requestId, gender, {
          eventId,
          expectedLastSeq: session.lastSeq,
        });
      } catch {
        // A lost response is uncertain, never a success.
        decision = { kind: "failed" };
      }
      // Whatever the answer, show the real state: after a conflict this is
      // what gives the next Approve the current sequence.
      await refresh();
      return decision;
    },
    [refresh],
  );

  const addPlayer = useCallback(
    async (
      player: DraftParticipantInput,
      eventId: string,
    ): Promise<AddPlayerOutcome> => {
      const current = latestSession.current;
      if (!current || working.current)
        return {
          kind: "failed",
          failure: { message: en.serverMessages.live.waitForSave },
          uncertain: false,
        };
      working.current = true;
      setIsWorking(true);
      setMessage(null);
      const response = await settleWithin(
        addLivePlayer({
          ...player,
          sessionId: current.sessionId,
          eventId,
          expectedLastSeq: current.lastSeq,
        }),
        TIMEOUT_MS,
        WRITE_FAILURE,
      ).catch(() => WRITE_FAILURE);
      // Show the real state whatever the answer: after a conflict this is what
      // gives the next try the current sequence.
      await refresh();
      working.current = false;
      setIsWorking(false);
      return response.ok
        ? { kind: "added" }
        : {
            kind: "failed",
            failure: response,
            uncertain: response.outcome === "unknown",
          };
    },
    [refresh],
  );

  const session =
    result.ok && result.status === "session" ? result.session : null;
  if (!session)
    return (
      <section className={CARD_CLASS_NAME}>
        <h1 className="text-[32px] font-extrabold">{text.title}</h1>
        <p className="mt-3 text-muted">
          {!result.ok
            ? translateMessage(result.message, messages)
            : result.status === "draft"
              ? text.notStarted
              : result.status === "legacy"
                ? text.legacy
                : text.noSession}
        </p>
        <Link className={`${OUTLINE_BUTTON_CLASS_NAME} mt-4`} href="/setup">
          {text.goToSetup}
        </Link>
      </section>
    );
  const now =
    receivedAt !== null && wallNow !== null
      ? session.now + Math.max(0, wallNow - receivedAt)
      : session.now;
  const timeIsUp = session.timeIsUp || now >= session.deadline;
  const ended = session.phase === "ended";
  const activeGames = session.courts.filter(
    (court) => court.activeMatch,
  ).length;
  const disabled = isWorking || !!failedWrite || ended;
  return (
    <>
      <section
        className={`${CARD_CLASS_NAME} flex flex-wrap items-center justify-between gap-4`}
      >
        <div className="min-w-0">
          <p className="text-xs font-bold tracking-widest text-lime uppercase">
            {ended
              ? text.sessionEnded
              : timeIsUp
                ? text.sessionTimeIsUp
                : text.liveSession}
          </p>
          <h1 className="mt-1 text-[32px] font-extrabold break-words">
            {session.name}
          </h1>
          <p className="mt-1 text-muted tabular-nums">
            {ended
              ? text.thanks
              : timeIsUp
                ? text.finishThenEnd
                : text.minutesRemaining(
                    Math.max(0, Math.ceil((session.deadline - now) / 60_000)),
                  )}
          </p>
        </div>
        {ended ? (
          <Link href="/setup" className={SECONDARY_BUTTON_CLASS_NAME}>
            {text.setUpNew}
          </Link>
        ) : (
          <div>
            <button
              type="button"
              disabled={disabled || activeGames > 0}
              aria-describedby={
                activeGames > 0 ? "end-session-disabled-reason" : undefined
              }
              className={OUTLINE_BUTTON_CLASS_NAME}
              onClick={() => setEndConfirmation(true)}
            >
              {text.endSession}
            </button>
            {activeGames > 0 && (
              <p
                id="end-session-disabled-reason"
                className="mt-2 text-sm text-muted"
              >
                {text.finishBeforeEnd}
              </p>
            )}
          </div>
        )}
      </section>
      {timeIsUp && !ended && (
        <TimeUpNotice
          activeCourtNames={session.courts
            .filter((court) => court.activeMatch)
            .map((court) => courtName(court.name, messages))}
          disabled={disabled}
          onEnd={() => setEndConfirmation(true)}
        />
      )}
      {message && (
        <AttentionMessage>{failureText(message, messages)}</AttentionMessage>
      )}
      {failedWrite && (
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS_NAME}
          disabled={isWorking}
          onClick={() => void submit(failedWrite)}
        >
          {text.retryLastAction}
        </button>
      )}
      <p role="status" className="text-sm text-muted">
        {isWorking ? messages.host.common.saving : text.updatesEvery}
      </p>
      {!ended && (
        <>
          <nav aria-label={text.sectionsLabel} className="flex flex-wrap gap-2">
            <a className={OUTLINE_BUTTON_CLASS_NAME} href="#checkins">
              {text.checkins}
            </a>
            <a className={OUTLINE_BUTTON_CLASS_NAME} href="#waiting">
              {text.waiting}
            </a>
            <a className={OUTLINE_BUTTON_CLASS_NAME} href="#courts">
              {text.courts}
            </a>
          </nav>
          {/* Hosts approve arrivals and show the QR code most in the first
              hour, so check-ins come first, then waiting players, then courts. */}
          <div id="checkins" className="flex flex-col gap-3">
            <LiveAddPlayer disabled={disabled} onAdd={addPlayer} />
            <PendingCheckinTray
              approveDecision={approve}
              onParticipantApproved={() => void refresh()}
              onAttendanceChangedElsewhere={() => void refresh()}
            />
          </div>
          <LiveWaiting
            players={session.players}
            now={now}
            disabled={disabled}
            onAction={act}
          />
          <section id="courts" aria-labelledby="courts-heading">
            <h2 id="courts-heading" className="mb-3 text-xl font-bold">
              {text.courtsAndUpNext}
            </h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {session.courts.map((court) => (
                <LiveCourtCard
                  key={court.courtId}
                  court={court}
                  players={session.players}
                  now={now}
                  timeIsUp={timeIsUp}
                  disabled={disabled}
                  selected={prepareCourtId === court.courtId}
                  onPrepare={() => {
                    if (prepareCourtId === court.courtId) void refresh();
                    else setPrepareCourtId(court.courtId);
                  }}
                  onAction={act}
                  undoOptions={session.undoOptions.filter(
                    (option) => option.courtId === court.courtId,
                  )}
                />
              ))}
            </div>
          </section>
        </>
      )}
      <dialog
        ref={endDialog}
        onCancel={() => setEndConfirmation(false)}
        onClose={() => setEndConfirmation(false)}
        className="m-auto w-[440px] max-w-[calc(100%-32px)] rounded-[28px] border border-card-border bg-card p-6 text-text backdrop:bg-bg-backdrop/90"
        aria-labelledby="end-session-title"
      >
        <h2 id="end-session-title" className="text-[26px] font-extrabold">
          {text.endDialog.title}
        </h2>
        <p className="mt-3 text-muted">{text.endDialog.text}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            className={OUTLINE_BUTTON_CLASS_NAME}
            onClick={() => setEndConfirmation(false)}
          >
            {text.endDialog.keepOpen}
          </button>
          <button
            type="button"
            className={`${PRIMARY_BUTTON_CLASS_NAME} flex-1`}
            onClick={() => {
              setEndConfirmation(false);
              act({ kind: "end" });
            }}
          >
            {text.endSession}
          </button>
        </div>
      </dialog>
    </>
  );
}
