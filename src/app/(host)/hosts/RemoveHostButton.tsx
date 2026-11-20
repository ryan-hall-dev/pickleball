"use client";

import { useActionState, useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  ATTENTION_OUTLINE_BUTTON_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import {
  removeHost,
  type RemoveHostFormState,
} from "@/server/hosts/hostActions";
import { useMessages } from "@/i18n/LocaleProvider";
import { translateMessage } from "@/i18n/messages";

const INITIAL_STATE: RemoveHostFormState = { status: "idle" };

/** Two-step remove: "Remove" asks for confirmation before anything happens. */
export function RemoveHostButton({
  hostUserId,
  hostDisplayName,
}: {
  hostUserId: string;
  hostDisplayName: string;
}) {
  const messages = useMessages();
  const text = messages.host.hosts;
  const [isConfirming, setIsConfirming] = useState(false);
  const [formState, formAction, isPending] = useActionState(
    removeHost,
    INITIAL_STATE,
  );

  return (
    <div className="flex basis-full flex-col items-end gap-2 sm:basis-auto">
      {isConfirming ? (
        <form action={formAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="hostUserId" value={hostUserId} />
          <button
            type="button"
            onClick={() => setIsConfirming(false)}
            disabled={isPending}
            className={OUTLINE_BUTTON_CLASS_NAME}
          >
            {messages.host.common.cancel}
          </button>
          <button
            type="submit"
            disabled={isPending}
            className={ATTENTION_OUTLINE_BUTTON_CLASS_NAME}
          >
            {isPending ? text.removing : text.confirmRemove(hostDisplayName)}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setIsConfirming(true)}
          aria-label={text.removeName(hostDisplayName)}
          className={OUTLINE_BUTTON_CLASS_NAME}
        >
          {text.remove}
        </button>
      )}
      <div aria-live="polite">
        {formState.status === "error" && (
          <AttentionMessage>
            {translateMessage(formState.message, messages)}
          </AttentionMessage>
        )}
      </div>
    </div>
  );
}
