// Setup readiness: ONE pure function behind the stepper, the summary
// checklist and whether START is enabled, so they can never disagree.
// No React here.
import { PLAYERS_PER_MATCH, type CourtFormat } from "@/engine";
import type { SetupFormErrors, SetupFormField } from "./setupPlanning";
import type { ParticipantForm } from "./whosPlaying";

/**
 * done: nothing left to do. attention: something to fix (orange, "N to fix").
 * notStarted: nothing entered yet. ready: Review & start once all else is done.
 */
export type SetupStepState = "done" | "attention" | "notStarted" | "ready";

export type SetupStepKey =
  "details" | "courts" | "players" | "rotation" | "review";

export interface SetupStep {
  key: SetupStepKey;
  label: string;
  state: SetupStepState;
  /** Things to fix (shown as "N to fix" when the state is attention). */
  issueCount: number;
}

export interface ChecklistItem {
  isDone: boolean;
  text: string;
}

export interface SetupReadiness {
  steps: SetupStep[];
  checklist: ChecklistItem[];
  /** Every step is done (Review & start shows "ready"). */
  isSetupComplete: boolean;
  /** Complete AND saved: what's started is what the host sees. */
  isReadyToStart: boolean;
}

export interface SetupReadinessInput {
  fieldErrors: SetupFormErrors;
  selectedCourtCount: number;
  matchFormat: CourtFormat;
  attendingPlayerCount: number;
  /** The quick-add participant form as typed (not yet added). */
  participantForm: ParticipantForm;
  /** The draft autosave has nothing pending or failed. */
  isDraftSaved: boolean;
}

/** Fields on the Session details card. */
const DETAILS_FIELDS: readonly SetupFormField[] = [
  "name",
  "date",
  "startTime",
  "endTime",
  "location",
  "hostName",
  "targetMatchMinutes",
  "changeoverMinutes",
];

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function isParticipantFormUnfinished(
  participantForm: ParticipantForm,
): boolean {
  return Object.values(participantForm).some((value) => value.trim() !== "");
}

/** "Participant form has an unfinished entry: add Kai's last name or clear it". */
export function unfinishedParticipantFormMessage(
  participantForm: ParticipantForm,
): string {
  const firstName = participantForm.firstName.trim();
  const fix =
    firstName !== "" && participantForm.lastName.trim() === ""
      ? `add ${firstName}'s last name or clear it`
      : "add the participant or clear it";
  return `Participant form has an unfinished entry: ${fix}`;
}

function playersChecklistItem(
  attendingPlayerCount: number,
  selectedCourtCount: number,
  matchFormat: CourtFormat,
): ChecklistItem {
  const playersPerCourt = PLAYERS_PER_MATCH[matchFormat];
  const attending = plural(attendingPlayerCount, "player", "players");
  if (attendingPlayerCount < playersPerCourt) {
    return {
      isDone: false,
      text: `${attending} attending: a ${matchFormat} court needs ${playersPerCourt}`,
    };
  }
  if (selectedCourtCount === 0) {
    return { isDone: true, text: `${attending} attending` };
  }
  const fillableCourtCount = Math.min(
    Math.floor(attendingPlayerCount / playersPerCourt),
    selectedCourtCount,
  );
  if (fillableCourtCount === selectedCourtCount) {
    return {
      isDone: true,
      text:
        selectedCourtCount === 1
          ? "Enough players for the court"
          : `Enough players for all ${selectedCourtCount} courts`,
    };
  }
  // Still fine to start: the courts that can be filled are used.
  return {
    isDone: true,
    text: `${attending} attending, enough for ${fillableCourtCount} of ${selectedCourtCount} courts`,
  };
}

export function setupReadiness({
  fieldErrors,
  selectedCourtCount,
  matchFormat,
  attendingPlayerCount,
  participantForm,
  isDraftSaved,
}: SetupReadinessInput): SetupReadiness {
  const checklist: ChecklistItem[] = [];

  const detailsIssueCount = DETAILS_FIELDS.filter(
    (field) => fieldErrors[field],
  ).length;
  checklist.push(
    detailsIssueCount === 0
      ? { isDone: true, text: "Session details complete" }
      : {
          isDone: false,
          text: `Session details: ${plural(detailsIssueCount, "field", "fields")} to fix`,
        },
  );

  const courtsIssueCount =
    selectedCourtCount === 0 || fieldErrors.courts ? 1 : 0;
  if (selectedCourtCount === 0) {
    checklist.push({ isDone: false, text: "Add at least one court" });
  } else if (fieldErrors.courts) {
    checklist.push({ isDone: false, text: fieldErrors.courts });
  }

  const playersItem = playersChecklistItem(
    attendingPlayerCount,
    selectedCourtCount,
    matchFormat,
  );
  checklist.push(playersItem);
  const hasUnfinishedParticipant = isParticipantFormUnfinished(participantForm);
  if (hasUnfinishedParticipant) {
    checklist.push({
      isDone: false,
      text: unfinishedParticipantFormMessage(participantForm),
    });
  }
  const playersIssueCount =
    (playersItem.isDone ? 0 : 1) + (hasUnfinishedParticipant ? 1 : 0);

  const stateFor = (issueCount: number, isUntouched: boolean) =>
    issueCount === 0 ? "done" : isUntouched ? "notStarted" : "attention";
  const steps: SetupStep[] = [
    {
      key: "details",
      label: "Details",
      state: stateFor(detailsIssueCount, false),
      issueCount: detailsIssueCount,
    },
    {
      key: "courts",
      label: "Courts",
      state: stateFor(courtsIssueCount, selectedCourtCount === 0),
      issueCount: courtsIssueCount,
    },
    {
      key: "players",
      label: "Players",
      state: stateFor(
        playersIssueCount,
        attendingPlayerCount === 0 && !hasUnfinishedParticipant,
      ),
      issueCount: playersIssueCount,
    },
    // The rotation always has valid values (it starts as the recommended one).
    { key: "rotation", label: "Rotation", state: "done", issueCount: 0 },
  ];
  const isSetupComplete = steps.every((step) => step.state === "done");
  steps.push({
    key: "review",
    label: "Review & start",
    state: isSetupComplete ? "ready" : "notStarted",
    issueCount: 0,
  });

  return {
    steps,
    checklist,
    isSetupComplete,
    isReadyToStart: isSetupComplete && isDraftSaved,
  };
}
