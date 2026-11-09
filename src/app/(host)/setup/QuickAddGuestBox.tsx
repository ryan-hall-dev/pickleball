"use client";

import { useRef, useState, type FormEvent, type Ref } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  INNER_BOX_TEXT_INPUT_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import {
  MEMBER_NAME_MAX_LENGTH,
  type MemberInput,
} from "@/server/members/memberRules";
import {
  SKILL_LEVEL_LABELS,
  SKILL_LEVELS,
} from "@/server/members/memberSearch";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import {
  EMPTY_GUEST_FORM,
  validateGuestForm,
  type GuestForm,
  type GuestFormErrors,
} from "./whosPlaying";

/**
 * "Quick add a guest": someone playing this session only. Guests are added
 * to the attendee list, never to the members directory.
 */
export function QuickAddGuestBox({
  guests,
  pendingParticipantIds,
  onAddGuest,
  onRemoveGuest,
}: {
  guests: DraftParticipant[];
  /** Guests still being written (their remove button waits). */
  pendingParticipantIds: ReadonlySet<string>;
  onAddGuest: (guest: MemberInput) => void;
  onRemoveGuest: (guest: DraftParticipant) => void;
}) {
  const [form, setForm] = useState<GuestForm>(EMPTY_GUEST_FORM);
  const [fieldErrors, setFieldErrors] = useState<GuestFormErrors>({});
  const firstNameInputRef = useRef<HTMLInputElement>(null);

  function updateField(field: keyof GuestForm, value: string) {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
    // An edited field's old error no longer applies.
    setFieldErrors((currentErrors) => ({
      ...currentErrors,
      [field]: undefined,
    }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateGuestForm(form);
    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      return;
    }
    onAddGuest(validation.guest);
    setForm(EMPTY_GUEST_FORM);
    setFieldErrors({});
    // Ready for the next guest.
    firstNameInputRef.current?.focus();
  }

  return (
    <div className="mt-[18px] rounded-[20px] border border-inner-border bg-inner p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="quick-add-guest-heading" className="text-base font-bold">
          Quick add a guest
        </h3>
        <span className="text-[13px] text-muted">
          Plays today only; no club membership needed
        </span>
      </div>
      <form
        onSubmit={submit}
        aria-labelledby="quick-add-guest-heading"
        noValidate
        className="flex flex-wrap items-start gap-2.5"
      >
        <GuestNameField
          id="guest-first-name"
          label="First name"
          value={form.firstName}
          error={fieldErrors.firstName}
          inputRef={firstNameInputRef}
          onChange={(value) => updateField("firstName", value)}
        />
        <GuestNameField
          id="guest-last-name"
          label="Last name"
          value={form.lastName}
          error={fieldErrors.lastName}
          onChange={(value) => updateField("lastName", value)}
        />
        <div className="flex flex-[1_1_150px] flex-col gap-1.5">
          <label htmlFor="guest-skill" className={FIELD_LABEL_CLASS_NAME}>
            Skill (optional)
          </label>
          <select
            id="guest-skill"
            value={form.skillLevel}
            onChange={(event) => updateField("skillLevel", event.target.value)}
            aria-invalid={fieldErrors.skillLevel ? true : undefined}
            aria-describedby={
              fieldErrors.skillLevel ? "guest-skill-error" : undefined
            }
            className={INNER_BOX_TEXT_INPUT_CLASS_NAME}
          >
            <option value="">Not set</option>
            {SKILL_LEVELS.map((skillLevel) => (
              <option key={skillLevel} value={skillLevel}>
                {SKILL_LEVEL_LABELS[skillLevel]}
              </option>
            ))}
          </select>
          {fieldErrors.skillLevel && (
            <AttentionMessage id="guest-skill-error">
              {fieldErrors.skillLevel}
            </AttentionMessage>
          )}
        </div>
        {/* Lines up with the inputs under their labels. */}
        <button
          type="submit"
          className={`${SECONDARY_BUTTON_CLASS_NAME} mt-[25px]`}
        >
          Add guest
        </button>
      </form>
      {guests.length > 0 && (
        <ul aria-label="Guests" className="mt-3.5 flex flex-wrap gap-2">
          {guests.map((guest) => (
            <GuestChip
              key={guest.participantId}
              guest={guest}
              isPending={pendingParticipantIds.has(guest.participantId)}
              onRemove={() => onRemoveGuest(guest)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function GuestNameField({
  id,
  label,
  value,
  error,
  inputRef,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-[1_1_160px] flex-col gap-1.5">
      <label htmlFor={id} className={FIELD_LABEL_CLASS_NAME}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        // A host types other people's names: never autofill their own.
        autoComplete="off"
        required
        maxLength={MEMBER_NAME_MAX_LENGTH}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={INNER_BOX_TEXT_INPUT_CLASS_NAME}
      />
      {error && <AttentionMessage id={errorId}>{error}</AttentionMessage>}
    </div>
  );
}

function GuestChip({
  guest,
  isPending,
  onRemove,
}: {
  guest: DraftParticipant;
  isPending: boolean;
  onRemove: () => void;
}) {
  const fullName = `${guest.firstName} ${guest.lastName}`;
  const label = guest.skillLevel
    ? `Guest · ${SKILL_LEVEL_LABELS[guest.skillLevel]}`
    : "Guest";
  return (
    <li className="flex items-center gap-2 rounded-full border border-blue-edge bg-blue-surface p-1">
      <InitialsAvatar name={fullName} tone="next" size="chip" />
      <span className="text-sm font-semibold">{fullName}</span>
      <span className="text-[11px] font-bold tracking-[0.08em] text-link uppercase">
        {isPending ? "Adding…" : label}
      </span>
      <button
        type="button"
        aria-label={`Remove guest ${fullName}`}
        disabled={isPending}
        onClick={onRemove}
        // 30px in the design; 44px where the pointer is a finger.
        className="flex size-[30px] items-center justify-center rounded-full text-base text-muted hover:text-text disabled:cursor-not-allowed disabled:text-placeholder pointer-coarse:size-11"
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}
