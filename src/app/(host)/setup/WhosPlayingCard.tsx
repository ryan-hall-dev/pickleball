"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { useMessages } from "@/i18n/LocaleProvider";
import { translateMessage } from "@/i18n/messages";
import { en } from "@/i18n/messages/en";
import { GENDERS, genderSchema } from "@/server/participantRules";
import { SKILL_LEVELS } from "@/server/skillLevels";
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
  const messages = useMessages();
  const text = messages.host.setup.whosPlaying;
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
      heading={text.heading}
      actions={
        <span className="rounded-[14px] bg-lime-surface px-3.5 py-2 text-sm text-lime-soft tabular-nums">
          <b className="text-lg">{participants.length}</b>{" "}
          {participants.length === 1 ? text.player : text.players}
        </span>
      }
    >
      <div aria-live="polite" className="mt-3 flex flex-col gap-1 empty:hidden">
        {failures.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3">
            <AttentionMessage>
              {failures.length === 1
                ? text.notSavedOne(
                    describeChange(failures[0], messages),
                    translateMessage(failures[0].message, messages),
                  )
                : text.notSavedMany(
                    failures.length,
                    translateMessage(failures.at(-1)!.message, messages),
                  )}
            </AttentionMessage>
            <button
              type="button"
              onClick={retryFailures}
              className={LINK_BUTTON_CLASS_NAME}
            >
              {failures.length === 1
                ? messages.host.common.retry
                : text.retryAll}
            </button>
          </div>
        )}
        {refreshProblem && (
          <AttentionMessage>
            {translateMessage(refreshProblem, messages)}
          </AttentionMessage>
        )}
        {pendingChanges.length > 0 && (
          <p className="text-sm text-muted">{text.savingAttendance}</p>
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
            description: en.host.setup.whosPlaying.adding(
              `${participant.firstName} ${participant.lastName}`,
            ),
          })
        }
        onRemoveParticipant={(participant) =>
          queueChange({
            change: {
              kind: "removeParticipant",
              participantId: participant.participantId,
            },
            description: en.host.setup.whosPlaying.removing(
              `${participant.firstName} ${participant.lastName}`,
            ),
          })
        }
      />
    </SetupSection>
  );
}

/** "Adding Grace Kim", in the chosen language (descriptions are kept in English). */
function describeChange(
  failure: { change: { kind: string }; description: string },
  messages: ReturnType<typeof useMessages>,
): string {
  const english = en.host.setup.whosPlaying;
  const text = messages.host.setup.whosPlaying;
  const [prefix, translate] =
    failure.change.kind === "addParticipant"
      ? [english.adding(""), text.adding]
      : [english.removing(""), text.removing];
  return failure.description.startsWith(prefix)
    ? translate(failure.description.slice(prefix.length))
    : failure.description;
}

function MissingParticipantDetails({
  participant,
  onSave,
}: {
  participant: DraftParticipant;
  onSave: NonNullable<DraftAttendance["completeParticipantDetails"]>;
}) {
  const messages = useMessages();
  const text = messages.host.setup.whosPlaying;
  const [gender, setGender] = useState(participant.gender ?? "");
  const [skillLevel, setSkillLevel] = useState(participant.skillLevel ?? "");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const name = `${participant.firstName} ${participant.lastName}`;
  return (
    <form
      aria-label={text.missingDetailsLabel(name)}
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const parsedGender = genderSchema.safeParse(gender);
        const parsedSkill = SKILL_LEVELS.find((level) => level === skillLevel);
        if (!parsedGender.success || !parsedSkill) {
          setMessage(text.chooseGenderAndLevel);
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
          setMessage(text.couldNotSaveDetails);
        } finally {
          setIsBusy(false);
        }
      }}
    >
      <p className="text-sm text-orange-soft">{text.missingDetails(name)}</p>
      <select
        aria-label={text.genderFor(name)}
        value={gender}
        disabled={isBusy}
        onChange={(event) => setGender(event.target.value)}
        className={INNER_BOX_TEXT_INPUT_CLASS_NAME}
      >
        <option value="">{text.chooseGender}</option>
        {GENDERS.map((value) => (
          <option key={value} value={value}>
            {messages.genders[value]}
          </option>
        ))}
      </select>
      <select
        aria-label={text.levelFor(name)}
        value={skillLevel}
        disabled={isBusy}
        onChange={(event) => setSkillLevel(event.target.value)}
        className={INNER_BOX_TEXT_INPUT_CLASS_NAME}
      >
        <option value="">{text.chooseLevel}</option>
        {SKILL_LEVELS.map((value) => (
          <option key={value} value={value}>
            {messages.levels[value]}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={isBusy}
        className={SECONDARY_BUTTON_CLASS_NAME}
      >
        {isBusy ? messages.host.common.saving : text.saveDetails}
      </button>
      {message && (
        <AttentionMessage>
          {translateMessage(message, messages)}
        </AttentionMessage>
      )}
    </form>
  );
}
