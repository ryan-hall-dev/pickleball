"use client";

import { useState, useTransition } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  ATTENTION_OUTLINE_BUTTON_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { discardSessionDraft } from "@/server/setup/setupActions";

/**
 * Discards the draft after a confirm step (it can't be brought back). On
 * success the page re-renders without a draft.
 */
export function DiscardDraftButton({
  sessionId,
  onAutosavePausedChange,
}: {
  sessionId: string;
  /** Autosave pauses while discarding so a late save doesn't race it. */
  onAutosavePausedChange: (isPaused: boolean) => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function discard() {
    setErrorMessage(null);
    onAutosavePausedChange(true);
    startTransition(async () => {
      const result = await discardSessionDraft(sessionId);
      if (!result.ok) {
        setErrorMessage(result.message);
        onAutosavePausedChange(false);
      }
    });
  }

  if (!isConfirming) {
    return (
      <button
        type="button"
        onClick={() => setIsConfirming(true)}
        className={OUTLINE_BUTTON_CLASS_NAME}
      >
        Discard draft
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-label="Confirm discarding the draft"
      className="flex flex-wrap items-center gap-2"
    >
      <span className="text-sm text-orange-text">
        Discard this draft? This can&apos;t be undone.
      </span>
      <button
        type="button"
        onClick={discard}
        disabled={isPending}
        className={ATTENTION_OUTLINE_BUTTON_CLASS_NAME}
      >
        {isPending ? "Discarding…" : "Yes, discard"}
      </button>
      <button
        type="button"
        onClick={() => setIsConfirming(false)}
        disabled={isPending}
        className={OUTLINE_BUTTON_CLASS_NAME}
      >
        Keep it
      </button>
      <div aria-live="polite" className="basis-full empty:hidden">
        {errorMessage && <AttentionMessage>{errorMessage}</AttentionMessage>}
      </div>
    </div>
  );
}
