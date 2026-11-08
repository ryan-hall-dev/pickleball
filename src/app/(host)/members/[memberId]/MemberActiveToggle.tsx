"use client";

import { useActionState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  ATTENTION_OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import {
  setMemberActive,
  type MemberActiveFormState,
} from "@/server/members/memberActions";

const INITIAL_STATE: MemberActiveFormState = { status: "idle" };

/** Deactivate or reactivate. Reversible and never deletes, so no confirm step. */
export function MemberActiveToggle({
  memberId,
  isActive,
}: {
  memberId: string;
  isActive: boolean;
}) {
  const [formState, formAction, isPending] = useActionState(
    setMemberActive,
    INITIAL_STATE,
  );
  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="memberId" value={memberId} />
      <input
        type="hidden"
        name="isActive"
        value={isActive ? "false" : "true"}
      />
      <button
        type="submit"
        disabled={isPending}
        className={
          isActive
            ? ATTENTION_OUTLINE_BUTTON_CLASS_NAME
            : SECONDARY_BUTTON_CLASS_NAME
        }
      >
        {isPending
          ? "Saving…"
          : isActive
            ? "Deactivate member"
            : "Reactivate member"}
      </button>
      <div aria-live="polite">
        {formState.status === "error" && (
          <AttentionMessage>{formState.message}</AttentionMessage>
        )}
      </div>
    </form>
  );
}
