"use client";

import { useActionState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import { SHORT_LABEL_MAX_LENGTH } from "@/server/setup/setupRules";
import {
  updateSocialName,
  type UpdateSocialNameFormState,
} from "@/server/socials/socialActions";

const INITIAL_STATE: UpdateSocialNameFormState = { status: "idle" };

/** The social manager renames their social (shown in every host's header). */
export function SocialNameForm({ socialName }: { socialName: string }) {
  const [formState, formAction, isPending] = useActionState(
    updateSocialName,
    INITIAL_STATE,
  );
  const fieldError =
    formState.status === "error" ? formState.fieldError : undefined;

  return (
    // The key re-reads the saved name after a success and keeps the typed
    // value after an error.
    <form
      key={formState.status === "success" ? formState.message : "form"}
      action={formAction}
      className="flex flex-col gap-4"
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="social-name" className={FIELD_LABEL_CLASS_NAME}>
          Name
        </label>
        <input
          id="social-name"
          name="socialName"
          type="text"
          autoComplete="off"
          required
          maxLength={SHORT_LABEL_MAX_LENGTH}
          defaultValue={
            formState.status === "error"
              ? formState.submittedSocialName
              : socialName
          }
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? "social-name-error" : undefined}
          className={TEXT_INPUT_CLASS_NAME}
        />
        {fieldError && (
          <AttentionMessage id="social-name-error">
            {fieldError}
          </AttentionMessage>
        )}
      </div>
      <div aria-live="polite">
        {formState.status === "error" && (
          <AttentionMessage>{formState.message}</AttentionMessage>
        )}
        {formState.status === "success" && (
          <p className="text-sm text-lime-soft">{formState.message}</p>
        )}
      </div>
      <button
        type="submit"
        disabled={isPending}
        className={SECONDARY_BUTTON_CLASS_NAME}
      >
        {isPending ? "Saving…" : "Save name"}
      </button>
    </form>
  );
}
