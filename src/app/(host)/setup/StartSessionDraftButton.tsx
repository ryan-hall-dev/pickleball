"use client";

import { useState, useTransition } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import { SECONDARY_BUTTON_CLASS_NAME } from "@/components/controlStyles";
import { startSessionDraft } from "@/server/setup/setupActions";
import { defaultNewDraftTimes } from "./setupPlanning";

/** Creates the host's draft; the page then re-renders with the editor. */
export function StartSessionDraftButton() {
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function startNewSession() {
    setErrorMessage(null);
    startTransition(async () => {
      // The browser picks the default times: it knows the host's time zone.
      const result = await startSessionDraft(defaultNewDraftTimes(new Date()));
      if (!result.ok) setErrorMessage(result.message);
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={startNewSession}
        disabled={isPending}
        className={SECONDARY_BUTTON_CLASS_NAME}
      >
        {isPending ? "Starting…" : "Start a new session"}
      </button>
      <div aria-live="polite">
        {errorMessage && <AttentionMessage>{errorMessage}</AttentionMessage>}
      </div>
    </div>
  );
}
