"use client";

import {
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type Ref,
  type SetStateAction,
} from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  INNER_BOX_TEXT_INPUT_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import { PERSON_NAME_MAX_LENGTH } from "@/server/participantRules";
import { SKILL_LEVEL_LABELS, SKILL_LEVELS } from "@/server/skillLevels";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import type { DraftParticipantInput } from "@/server/setup/setupRules";
import {
  EMPTY_PARTICIPANT_FORM,
  validateParticipantForm,
  type ParticipantForm,
  type ParticipantFormErrors,
} from "./whosPlaying";

/**
 * "Add a player": someone playing this session only (session-only
 * participants), with the draft's players listed below.
 */
export function QuickAddParticipantBox({
  form,
  onFormChange,
  participants,
  pendingParticipantIds,
  onAddParticipant,
  onRemoveParticipant,
}: {
  /** Held by the editor: setup readiness flags an unfinished entry. */
  form: ParticipantForm;
  /** A state setter: field edits use the functional form so none are lost. */
  onFormChange: Dispatch<SetStateAction<ParticipantForm>>;
  participants: DraftParticipant[];
  /** Players still being written (their remove button waits). */
  pendingParticipantIds: ReadonlySet<string>;
  onAddParticipant: (participant: DraftParticipantInput) => void;
  onRemoveParticipant: (participant: DraftParticipant) => void;
}) {
  const [fieldErrors, setFieldErrors] = useState<ParticipantFormErrors>({});
  const firstNameInputRef = useRef<HTMLInputElement>(null);

  function updateField(field: keyof ParticipantForm, value: string) {
    onFormChange((currentForm) => ({ ...currentForm, [field]: value }));
    // An edited field's old error no longer applies.
    setFieldErrors((currentErrors) => ({
      ...currentErrors,
      [field]: undefined,
    }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateParticipantForm(form);
    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      return;
    }
    onAddParticipant(validation.participant);
    onFormChange(EMPTY_PARTICIPANT_FORM);
    setFieldErrors({});
    // Ready for the next player.
    firstNameInputRef.current?.focus();
  }

  return (
    <div className="mt-[18px] rounded-[20px] border border-inner-border bg-inner p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="quick-add-participant-heading" className="text-base font-bold">
          Add a player
        </h3>
        <span className="text-[13px] text-muted">Plays this session only</span>
      </div>
      <form
        onSubmit={submit}
        aria-labelledby="quick-add-participant-heading"
        noValidate
        className="flex flex-wrap items-start gap-2.5"
      >
        <ParticipantNameField
          id="participant-first-name"
          label="First name"
          value={form.firstName}
          error={fieldErrors.firstName}
          inputRef={firstNameInputRef}
          onChange={(value) => updateField("firstName", value)}
        />
        <ParticipantNameField
          id="participant-last-name"
          label="Last name"
          value={form.lastName}
          error={fieldErrors.lastName}
          onChange={(value) => updateField("lastName", value)}
        />
        <div className="flex flex-[1_1_150px] flex-col gap-1.5">
          <label htmlFor="participant-skill" className={FIELD_LABEL_CLASS_NAME}>
            Skill
          </label>
          <select
            id="participant-skill"
            value={form.skillLevel}
            onChange={(event) => updateField("skillLevel", event.target.value)}
            aria-invalid={fieldErrors.skillLevel ? true : undefined}
            aria-describedby={
              fieldErrors.skillLevel ? "participant-skill-error" : undefined
            }
            className={INNER_BOX_TEXT_INPUT_CLASS_NAME}
          >
            <option value="">Choose…</option>
            {SKILL_LEVELS.map((skillLevel) => (
              <option key={skillLevel} value={skillLevel}>
                {SKILL_LEVEL_LABELS[skillLevel]}
              </option>
            ))}
          </select>
          {fieldErrors.skillLevel && (
            <AttentionMessage id="participant-skill-error">
              {fieldErrors.skillLevel}
            </AttentionMessage>
          )}
        </div>
        {/* Lines up with the inputs under their labels. */}
        <button
          type="submit"
          className={`${SECONDARY_BUTTON_CLASS_NAME} mt-[25px]`}
        >
          Add player
        </button>
      </form>
      {participants.length > 0 && (
        <ul aria-label="Players" className="mt-3.5 flex flex-wrap gap-2">
          {participants.map((participant) => (
            <ParticipantChip
              key={participant.participantId}
              participant={participant}
              isPending={pendingParticipantIds.has(participant.participantId)}
              onRemove={() => onRemoveParticipant(participant)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ParticipantNameField({
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
        maxLength={PERSON_NAME_MAX_LENGTH}
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

function ParticipantChip({
  participant,
  isPending,
  onRemove,
}: {
  participant: DraftParticipant;
  isPending: boolean;
  onRemove: () => void;
}) {
  const fullName = `${participant.firstName} ${participant.lastName}`;
  const label = participant.skillLevel
    ? SKILL_LEVEL_LABELS[participant.skillLevel]
    : "No level";
  return (
    <li className="flex max-w-full min-w-0 items-center gap-2 rounded-full border border-blue-edge bg-blue-surface p-1">
      <InitialsAvatar name={fullName} tone="next" size="chip" />
      <span className="min-w-0 truncate text-sm font-semibold">{fullName}</span>
      <span className="shrink-0 text-[11px] font-bold tracking-[0.08em] text-link uppercase">
        {isPending ? "Adding…" : label}
      </span>
      <button
        type="button"
        aria-label={`Remove ${fullName}`}
        disabled={isPending}
        onClick={onRemove}
        // 30px in the design; 44px where the pointer is a finger.
        className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-base text-muted hover:text-text disabled:cursor-not-allowed disabled:text-placeholder pointer-coarse:size-11"
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}
