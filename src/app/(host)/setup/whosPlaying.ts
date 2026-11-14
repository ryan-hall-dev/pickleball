// Pure helpers for the Setup screen's "Who's playing?" card: the draft's
// players (session-only participants: no member directory), optimistic
// attendance changes and the add-player form. No React here, so it's unit
// tested directly.
import type { DraftParticipant } from "@/server/setup/setupDraft";
import {
  draftParticipantInputSchema,
  type DraftParticipantInput,
} from "@/server/setup/setupRules";

/** One attendance write, applied optimistically until the server answers. */
export type AttendanceChange =
  | {
      kind: "addParticipant";
      /** Chosen in the browser, so a retried add can't add the player twice. */
      participantId: string;
      participant: DraftParticipantInput;
    }
  | { kind: "removeParticipant"; participantId: string };

/** A change plus the words that describe it if it fails ("Adding Grace Kim"). */
export interface QueuedAttendanceChange {
  change: AttendanceChange;
  description: string;
}

export interface AttendanceFailure extends QueuedAttendanceChange {
  message: string;
}

/** The attendee list as it will be once `change` lands, so the screen updates at once. */
export function applyAttendanceChange(
  participants: readonly DraftParticipant[],
  change: AttendanceChange,
): DraftParticipant[] {
  switch (change.kind) {
    case "addParticipant":
      return [
        ...participants,
        {
          participantId: change.participantId,
          firstName: change.participant.firstName,
          lastName: change.participant.lastName,
          skillLevel: change.participant.skillLevel,
        },
      ];
    case "removeParticipant":
      return participants.filter(
        (participant) => participant.participantId !== change.participantId,
      );
  }
}

/**
 * The failed changes still worth retrying once `laterChange` is made: a
 * failure about the same player is dropped, so Retry never undoes what the
 * host did since.
 */
export function pruneFailuresTouchedBy(
  failures: readonly AttendanceFailure[],
  laterChange: AttendanceChange,
): AttendanceFailure[] {
  return failures.filter(
    (failure) => failure.change.participantId !== laterChange.participantId,
  );
}

export interface ParticipantForm {
  firstName: string;
  lastName: string;
  /** "" = not chosen yet (a level is required). */
  skillLevel: string;
}

export const EMPTY_PARTICIPANT_FORM: ParticipantForm = {
  firstName: "",
  lastName: "",
  skillLevel: "",
};

export type ParticipantFormErrors = Partial<
  Record<keyof ParticipantForm, string>
>;

export type ParticipantFormValidation =
  | { ok: true; participant: DraftParticipantInput }
  | { ok: false; fieldErrors: ParticipantFormErrors };

/** The add-player form: first name, last name and level, all required. */
export function validateParticipantForm(
  form: ParticipantForm,
): ParticipantFormValidation {
  const parsed = draftParticipantInputSchema.safeParse(form);
  if (parsed.success) return { ok: true, participant: parsed.data };
  const fieldErrors: ParticipantFormErrors = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0]) as keyof ParticipantForm;
    fieldErrors[field] ??= issue.message;
  }
  return { ok: false, fieldErrors };
}
