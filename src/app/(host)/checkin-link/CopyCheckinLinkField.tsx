"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import { CheckIcon } from "../setup/CheckIcon";
import { CopyIcon } from "./CheckinLinkIcons";
import { useMessages } from "@/i18n/LocaleProvider";

/** How long "Copied" stays after pressing Copy link (S01: "a few seconds"). */
export const COPIED_CONFIRMATION_VISIBLE_MS = 3_000;

type CopyOutcome =
  | { kind: "idle" }
  /** A new object each press, so pressing again restarts the timer. */
  | { kind: "copied" }
  /** No clipboard access: the link is selected for the host to copy. */
  | { kind: "selected" };

/** The read-only check-in link with Copy link and its confirmation (S01). */
export function CopyCheckinLinkField({ link }: { link: string }) {
  const text = useMessages().host.stickerAndQr;
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copyOutcome, setCopyOutcome] = useState<CopyOutcome>({
    kind: "idle",
  });

  useEffect(() => {
    if (copyOutcome.kind !== "copied") return;
    const timeout = setTimeout(
      () => setCopyOutcome({ kind: "idle" }),
      COPIED_CONFIRMATION_VISIBLE_MS,
    );
    return () => clearTimeout(timeout);
  }, [copyOutcome]);

  async function copyLink() {
    try {
      // Missing outside secure contexts (plain http on a LAN address).
      if (!navigator.clipboard) throw new Error("No clipboard access.");
      await navigator.clipboard.writeText(link);
      setCopyOutcome({ kind: "copied" });
    } catch {
      // Not an error to report: the selected text is the fallback.
      inputRef.current?.select();
      setCopyOutcome({ kind: "selected" });
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className={FIELD_LABEL_CLASS_NAME}>
        {text.link}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
          className={`${TEXT_INPUT_CLASS_NAME} min-w-0 flex-[1_1_280px] font-semibold`}
        />
        <button
          type="button"
          onClick={copyLink}
          className={`${OUTLINE_BUTTON_CLASS_NAME} gap-2 self-center whitespace-nowrap`}
        >
          <CopyIcon />
          {text.copyLink}
        </button>
      </div>
      <div aria-live="polite" className="empty:hidden">
        {copyOutcome.kind === "copied" && (
          <p className="flex items-center gap-1.5 text-[13px] text-lime-soft">
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-lime text-on-lime">
              <CheckIcon sizePx={12} />
            </span>
            {text.copied}
          </p>
        )}
        {copyOutcome.kind === "selected" && (
          <AttentionMessage>{text.copyFailed}</AttentionMessage>
        )}
      </div>
    </div>
  );
}
