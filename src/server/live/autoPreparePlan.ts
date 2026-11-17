import { simpleRecommend } from "@/engine/schedule/simpleRecommend";
import { isCourtClosed, type SessionState } from "@/engine/session";

export interface AutoPreparedGroup {
  courtId: string;
  teamA: string[];
  teamB: string[];
}

/**
 * Courts a host released on purpose. A release by a host (the only kind there
 * is) keeps that court unprepared until a game next starts or finishes on it,
 * so Release group is never undone by the next poll.
 */
export function heldCourtIds(state: SessionState): Set<string> {
  const callCourt = new Map<string, string>();
  const matchCourt = new Map<string, string>();
  const held = new Set<string>();
  for (const { event } of state.history) {
    switch (event.type) {
      case "NextGroupCalled":
        callCourt.set(event.eventId, event.payload.courtId);
        break;
      case "NextGroupReleased": {
        const courtId = callCourt.get(event.payload.calledEventId);
        if (courtId) held.add(courtId);
        break;
      }
      case "MatchStarted":
        matchCourt.set(event.payload.matchId, event.payload.courtId);
        held.delete(event.payload.courtId);
        break;
      case "MatchCompleted":
      case "MatchAbandoned": {
        const courtId = matchCourt.get(event.payload.matchId);
        if (courtId) held.delete(courtId);
        break;
      }
      default:
        break;
    }
  }
  return held;
}

/**
 * The groups to prepare right now, in court order, using the existing
 * wait-first scheduler. Pure: no clock, no writes. Only courts that are free,
 * unprepared, open and not held are filled; a prepared group is never touched.
 * Empty when time is up, the session is not live, or fewer than four eligible
 * players (the scheduler returns nothing then).
 */
export function planAutoPreparation(
  state: SessionState,
  now: number,
): AutoPreparedGroup[] {
  const held = heldCourtIds(state);
  const availableCourtIds = Object.values(state.courts)
    .filter(
      (court) =>
        court.court.format === "doubles" &&
        !court.activeMatchId &&
        !court.nextGroup &&
        !isCourtClosed(court) &&
        !held.has(court.court.courtId),
    )
    .map((court) => court.court.courtId);
  if (availableCourtIds.length === 0) return [];
  return simpleRecommend(state, now, availableCourtIds).map((suggestion) => ({
    courtId: suggestion.courtId,
    teamA: suggestion.teamA,
    teamB: suggestion.teamB,
  }));
}
