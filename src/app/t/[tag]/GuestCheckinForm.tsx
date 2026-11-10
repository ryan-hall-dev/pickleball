"use client";

import { useRef, useState, type FormEvent, type RefObject } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import type { OpenCheckinPage } from "@/server/checkin/checkinResults";
import {
  validateGuestForm,
  type GuestCheckinInput,
  type GuestFormFieldErrors,
  type GuestFormValues,
} from "@/server/checkin/checkinRules";
import { CheckMarkIcon, ChevronIcon } from "./CheckinIcons";
import {
  BrandLine,
  HOST_APPROVES_NOTE,
  InfoNotice,
  SkillLevelOptions,
} from "./CheckinParts";
import { formatCheckinSessionWhen } from "./checkinHeaderFormatting";
import { BOTTOM_ACTION_BAR_CLASS_NAME } from "./checkinStyles";

const FORM_ID = "checkin-guest-form";
const FIELD_IDS = {
  firstName: "checkin-guest-first-name",
  lastName: "checkin-guest-last-name",
  skillLevel: "checkin-guest-level",
} as const;
const SKILL_LABEL_ID = "checkin-guest-level-label";

function errorIdFor(field: keyof typeof FIELD_IDS): string {
  return `${FIELD_IDS[field]}-error`;
}

/**
 * P05: a first-time player (guest) gives first name, last name and level, all
 * required. Errors appear only after pressing Check in, then follow the edits
 * (orange border, "!" plus words, linked with aria-describedby).
 */
export function GuestCheckinForm({
  page,
  values,
  onValuesChange,
  serverFieldErrors,
  isBusy,
  onBack,
  onCheckIn,
}: {
  page: OpenCheckinPage;
  /** Kept by the page, so a failed submit's Try again returns to them. */
  values: GuestFormValues;
  onValuesChange: (values: GuestFormValues) => void;
  serverFieldErrors: GuestFormFieldErrors;
  isBusy: boolean;
  onBack: () => void;
  onCheckIn: (input: GuestCheckinInput) => void;
}) {
  const [hasPressedCheckIn, setHasPressedCheckIn] = useState(false);
  const firstNameInputRef = useRef<HTMLInputElement>(null);
  const lastNameInputRef = useRef<HTMLInputElement>(null);
  const skillGroupRef = useRef<HTMLDivElement>(null);

  const validation = validateGuestForm(values);
  const browserFieldErrors =
    hasPressedCheckIn && !validation.isValid ? validation.fieldErrors : {};
  const fieldErrors =
    Object.keys(browserFieldErrors).length > 0
      ? browserFieldErrors
      : serverFieldErrors;
  const hasFieldErrors = Object.values(fieldErrors).some(Boolean);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setHasPressedCheckIn(true);
    if (validation.isValid) {
      onCheckIn(validation.input);
      return;
    }
    // Take the player to the first field to fix.
    const { fieldErrors: errors } = validation;
    if (errors.firstName) firstNameInputRef.current?.focus();
    else if (errors.lastName) lastNameInputRef.current?.focus();
    else skillGroupRef.current?.querySelector("button")?.focus();
  }

  return (
    <>
      <BrandLine name={page.socialName} />
      <div className="flex items-center">
        <button
          type="button"
          onClick={onBack}
          disabled={isBusy}
          className="inline-flex min-h-11 items-center gap-1.5 text-[15px] font-semibold text-link hover:text-link-hover"
        >
          <ChevronIcon direction="left" />
          Back to find your name
        </button>
      </div>
      <div>
        <h1 className="text-[26px] leading-[1.15] font-extrabold">
          Check in as a guest
        </h1>
        <p className="mt-1 text-sm text-muted tabular-nums">
          {page.session.name} · {formatCheckinSessionWhen(page.session)}
        </p>
      </div>
      <form
        id={FORM_ID}
        noValidate
        onSubmit={submit}
        aria-label="Check in as a guest"
        className="flex flex-col gap-4 rounded-card border border-card-border bg-card p-[18px]"
      >
        <NameField
          field="firstName"
          label="First name"
          autoComplete="given-name"
          inputRef={firstNameInputRef}
          value={values.firstName}
          error={fieldErrors.firstName}
          isDisabled={isBusy}
          onChange={(firstName) => onValuesChange({ ...values, firstName })}
        />
        <NameField
          field="lastName"
          label="Last name"
          autoComplete="family-name"
          inputRef={lastNameInputRef}
          value={values.lastName}
          error={fieldErrors.lastName}
          isDisabled={isBusy}
          onChange={(lastName) => onValuesChange({ ...values, lastName })}
        />
        <div ref={skillGroupRef} className="flex flex-col gap-1.5">
          <span id={SKILL_LABEL_ID} className={FIELD_LABEL_CLASS_NAME}>
            Your level
          </span>
          <SkillLevelOptions
            id={FIELD_IDS.skillLevel}
            selectedSkillLevel={values.skillLevel}
            onSkillLevelPressed={(skillLevel) =>
              onValuesChange({ ...values, skillLevel })
            }
            labelledById={SKILL_LABEL_ID}
            describedById={
              fieldErrors.skillLevel ? errorIdFor("skillLevel") : undefined
            }
            isInvalid={Boolean(fieldErrors.skillLevel)}
            isDisabled={isBusy}
          />
          {fieldErrors.skillLevel && (
            <div className="mt-1">
              <AttentionMessage id={errorIdFor("skillLevel")}>
                {fieldErrors.skillLevel}
              </AttentionMessage>
            </div>
          )}
        </div>
      </form>
      {!hasFieldErrors && <InfoNotice>{HOST_APPROVES_NOTE}</InfoNotice>}
      <div className={BOTTOM_ACTION_BAR_CLASS_NAME}>
        <button
          type="submit"
          form={FORM_ID}
          disabled={isBusy}
          aria-busy={isBusy}
          className={`${PRIMARY_BUTTON_CLASS_NAME} gap-2.5`}
        >
          <CheckMarkIcon sizePx={20} />
          Check in
        </button>
      </div>
    </>
  );
}

function NameField({
  field,
  label,
  autoComplete,
  inputRef,
  value,
  error,
  isDisabled,
  onChange,
}: {
  field: "firstName" | "lastName";
  label: string;
  autoComplete: string;
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  error: string | undefined;
  isDisabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={FIELD_IDS[field]} className={FIELD_LABEL_CLASS_NAME}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={FIELD_IDS[field]}
        type="text"
        autoComplete={autoComplete}
        autoCapitalize="words"
        value={value}
        disabled={isDisabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorIdFor(field) : undefined}
        className={TEXT_INPUT_CLASS_NAME}
      />
      {error && (
        <AttentionMessage id={errorIdFor(field)}>{error}</AttentionMessage>
      )}
    </div>
  );
}
