"use client";

import { useState, useTransition } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import { SECONDARY_BUTTON_CLASS_NAME } from "@/components/controlStyles";
import { useMessages } from "@/i18n/LocaleProvider";
import { translateMessage } from "@/i18n/messages";
import { en } from "@/i18n/messages/en";
import { startSessionDraft } from "@/server/setup/setupActions";
import { useShowCoHostDraftNotice } from "./CoHostDraftNotice";
import { defaultNewDraftTimes } from "./setupPlanning";

/** Creates the social's draft (or opens a co-host's); the page then re-renders with the editor. */
export function StartSessionDraftButton() {
  const messages = useMessages();
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const showCoHostDraftNotice = useShowCoHostDraftNotice();

  function startNewSession() {
    setErrorMessage(null);
    startTransition(async () => {
      // The browser picks the default times: it knows the host's time zone.
      const result = await startSessionDraft(
        defaultNewDraftTimes(new Date()),
      ).catch(() => ({
        ok: false as const,
        message: en.serverMessages.offline,
      }));
      if (!result.ok) {
        setErrorMessage(result.message);
        return;
      }
      // A co-host's draft opened instead of a new one: say so in the editor.
      showCoHostDraftNotice(result.notice);
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
        {isPending
          ? messages.host.setup.starting
          : messages.host.setup.startNewSession}
      </button>
      <div aria-live="polite">
        {errorMessage && (
          <AttentionMessage>
            {translateMessage(errorMessage, messages)}
          </AttentionMessage>
        )}
      </div>
    </div>
  );
}
