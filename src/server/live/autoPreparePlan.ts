import {
  simpleRecommend,
  simpleRefill,
} from "@/engine/schedule/simpleRecommend";
import {
  dueCourtIds,
  isCourtClosed,
  isSimpleSocialV2,
  type SessionState,
} from "@/engine/session";
import type { NewSessionAction } from "@/server/submitSessionAction";

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
      // An undo releases newer groups to get them out of its way, not because
      // the host wants those courts left empty.
      case "MatchStartReverted":
      case "MatchCompletionReverted":
        held.clear();
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

/** One thing the app does by itself, with a key that makes its event id repeatable. */
export interface AutomaticAction {
  key: string;
  action: NewSessionAction;
}

/**
 * simple-social-v2: the next thing the app should do by itself, or null.
 * In order: close a court whose last game has ended after "Close after this
 * game"; refill an Up next seat someone gave up (D9); ask the next four for a
 * free court, then for games past the timer, oldest first (D12). A court a
 * host released stays unprepared until a game starts or ends there. The
 * caller applies the action and asks again, so one player is never offered
 * to two groups.
 */
export function nextAutomaticAction(
  state: SessionState,
  now: number,
): AutomaticAction | null {
  if (!isSimpleSocialV2(state.config) || state.phase !== "live") return null;
  for (const court of Object.values(state.courts)) {
    if (
      court.closeScheduledBySeq &&
      court.activeMatchId === null &&
      !isCourtClosed(court)
    )
      return {
        key: `close|${court.court.courtId}|${court.closeScheduledBySeq}`,
        action: {
          type: "CourtClosed",
          payload: { courtId: court.court.courtId },
        },
      };
  }
  const [refill] = simpleRefill(state, now);
  if (refill)
    return {
      key: `refill|${refill.calledEventId}`,
      action: {
        type: "NextGroupChanged",
        payload: {
          calledEventId: refill.calledEventId,
          teamA: refill.teamA,
          teamB: refill.teamB,
        },
      },
    };
  const held = heldCourtIds(state);
  const due = dueCourtIds(state, now).filter((courtId) => !held.has(courtId));
  const [group] = due.length ? simpleRecommend(state, now, due) : [];
  if (group)
    return {
      key: group.courtId,
      action: {
        type: "NextGroupCalled",
        payload: {
          courtId: group.courtId,
          teamA: group.teamA,
          teamB: group.teamB,
        },
      },
    };
  return null;
}
