import type { EventHandler, StateDraft } from "./draft";
import { sessionError, type SessionError } from "./errors";
import { isCourtClosed } from "./state";
import { isSessionError, requireAvailableParticipant } from "./playerHandlers";
import {
  isSimpleSocial,
  reservedCourtId,
  validateSimpleTeams,
} from "./simplePolicy";

function validateCall(
  draft: StateDraft,
  courtId: string,
  teamA: string[],
  teamB: string[],
  now: number,
): SessionError | null {
  const court = draft.next.courts[courtId];
  if (!court)
    return sessionError(
      "UNKNOWN_COURT",
      "The called court is not in this session.",
    );
  if (isCourtClosed(court))
    return sessionError("COURT_CLOSED", "The called court is closed.");
  if (!Array.isArray(teamA) || !Array.isArray(teamB))
    return sessionError("INVALID_TEAMS", "A call needs two teams.");
  const teamsError = validateSimpleTeams(teamA, teamB, draft.next.participants);
  if (teamsError) return teamsError;
  for (const id of [...teamA, ...teamB]) {
    const available = requireAvailableParticipant(draft, id, now);
    if (isSessionError(available)) return available;
    const reservation = reservedCourtId(draft.next, id, now);
    if (reservation !== null && reservation !== courtId)
      return sessionError(
        "PLAYER_RESERVED",
        "A player is already called for another court.",
      );
  }
  return null;
}
export const handleNextGroupCalled: EventHandler<"NextGroupCalled"> = (
  draft,
  event,
) => {
  const { courtId, teamA, teamB } = event.payload;
  if (draft.next.courts[courtId]?.nextGroup)
    return sessionError(
      "CALLED_GROUP_EXISTS",
      "Change or release the existing call first.",
    );
  const error = validateCall(draft, courtId, teamA, teamB, event.at);
  if (error) return error;
  draft.set("courts", courtId, {
    ...draft.next.courts[courtId],
    nextGroup: {
      calledEventId: event.eventId,
      teamA: [...teamA],
      teamB: [...teamB],
    },
  });
  return null;
};
export const handleNextGroupChanged: EventHandler<"NextGroupChanged"> = (
  draft,
  event,
) => {
  const court = Object.values(draft.next.courts).find(
    (court) => court.nextGroup?.calledEventId === event.payload.calledEventId,
  );
  if (!court)
    return sessionError(
      "UNKNOWN_CALLED_GROUP",
      "That called group has been released or started.",
    );
  const { teamA, teamB } = event.payload;
  const error = validateCall(
    draft,
    court.court.courtId,
    teamA,
    teamB,
    event.at,
  );
  if (error) return error;
  draft.set("courts", court.court.courtId, {
    ...court,
    nextGroup: {
      calledEventId: event.payload.calledEventId,
      teamA: [...teamA],
      teamB: [...teamB],
    },
  });
  return null;
};
export const handleNextGroupReleased: EventHandler<"NextGroupReleased"> = (
  draft,
  event,
) => {
  const court = Object.values(draft.next.courts).find(
    (court) => court.nextGroup?.calledEventId === event.payload.calledEventId,
  );
  if (!court)
    return sessionError(
      "UNKNOWN_CALLED_GROUP",
      "That called group has been released or started.",
    );
  draft.set("courts", court.court.courtId, { ...court, nextGroup: null });
  return null;
};
/** Leaving/resting frees only that seat. Return never silently refills it. */
export function invalidateCalledSeat(
  draft: StateDraft,
  participantId: string,
): void {
  if (!isSimpleSocial(draft.next.config)) return;
  for (const court of Object.values(draft.next.courts)) {
    const group = court.nextGroup;
    if (!group || ![...group.teamA, ...group.teamB].includes(participantId))
      continue;
    const vacate = (team: Array<string | null>) =>
      team.map((id) => (id === participantId ? null : id));
    draft.set("courts", court.court.courtId, {
      ...court,
      nextGroup: {
        ...group,
        teamA: vacate(group.teamA),
        teamB: vacate(group.teamB),
      },
    });
  }
}
