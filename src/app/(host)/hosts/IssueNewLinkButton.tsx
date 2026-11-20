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
  LARGE_OUTLINE_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { reissueCheckinLink } from "@/server/checkin/checkinLinkActions";
import { CheckIcon } from "../setup/CheckIcon";
import { en } from "@/i18n/messages/en";
import { useMessages } from "@/i18n/LocaleProvider";
import { translateMessage } from "@/i18n/messages";

const OFFLINE_MESSAGE = en.serverMessages.offline;
const DIALOG_BUTTON_LAYOUT_CLASS_NAME = "flex-[1_1_200px]";
/** Solid orange confirm (decision #30: DESIGN.md has no destructive style). */
const SOLID_ORANGE_BUTTON_CLASS_NAME =
  "inline-flex h-14 items-center justify-center rounded-2xl bg-orange px-5 text-[17px] font-extrabold text-on-orange disabled:cursor-not-allowed disabled:border disabled:border-inner-border disabled:bg-transparent disabled:text-placeholder";

/**
 * The manager's "Issue new link" and its confirmation (S04b). Focus starts
 * on Cancel. On success the page re-renders with the new link (the action
 * revalidates it) and a short confirmation shows under the button. A
 * refusal shows in the dialog, or under the button if the browser closed
 * the dialog mid-request (Chrome does on a repeated Esc).
 */
export function IssueNewLinkButton({ socialName }: { socialName: string }) {
  const messages = useMessages();
  const text = messages.host.hosts.issueNewLink;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const warningId = useId();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [hasIssuedNewLink, setHasIssuedNewLink] = useState(false);
  const [isPending, startTransition] = useTransition();

  function openDialog() {
    const dialog = dialogRef.current;
    if (!dialog) throw new Error("The issue-new-link dialog isn't mounted.");
    // Each opening starts fresh, whatever the last attempt left behind.
    setHasIssuedNewLink(false);
    setErrorMessage(null);
    if (!dialog.open) dialog.showModal();
    setIsDialogOpen(true);
    // React's autoFocus runs at mount, not when the dialog opens.
    cancelButtonRef.current?.focus();
  }

  /** Cancel, Esc and a backdrop click: nothing closes it mid-request. */
  function closeDialog() {
    if (isPending) return;
    dialogRef.current?.close();
  }

  function cancelWithEscape(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    closeDialog();
  }

  function closeOnBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    // The content fills the dialog, so only the backdrop targets it directly.
    if (event.target === event.currentTarget) closeDialog();
  }

  function issueNewLink() {
    setErrorMessage(null);
    startTransition(async () => {
      const result = await reissueCheckinLink().catch(() => ({
        ok: false as const,
        message: OFFLINE_MESSAGE,
      }));
      if (!result.ok) {
        setErrorMessage(result.message);
        return;
      }
      setHasIssuedNewLink(true);
      dialogRef.current?.close();
    });
  }

  return (
    <div className="flex flex-col items-start gap-2.5">
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={openDialog}
        className={ATTENTION_OUTLINE_BUTTON_CLASS_NAME}
      >
        {text.button}
      </button>
      <div aria-live="polite" className="empty:hidden">
        {!isDialogOpen && errorMessage && (
          <AttentionMessage>
            {translateMessage(errorMessage, messages)}
          </AttentionMessage>
        )}
        {hasIssuedNewLink && (
          <p className="flex items-start gap-1.5 text-[13px] text-lime-soft">
            <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-lime text-on-lime">
              <CheckIcon sizePx={12} />
            </span>
            {text.issued}
          </p>
        )}
      </div>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={warningId}
        onCancel={cancelWithEscape}
        onClose={() => setIsDialogOpen(false)}
        onClick={closeOnBackdropClick}
        className="m-auto max-h-[calc(100%-32px)] w-[calc(100%-32px)] max-w-[600px] overflow-y-auto rounded-[28px] border border-inner-border bg-card p-0 text-text shadow-[0_24px_64px_rgba(0,0,0,0.5)] backdrop:bg-bg-backdrop/80 compact:rounded-2xl"
      >
        <div className="flex flex-col gap-[18px] p-5 sm:p-7">
          <div>
            <h2
              id={titleId}
              className="text-[26px] font-extrabold compact:text-xl"
            >
              {text.title}
            </h2>
            <p className="mt-1 text-sm break-words text-muted">{socialName}</p>
          </div>
          <div className="flex items-start gap-2.5 rounded-[14px] border border-orange-edge bg-orange-surface px-3.5 py-2.5 text-sm text-orange-text">
            <span
              aria-hidden="true"
              className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-orange text-xs font-extrabold text-on-orange"
            >
              !
            </span>
            <p id={warningId}>{text.warning}</p>
          </div>
          <p className="text-text-soft">{text.afterwards}</p>
          <div aria-live="polite" className="empty:hidden">
            {isDialogOpen && errorMessage && (
              <AttentionMessage>
                {translateMessage(errorMessage, messages)}
              </AttentionMessage>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2.5">
            <button
              ref={cancelButtonRef}
              type="button"
              onClick={closeDialog}
              disabled={isPending}
              className={`${LARGE_OUTLINE_BUTTON_CLASS_NAME} ${DIALOG_BUTTON_LAYOUT_CLASS_NAME}`}
            >
              {messages.host.common.cancel}
            </button>
            <button
              type="button"
              onClick={issueNewLink}
              disabled={isPending}
              className={`${SOLID_ORANGE_BUTTON_CLASS_NAME} ${DIALOG_BUTTON_LAYOUT_CLASS_NAME}`}
            >
              {isPending ? text.issuing : text.button}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
