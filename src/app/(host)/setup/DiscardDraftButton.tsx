"use client";

import {
  useId,
  useRef,
  useState,
  useTransition,
  type MouseEvent,
  type SyntheticEvent,
} from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  ATTENTION_OUTLINE_BUTTON_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { formatSessionWhen } from "@/lib/sessionTime";
import { discardSessionDraft } from "@/server/setup/setupActions";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection.";

const DIALOG_BUTTON_LAYOUT_CLASS_NAME = "flex-[1_1_200px]";

/**
 * Discards the social's shared draft (it can't be brought back), after a
 * modal that names the draft, says it is gone for every co-host, and needs
 * a ticked "I understand" before the final button works. Any host of the
 * social may discard it. On success the page re-renders without a draft.
 */
export function DiscardDraftButton({
  sessionId,
  draftName,
  plannedStart,
  plannedEnd,
  attendingPlayerCount,
  hostName,
  socialName,
  onAutosavePausedChange,
}: {
  sessionId: string;
  /** The name as currently on screen (may be blank while editing). */
  draftName: string;
  /** Null while the times on screen are invalid. */
  plannedStart: Date | null;
  plannedEnd: Date | null;
  attendingPlayerCount: number;
  /** The session's "Host" field as currently on screen. */
  hostName: string;
  socialName: string;
  /**
   * Autosave pauses only once the host confirms, so a late save doesn't race
   * the discard; opening or cancelling the dialog leaves it running.
   */
  onAutosavePausedChange: (isPaused: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepDraftButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const explanationId = useId();
  const [isUnderstoodChecked, setIsUnderstoodChecked] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const trimmedDraftName = draftName.trim();
  const title = trimmedDraftName
    ? `Discard “${trimmedDraftName}”?`
    : "Discard this untitled draft?";
  const draftReference = trimmedDraftName
    ? `“${trimmedDraftName}”`
    : "the untitled draft";
  const trimmedHostName = hostName.trim();
  const identityParts = [
    plannedStart && plannedEnd && plannedEnd > plannedStart
      ? formatSessionWhen(plannedStart, plannedEnd)
      : null,
    `${attendingPlayerCount} attending`,
    trimmedHostName ? `Hosted by ${trimmedHostName}` : null,
  ].filter(Boolean);

  function openDialog() {
    showDialog();
    // React's autoFocus runs at mount, not when the dialog opens.
    keepDraftButtonRef.current?.focus();
  }

  function showDialog() {
    const dialog = dialogRef.current;
    if (!dialog) throw new Error("The discard dialog isn't mounted.");
    if (!dialog.open) dialog.showModal();
  }

  /** Keep draft, Esc and a backdrop click: nothing is sent while discarding. */
  function closeDialog() {
    if (isPending) return;
    dialogRef.current?.close();
  }

  /** Every way the dialog closes starts the next opening fresh. */
  function resetAfterClose() {
    setIsUnderstoodChecked(false);
    setErrorMessage(null);
  }

  function cancelWithEscape(event: SyntheticEvent<HTMLDialogElement>) {
    // Closed through closeDialog so Esc can't close it mid-discard.
    event.preventDefault();
    closeDialog();
  }

  function closeOnBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    // The content fills the dialog, so only the backdrop targets it directly.
    if (event.target === event.currentTarget) closeDialog();
  }

  function discard() {
    setErrorMessage(null);
    onAutosavePausedChange(true);
    startTransition(async () => {
      const result = await discardSessionDraft(sessionId).catch(() => ({
        ok: false as const,
        message: OFFLINE_MESSAGE,
      }));
      if (!result.ok) {
        // A browser may force-close after repeated Esc: show the error anyway.
        showDialog();
        setErrorMessage(result.message);
        onAutosavePausedChange(false);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={openDialog}
        className={OUTLINE_BUTTON_CLASS_NAME}
      >
        Discard draft
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={explanationId}
        onCancel={cancelWithEscape}
        onClose={resetAfterClose}
        onClick={closeOnBackdropClick}
        className="m-auto max-h-[calc(100%-32px)] w-[calc(100%-32px)] max-w-[560px] overflow-y-auto rounded-[28px] border border-card-border bg-card p-0 text-text shadow-[0_24px_64px_rgba(0,0,0,0.5)] backdrop:bg-bg-backdrop/90"
      >
        <div className="flex flex-col gap-4 p-6">
          <div className="flex flex-col gap-1.5">
            <h2 id={titleId} className="text-[26px] font-extrabold break-words">
              {title}
            </h2>
            <p className="text-sm text-muted tabular-nums">
              {identityParts.join(" · ")}
            </p>
          </div>
          <div className="flex items-start gap-2.5 rounded-[14px] border border-orange-edge bg-orange-surface px-3.5 py-2.5 text-orange-text">
            <span
              aria-hidden="true"
              className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-orange text-xs font-extrabold text-on-orange"
            >
              !
            </span>
            <p id={explanationId} className="text-[15px]">
              This discards the draft for every host of {socialName}, including
              anyone editing it right now. Its details, courts, attendees and
              rotation settings will be lost and can&apos;t be brought back.
              Saved setups aren&apos;t affected.
            </p>
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px] font-semibold">
            <input
              type="checkbox"
              checked={isUnderstoodChecked}
              disabled={isPending}
              onChange={(event) => setIsUnderstoodChecked(event.target.checked)}
              className="size-5 shrink-0 accent-lime"
            />
            I understand this discards {draftReference} for all hosts
          </label>
          <div aria-live="polite" className="empty:hidden">
            {errorMessage && (
              <AttentionMessage>{errorMessage}</AttentionMessage>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-3">
            <button
              ref={keepDraftButtonRef}
              type="button"
              onClick={closeDialog}
              disabled={isPending}
              className={`${OUTLINE_BUTTON_CLASS_NAME} ${DIALOG_BUTTON_LAYOUT_CLASS_NAME}`}
            >
              Keep draft
            </button>
            <button
              type="button"
              onClick={discard}
              disabled={!isUnderstoodChecked || isPending}
              className={`${ATTENTION_OUTLINE_BUTTON_CLASS_NAME} ${DIALOG_BUTTON_LAYOUT_CLASS_NAME}`}
            >
              {isPending ? "Discarding…" : "Discard for all hosts"}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
