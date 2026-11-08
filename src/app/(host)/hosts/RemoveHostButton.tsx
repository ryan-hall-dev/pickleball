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

const INITIAL_STATE: RemoveHostFormState = { status: "idle" };

/** Two-step remove: "Remove" asks for confirmation before anything happens. */
export function RemoveHostButton({
  hostUserId,
  hostDisplayName,
}: {
  hostUserId: string;
  hostDisplayName: string;
}) {
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
            Cancel
          </button>
          <button
            type="submit"
            disabled={isPending}
            className={ATTENTION_OUTLINE_BUTTON_CLASS_NAME}
          >
            {isPending ? "Removing…" : `Confirm remove ${hostDisplayName}`}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setIsConfirming(true)}
          aria-label={`Remove ${hostDisplayName}`}
          className={OUTLINE_BUTTON_CLASS_NAME}
        >
          Remove
        </button>
      )}
      <div aria-live="polite">
        {formState.status === "error" && (
          <AttentionMessage>{formState.message}</AttentionMessage>
        )}
      </div>
    </div>
  );
}
