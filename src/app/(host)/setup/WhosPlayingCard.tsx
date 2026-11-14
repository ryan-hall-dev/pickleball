"use client";

import type { Dispatch, SetStateAction } from "react";
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
