import type { EventHandler, StateDraft } from "./draft";
import { sessionError, type SessionError } from "./errors";
import { isCourtClosed } from "./state";
import { isSessionError, requireAvailableParticipant } from "./playerHandlers";
import {
  calledSeats,
  isSimpleSocial,
  isSimpleSocialV2,
  reservedCourtId,
  validateSimpleTeams,
} from "./simplePolicy";
import type { CalledGroup, CourtState } from "./state";

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
  if (draft.next.courts[courtId].closeScheduledBySeq)
    return sessionError(
      "COURT_CLOSED",
      "This court closes after its game; nothing new is prepared there.",
    );
  draft.set("courts", courtId, {
    ...draft.next.courts[courtId],
    nextGroup: {
      calledEventId: event.eventId,
      teamA: [...teamA],
      teamB: [...teamB],
      ...(isSimpleSocialV2(draft.next.config) ? { confirmedIds: [] } : {}),
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
  // v2: whoever stays keeps their confirmation; a newcomer starts unconfirmed.
  const kept = new Set([...teamA, ...teamB]);
  draft.set("courts", court.court.courtId, {
    ...court,
    nextGroup: {
      calledEventId: event.payload.calledEventId,
      teamA: [...teamA],
      teamB: [...teamB],
      ...(court.nextGroup?.confirmedIds
        ? {
            confirmedIds: court.nextGroup.confirmedIds.filter((id) =>
              kept.has(id),
            ),
          }
        : {}),
    },
  });
  return null;
};

function findCalledCourt(
  draft: StateDraft,
  calledEventId: string,
): CourtState | SessionError {
  return (
    Object.values(draft.next.courts).find(
      (court) => court.nextGroup?.calledEventId === calledEventId,
    ) ??
    sessionError(
      "UNKNOWN_CALLED_GROUP",
      "That called group has been released or started.",
    )
  );
}

function requireV2(draft: StateDraft): SessionError | null {
  return isSimpleSocialV2(draft.next.config)
    ? null
    : sessionError(
        "POLICY_ACTION_NOT_ALLOWED",
        "This needs the newer simple-social policy.",
      );
}

export const handleNextGroupSeatConfirmed: EventHandler<
  "NextGroupSeatConfirmed"
> = (draft, event) => {
  const policyError = requireV2(draft);
  if (policyError) return policyError;
  const court = findCalledCourt(draft, event.payload.calledEventId);
  if ("code" in court) return court;
  const group = court.nextGroup!;
  const { participantId } = event.payload;
  if (!calledSeats(group).includes(participantId))
    return sessionError(
      "NOT_IN_CALLED_GROUP",
      `${draft.participantLabel(participantId)} is not in this group any more.`,
    );
  if (group.confirmedIds?.includes(participantId))
    return sessionError(
      "ALREADY_CONFIRMED",
      `${draft.participantLabel(participantId)} has already confirmed.`,
    );
  draft.set("courts", court.court.courtId, {
    ...court,
    nextGroup: {
      ...group,
      confirmedIds: [...(group.confirmedIds ?? []), participantId],
    },
  });
  return null;
};

/** Moves a group to an open court with no game; swaps with a group there. */
export const handleNextGroupMoved: EventHandler<"NextGroupMoved"> = (
  draft,
  event,
) => {
  const policyError = requireV2(draft);
  if (policyError) return policyError;
  const from = findCalledCourt(draft, event.payload.calledEventId);
  if ("code" in from) return from;
  const to = draft.next.courts[event.payload.toCourtId];
  if (!to)
    return sessionError(
      "UNKNOWN_COURT",
      `${draft.courtLabel(event.payload.toCourtId)} is not in this session.`,
    );
  if (to.court.courtId === from.court.courtId)
    return sessionError("INVALID_MOVE", "The group is already on that court.");
  if (isCourtClosed(to) || to.closeScheduledBySeq)
    return sessionError(
      "COURT_CLOSED",
      `${draft.courtLabel(to.court.courtId)} is closed or closing.`,
    );
  if (to.activeMatchId !== null)
    return sessionError(
      "COURT_BUSY",
      `${draft.courtLabel(to.court.courtId)} has a game in progress.`,
    );
  const moving: CalledGroup = from.nextGroup!;
  const swapped: CalledGroup | null = to.nextGroup ?? null;
  draft.set("courts", from.court.courtId, { ...from, nextGroup: swapped });
  draft.set("courts", to.court.courtId, { ...to, nextGroup: moving });
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
        ...(group.confirmedIds
          ? {
              confirmedIds: group.confirmedIds.filter(
                (id) => id !== participantId,
              ),
            }
          : {}),
      },
    });
  }
}
