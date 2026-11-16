"use client";

import { useRef, useState, type FormEvent } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import {
  GENDERS,
  GENDER_LABELS,
  PERSON_NAME_MAX_LENGTH,
} from "@/server/participantRules";
import { SKILL_LEVEL_LABELS, SKILL_LEVELS } from "@/server/skillLevels";
import type { DraftParticipantInput } from "@/server/setup/setupRules";
import {
  EMPTY_PARTICIPANT_FORM,
  validateParticipantForm,
  type ParticipantForm,
  type ParticipantFormErrors,
} from "../setup/whosPlaying";

export type AddPlayerOutcome =
  { kind: "added" } | { kind: "failed"; message: string };

/**
 * "Add player" for someone whose phone is missing or flat. The same event id
 * is kept while the form stays open: a second tap or a retry after an
 * uncertain answer settles that one write, never a second player.
 */
export function LiveAddPlayer({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (
    player: DraftParticipantInput,
    eventId: string,
  ) => Promise<AddPlayerOutcome>;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ParticipantForm>(EMPTY_PARTICIPANT_FORM);
  const [fieldErrors, setFieldErrors] = useState<ParticipantFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const eventId = useRef<string | null>(null);
  const inFlight = useRef(false);

  function edit(field: keyof ParticipantForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    // A changed player is a different write: it needs its own event id.
    eventId.current = null;
    setFailure(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const validation = validateParticipantForm(form);
    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    eventId.current ??= crypto.randomUUID();
    const outcome = await onAdd(validation.participant, eventId.current);
    inFlight.current = false;
    setSaving(false);
    if (outcome.kind === "added") {
      eventId.current = null;
      setForm(EMPTY_PARTICIPANT_FORM);
      setOpen(false);
    } else setFailure(outcome.message);
  }

  if (!open)
    return (
      <button
        type="button"
        className={OUTLINE_BUTTON_CLASS_NAME}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Add player
      </button>
    );
  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label="Add player"
      noValidate
      className="w-full rounded-[20px] border border-inner-border bg-inner p-4"
    >
      <h3 className="text-base font-bold">Add player</h3>
      <p className="mt-1 text-[13px] text-muted">
        For someone without a working phone. They join the waiting list when
        this is saved and play this session only.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          id="live-add-first-name"
          label="First name"
          error={fieldErrors.firstName}
        >
          <input
            id="live-add-first-name"
            type="text"
            autoComplete="off"
            maxLength={PERSON_NAME_MAX_LENGTH}
            value={form.firstName}
            onChange={(event) => edit("firstName", event.target.value)}
            className={TEXT_INPUT_CLASS_NAME}
            aria-invalid={fieldErrors.firstName ? true : undefined}
            aria-describedby={
              fieldErrors.firstName ? "live-add-first-name-error" : undefined
            }
          />
        </Field>
        <Field
          id="live-add-last-name"
          label="Last name"
          error={fieldErrors.lastName}
        >
          <input
            id="live-add-last-name"
            type="text"
            autoComplete="off"
            maxLength={PERSON_NAME_MAX_LENGTH}
            value={form.lastName}
            onChange={(event) => edit("lastName", event.target.value)}
            className={TEXT_INPUT_CLASS_NAME}
            aria-invalid={fieldErrors.lastName ? true : undefined}
            aria-describedby={
              fieldErrors.lastName ? "live-add-last-name-error" : undefined
            }
          />
        </Field>
        <Field id="live-add-gender" label="Gender" error={fieldErrors.gender}>
          <select
            id="live-add-gender"
            value={form.gender}
            onChange={(event) => edit("gender", event.target.value)}
            className={TEXT_INPUT_CLASS_NAME}
            aria-invalid={fieldErrors.gender ? true : undefined}
            aria-describedby={
              fieldErrors.gender ? "live-add-gender-error" : undefined
            }
          >
            <option value="">Choose…</option>
            {GENDERS.map((gender) => (
              <option key={gender} value={gender}>
                {GENDER_LABELS[gender]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="live-add-skill" label="Level" error={fieldErrors.skillLevel}>
          <select
            id="live-add-skill"
            value={form.skillLevel}
            onChange={(event) => edit("skillLevel", event.target.value)}
            className={TEXT_INPUT_CLASS_NAME}
            aria-invalid={fieldErrors.skillLevel ? true : undefined}
            aria-describedby={
              fieldErrors.skillLevel ? "live-add-skill-error" : undefined
            }
          >
            <option value="">Choose…</option>
            {SKILL_LEVELS.map((level) => (
              <option key={level} value={level}>
                {SKILL_LEVEL_LABELS[level]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {failure && (
        <div className="mt-3">
          <AttentionMessage>{failure}</AttentionMessage>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="submit"
          className={SECONDARY_BUTTON_CLASS_NAME}
          disabled={disabled || saving}
        >
          {saving
            ? "Saving…"
            : failure
              ? "Retry add player"
              : "Add to waiting list"}
        </button>
        <button
          type="button"
          className={OUTLINE_BUTTON_CLASS_NAME}
          disabled={saving}
          onClick={() => {
            setOpen(false);
            setFailure(null);
            eventId.current = null;
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={FIELD_LABEL_CLASS_NAME}>
        {label}
      </label>
      {children}
      {error && <AttentionMessage id={`${id}-error`}>{error}</AttentionMessage>}
    </div>
  );
}
