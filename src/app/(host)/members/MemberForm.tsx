"use client";

import Link from "next/link";
import { useActionState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  ATTENTION_OUTLINE_BUTTON_CLASS_NAME,
  FIELD_LABEL_CLASS_NAME,
  LARGE_OUTLINE_BUTTON_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import {
  createMember,
  updateMember,
  type MemberFormFieldErrors,
  type MemberFormState,
  type MemberFormValues,
} from "@/server/members/memberActions";
import {
  CONFIRM_DUPLICATE_NAME_FIELD,
  MEMBER_NAME_MAX_LENGTH,
} from "@/server/members/memberRules";
import {
  SKILL_LEVEL_LABELS,
  SKILL_LEVELS,
  type SkillLevel,
} from "@/server/members/memberSearch";

const INITIAL_STATE: MemberFormState = { status: "idle" };

export interface EditableMember {
  id: string;
  firstName: string;
  lastName: string;
  skillLevel: SkillLevel | null;
}

/** Add a member (no `member`) or edit one. Success redirects to /members. */
export function MemberForm({ member }: { member?: EditableMember }) {
  const [formState, formAction, isPending] = useActionState(
    member ? updateMember : createMember,
    INITIAL_STATE,
  );
  const fieldErrors: MemberFormFieldErrors =
    formState.status === "error" ? formState.fieldErrors : {};
  // React resets the form after an action; these values refill it.
  const formValues: MemberFormValues =
    formState.status === "idle"
      ? {
          firstName: member?.firstName ?? "",
          lastName: member?.lastName ?? "",
          skillLevel: member?.skillLevel ?? "",
        }
      : formState.submittedValues;
  const submitLabel = member ? "Save changes" : "Add member";

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {member && <input type="hidden" name="memberId" value={member.id} />}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <TextField
          id="member-first-name"
          name="firstName"
          label="First name"
          defaultValue={formValues.firstName}
          error={fieldErrors.firstName}
        />
        <TextField
          id="member-last-name"
          name="lastName"
          label="Last name"
          defaultValue={formValues.lastName}
          error={fieldErrors.lastName}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="member-skill" className={FIELD_LABEL_CLASS_NAME}>
            Skill (optional)
          </label>
          <select
            id="member-skill"
            name="skillLevel"
            defaultValue={formValues.skillLevel}
            aria-invalid={fieldErrors.skillLevel ? true : undefined}
            aria-describedby={
              fieldErrors.skillLevel ? "member-skill-error" : undefined
            }
            className={TEXT_INPUT_CLASS_NAME}
          >
            <option value="">Not set</option>
            {SKILL_LEVELS.map((skillLevel) => (
              <option key={skillLevel} value={skillLevel}>
                {SKILL_LEVEL_LABELS[skillLevel]}
              </option>
            ))}
          </select>
          {fieldErrors.skillLevel && (
            <AttentionMessage id="member-skill-error">
              {fieldErrors.skillLevel}
            </AttentionMessage>
          )}
        </div>
      </div>

      <div aria-live="polite">
        {formState.status === "error" && (
          <AttentionMessage>{formState.message}</AttentionMessage>
        )}
        {formState.status === "duplicate_name" && (
          <div className="flex flex-col gap-3 rounded-[14px] border border-orange-edge bg-orange-surface px-3.5 py-2.5">
            <AttentionMessage>{formState.message}</AttentionMessage>
            {/* Confirms this exact name only: change the name and it's checked again. */}
            <button
              type="submit"
              name={CONFIRM_DUPLICATE_NAME_FIELD}
              value={formState.duplicateNameKey}
              disabled={isPending}
              className={`${ATTENTION_OUTLINE_BUTTON_CLASS_NAME} self-start`}
            >
              Save anyway
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className={`${PRIMARY_BUTTON_CLASS_NAME} sm:w-auto sm:min-w-[220px]`}
        >
          {isPending ? "Saving…" : submitLabel}
        </button>
        <Link href="/members" className={LARGE_OUTLINE_BUTTON_CLASS_NAME}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

function TextField({
  id,
  name,
  label,
  defaultValue,
  error,
}: {
  id: string;
  name: keyof MemberFormValues;
  label: string;
  defaultValue: string;
  error: string | undefined;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={FIELD_LABEL_CLASS_NAME}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="text"
        // A host types other people's names: never autofill their own.
        autoComplete="off"
        required
        maxLength={MEMBER_NAME_MAX_LENGTH}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={TEXT_INPUT_CLASS_NAME}
      />
      {error && <AttentionMessage id={errorId}>{error}</AttentionMessage>}
    </div>
  );
}
