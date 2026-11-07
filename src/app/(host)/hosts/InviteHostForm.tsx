"use client";

import { useActionState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import {
  inviteHost,
  type InviteHostFormState,
} from "@/server/hosts/hostActions";
import { HOST_DISPLAY_NAME_MAX_LENGTH } from "@/server/hosts/hostRules";

const INITIAL_STATE: InviteHostFormState = { status: "idle" };

export function InviteHostForm() {
  const [formState, formAction, isPending] = useActionState(
    inviteHost,
    INITIAL_STATE,
  );
  const fieldErrors = formState.status === "error" ? formState.fieldErrors : {};
  const submittedValues =
    formState.status === "error" ? formState.submittedValues : undefined;

  return (
    // The key resets the inputs after a successful invite and keeps them after an error.
    <form
      key={formState.status === "success" ? formState.message : "form"}
      action={formAction}
      className="flex flex-col gap-4"
      noValidate
    >
      <p className="text-sm text-muted">
        They sign in on the login page with a code sent to this email.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="invite-email" className={FIELD_LABEL_CLASS_NAME}>
          Email
        </label>
        <input
          id="invite-email"
          name="email"
          type="email"
          autoComplete="off"
          required
          defaultValue={submittedValues?.email}
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={
            fieldErrors.email ? "invite-email-error" : undefined
          }
          className={TEXT_INPUT_CLASS_NAME}
        />
        {fieldErrors.email && (
          <AttentionMessage id="invite-email-error">
            {fieldErrors.email}
          </AttentionMessage>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="invite-display-name" className={FIELD_LABEL_CLASS_NAME}>
          Display name
        </label>
        <input
          id="invite-display-name"
          name="displayName"
          type="text"
          autoComplete="off"
          required
          maxLength={HOST_DISPLAY_NAME_MAX_LENGTH}
          defaultValue={submittedValues?.displayName}
          aria-invalid={fieldErrors.displayName ? true : undefined}
          aria-describedby={
            fieldErrors.displayName ? "invite-display-name-error" : undefined
          }
          className={TEXT_INPUT_CLASS_NAME}
        />
        {fieldErrors.displayName && (
          <AttentionMessage id="invite-display-name-error">
            {fieldErrors.displayName}
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
        className={PRIMARY_BUTTON_CLASS_NAME}
      >
        {isPending ? "Inviting…" : "Invite host"}
      </button>
    </form>
  );
}
