// Fixed simple-social rules. Historical sessions never opt in implicitly.
import {
  isCourtClosed,
  type CalledGroup,
  type ParticipantState,
  type SessionState,
} from "./state";
import { sessionError, type SessionError } from "./errors";
import type { CourtId, Participant, SessionConfig } from "./types";

export const SIMPLE_SOCIAL_REST_MS = 600_000;
/**
 * simple-social-v2 default: ask the next four this long after a game starts.
 * 0 is as soon as it starts (Ryan, 2026-11-26; was 6).
 */
export const DEFAULT_UP_NEXT_AFTER_MINUTES = 0;
export const MAX_UP_NEXT_AFTER_MINUTES = 30;

/** Either simple-social version: called groups, the doubles rule, wait-first. */
export function isSimpleSocial(config: SessionConfig | null): boolean {
  return (
    config?.policyVersion === "simple-social-v1" ||
    config?.policyVersion === "simple-social-v2"
  );
}
/** simple-social-v2 only: confirmations, open breaks, moves, close after game. */
export function isSimpleSocialV2(config: SessionConfig | null): boolean {
  return config?.policyVersion === "simple-social-v2";
}
export function upNextAfterMs(config: SessionConfig): number {
  return (config.upNextAfterMinutes ?? DEFAULT_UP_NEXT_AFTER_MINUTES) * 60_000;
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

/** Every seat of an Up next group, vacancies included. */
export function calledSeats(group: CalledGroup): Array<string | null> {
  return [...group.teamA, ...group.teamB];
}

/**
 * simple-social-v2: courts whose next four should be asked now, most urgent
 * first. A free court first, then courts whose game started at least
 * `upNextAfterMinutes` ago, the oldest game first (D12). Closed courts,
 * courts closing after this game and courts with a group are left out.
 */
export function dueCourtIds(state: SessionState, now: number): CourtId[] {
  if (!isSimpleSocialV2(state.config) || state.phase !== "live") return [];
  const after = upNextAfterMs(state.config!);
  const free: CourtId[] = [];
  const busy: Array<{ courtId: CourtId; startedAt: number }> = [];
  for (const court of Object.values(state.courts)) {
    if (
      court.nextGroup ||
      court.closeScheduledBySeq ||
      court.court.format !== "doubles" ||
      isCourtClosed(court)
    )
      continue;
    if (court.activeMatchId === null) {
      free.push(court.court.courtId);
      continue;
    }
    const match = state.matches[court.activeMatchId];
    if (match && now - match.startedAt >= after)
      busy.push({ courtId: court.court.courtId, startedAt: match.startedAt });
  }
  busy.sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      (left.courtId < right.courtId ? -1 : 1),
  );
  return [...free, ...busy.map((court) => court.courtId)];
}

/**
 * simple-social-v2 "Head to court": derived, never stored. The court is free
 * and open, and all four seats are filled and confirmed. A replacement, rest
 * or departure withdraws it by itself.
 */
export function isUpNextReadyToPlay(
  state: SessionState,
  courtId: CourtId,
): boolean {
  const court = state.courts[courtId];
  const group = court?.nextGroup;
  if (!court || !group || court.activeMatchId !== null || isCourtClosed(court))
    return false;
  const seats = calledSeats(group);
  return (
    seats.every((id) => id !== null) &&
    seats.every((id) => group.confirmedIds?.includes(id!) ?? false)
  );
}
