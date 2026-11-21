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
import { useLocale } from "@/i18n/LocaleProvider";
import { translateMessage } from "@/i18n/messages";
import { formatSessionWhen } from "@/lib/sessionTime";
import { discardSessionDraft } from "@/server/setup/setupActions";
import { en } from "@/i18n/messages/en";

const OFFLINE_MESSAGE = en.serverMessages.offline;

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
  const { locale, messages } = useLocale();
  const text = messages.host.setup.discard;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepDraftButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const explanationId = useId();
  const [isUnderstoodChecked, setIsUnderstoodChecked] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const trimmedDraftName = draftName.trim();
  const title = trimmedDraftName
    ? text.title(trimmedDraftName)
    : text.titleUntitled;
  const understand = trimmedDraftName
    ? text.understand(trimmedDraftName)
    : text.understandUntitled;
  const trimmedHostName = hostName.trim();
  const identityParts = [
    plannedStart && plannedEnd && plannedEnd > plannedStart
      ? formatSessionWhen(plannedStart, plannedEnd, locale)
      : null,
    text.attending(attendingPlayerCount),
    trimmedHostName ? text.hostedBy(trimmedHostName) : null,
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
        {text.button}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={explanationId}
        onCancel={cancelWithEscape}
        onClose={resetAfterClose}
        onClick={closeOnBackdropClick}
        className="m-auto max-h-[calc(100%-32px)] w-[calc(100%-32px)] max-w-[560px] overflow-y-auto rounded-[28px] border border-card-border bg-card p-0 text-text shadow-modal backdrop:bg-bg-backdrop/90 compact:rounded-2xl"
      >
        <div className="flex flex-col gap-4 p-6">
          <div className="flex flex-col gap-1.5">
            <h2
              id={titleId}
              className="text-[26px] font-extrabold break-words compact:text-xl"
            >
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
              {text.warning(socialName)}
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
            {understand}
          </label>
          <div aria-live="polite" className="empty:hidden">
            {errorMessage && (
              <AttentionMessage>
                {translateMessage(errorMessage, messages)}
              </AttentionMessage>
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
              {text.keepDraft}
            </button>
            <button
              type="button"
              onClick={discard}
              disabled={!isUnderstoodChecked || isPending}
              className={`${ATTENTION_OUTLINE_BUTTON_CLASS_NAME} ${DIALOG_BUTTON_LAYOUT_CLASS_NAME}`}
            >
              {isPending ? text.discarding : text.discardForAll}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
