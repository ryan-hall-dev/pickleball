// Fixed simple-social rules. Historical sessions never opt in implicitly.
import type { SessionState, ParticipantState } from "./state";
import { sessionError, type SessionError } from "./errors";
import type { Participant, SessionConfig } from "./types";

export const SIMPLE_SOCIAL_REST_MS = 600_000;
export function isSimpleSocial(config: SessionConfig | null): boolean {
  return config?.policyVersion === "simple-social-v1";
}
export function simpleSessionDeadline(state: SessionState): number | null {
  return isSimpleSocial(state.config) && state.startedAt !== null
    ? state.startedAt + state.config!.plannedDurationMinutes * 60_000
    : null;
}
export function simpleSessionTimeIsUp(
  state: SessionState,
  now: number,
): boolean {
  const deadline = simpleSessionDeadline(state);
  return deadline !== null && now >= deadline;
}
/** Shared by initial roster and live approval validation; never guesses old data. */
export function validateSimpleParticipant(
  participant: Participant,
): SessionError | null {
  return participant &&
    (participant.gender === "male" || participant.gender === "female") &&
    ["beginner", "intermediate", "advanced"].includes(participant.skill ?? "")
    ? null
    : sessionError(
        "INVALID_CONFIG",
        "A simple-social player needs male or female gender and a Beginner, Intermediate or Advanced playing level.",
      );
}
export function validateSimpleTeams(
  teamA: readonly string[],
  teamB: readonly string[],
  participants: Readonly<Record<string, ParticipantState>>,
): SessionError | null {
  if (
    teamA.length !== 2 ||
    teamB.length !== 2 ||
    new Set([...teamA, ...teamB]).size !== 4
  ) {
    return sessionError(
      "INVALID_TEAMS",
      "Doubles needs four distinct players in two teams of two.",
    );
  }
  const genders = [...teamA, ...teamB].map(
    (id) => participants[id]?.participant.gender,
  );
  if (genders.some((gender) => gender !== "male" && gender !== "female")) {
    return sessionError(
      "INVALID_TEAMS",
      "Every player needs male or female gender.",
    );
  }
  const men = genders.filter((gender) => gender === "male").length;
  if (
    men === 0 ||
    men === 4 ||
    (men === 2 && genders[0] !== genders[1] && genders[2] !== genders[3])
  )
    return null;
  return sessionError(
    "INVALID_TEAMS",
    "Use four men, four women, or mixed teams with one of each.",
  );
}
export function reservedCourtId(
  state: SessionState,
  participantId: string,
  now = state.lastAt ?? -Infinity,
): string | null {
  if (simpleSessionTimeIsUp(state, now)) return null;
  for (const court of Object.values(state.courts)) {
    if (
      court.nextGroup &&
      [...court.nextGroup.teamA, ...court.nextGroup.teamB].includes(
        participantId,
      )
    )
      return court.court.courtId;
  }
  return null;
}
