"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import {
  GENDERS,
  GENDER_LABELS,
  genderSchema,
} from "@/server/participantRules";
import { SKILL_LEVELS, SKILL_LEVEL_LABELS } from "@/server/skillLevels";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import {
  INNER_BOX_TEXT_INPUT_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { AttentionMessage } from "@/components/AttentionMessage";
import { LINK_BUTTON_CLASS_NAME } from "@/components/controlStyles";
import { QuickAddParticipantBox } from "./QuickAddParticipantBox";
import { SetupSection } from "./SetupSection";
import type { DraftAttendance } from "./useDraftAttendance";
import type { ParticipantForm } from "./whosPlaying";

/** The session's approved and host-added players, with add and remove controls. */
export function WhosPlayingCard({
  attendance,
  participantForm,
  onParticipantFormChange,
}: {
  attendance: DraftAttendance;
  participantForm: ParticipantForm;
  onParticipantFormChange: Dispatch<SetStateAction<ParticipantForm>>;
}) {
  const {
    participants,
    pendingChanges,
    failures,
    refreshProblem,
    queueChange,
    retryFailures,
  } = attendance;
  const pendingParticipantIds = new Set(
    pendingChanges.flatMap((queued) =>
      queued.change.kind === "addParticipant"
        ? [queued.change.participantId]
        : [],
    ),
  );

  return (
    <SetupSection
      stepNumber={3}
      headingId="whos-playing-heading"
      heading="Who's playing?"
      actions={
        <span className="rounded-[14px] bg-lime-surface px-3.5 py-2 text-sm text-lime-soft tabular-nums">
          <b className="text-lg">{participants.length}</b>{" "}
          {participants.length === 1 ? "player" : "players"}
        </span>
      }
    >
      <div aria-live="polite" className="mt-3 flex flex-col gap-1 empty:hidden">
        {failures.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3">
            <AttentionMessage>
              {failures.length === 1
                ? `Not saved: ${failures[0].description}. ${failures[0].message}`
                : `${failures.length} changes not saved. ${failures.at(-1)!.message}`}
            </AttentionMessage>
            <button
              type="button"
              onClick={retryFailures}
              className={LINK_BUTTON_CLASS_NAME}
            >
              {failures.length === 1 ? "Retry" : "Retry all"}
            </button>
          </div>
        )}
        {refreshProblem && (
          <AttentionMessage>{refreshProblem}</AttentionMessage>
        )}
        {pendingChanges.length > 0 && (
          <p className="text-sm text-muted">Saving attendance…</p>
        )}
      </div>

      {attendance.completeParticipantDetails &&
        participants
          .filter(
            (participant) => !participant.gender || !participant.skillLevel,
          )
          .map((participant) => (
            <MissingParticipantDetails
              key={participant.participantId}
              participant={participant}
              onSave={attendance.completeParticipantDetails!}
            />
          ))}
      <QuickAddParticipantBox
        form={participantForm}
        onFormChange={onParticipantFormChange}
        participants={participants}
        pendingParticipantIds={pendingParticipantIds}
        onAddParticipant={(participant) =>
          queueChange({
            change: {
              kind: "addParticipant",
              participantId: crypto.randomUUID(),
              participant,
            },
            description: `Adding ${participant.firstName} ${participant.lastName}`,
          })
        }
        onRemoveParticipant={(participant) =>
          queueChange({
            change: {
              kind: "removeParticipant",
              participantId: participant.participantId,
            },
            description: `Removing ${participant.firstName} ${participant.lastName}`,
          })
        }
      />
    </SetupSection>
  );
}

function MissingParticipantDetails({
  participant,
  onSave,
}: {
  participant: DraftParticipant;
  onSave: NonNullable<DraftAttendance["completeParticipantDetails"]>;
}) {
  const [gender, setGender] = useState(participant.gender ?? "");
  const [skillLevel, setSkillLevel] = useState(participant.skillLevel ?? "");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const name = `${participant.firstName} ${participant.lastName}`;
  return (
    <form
      aria-label={`Complete details for ${name}`}
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const parsedGender = genderSchema.safeParse(gender);
        const parsedSkill = SKILL_LEVELS.find((level) => level === skillLevel);
        if (!parsedGender.success || !parsedSkill) {
          setMessage("Choose male or female and a level.");
          return;
        }
        setIsBusy(true);
        try {
          const result = await onSave(
            participant.participantId,
            parsedGender.data,
            parsedSkill,
          );
          if (!result.ok) setMessage(result.message);
        } catch {
          setMessage("Couldn't save details. Check your connection.");
        } finally {
          setIsBusy(false);
        }
      }}
    >
      <p className="text-sm text-orange-soft">
        Complete missing details for {name}
      </p>
      <select
        aria-label={`Gender for ${name}`}
        value={gender}
        disabled={isBusy}
        onChange={(event) => setGender(event.target.value)}
        className={INNER_BOX_TEXT_INPUT_CLASS_NAME}
      >
        <option value="">Choose gender…</option>
        {GENDERS.map((value) => (
          <option key={value} value={value}>
            {GENDER_LABELS[value]}
          </option>
        ))}
      </select>
      <select
        aria-label={`Level for ${name}`}
        value={skillLevel}
        disabled={isBusy}
        onChange={(event) => setSkillLevel(event.target.value)}
        className={INNER_BOX_TEXT_INPUT_CLASS_NAME}
      >
        <option value="">Choose level…</option>
        {SKILL_LEVELS.map((value) => (
          <option key={value} value={value}>
            {SKILL_LEVEL_LABELS[value]}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={isBusy}
        className={SECONDARY_BUTTON_CLASS_NAME}
      >
        {isBusy ? "Saving…" : "Save details"}
      </button>
      {message && <AttentionMessage>{message}</AttentionMessage>}
    </form>
  );
}
