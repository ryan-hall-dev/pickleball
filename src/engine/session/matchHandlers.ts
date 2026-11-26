// Match lifecycle events: start, complete, abandon, replace, and their undos.
import { targetEvent, type EventHandler, type StateDraft } from "./draft";
import { sessionError, type SessionError } from "./errors";
import type { MatchAssignment, SessionEventOf } from "./events";
import { isSessionError, requireAvailableParticipant } from "./playerHandlers";
import {
  currentLineup,
  hasPlayedSince,
  isCourtClosed,
  isPresent,
  type HistoryEntry,
  type MatchState,
  type MatchStatus,
  type PlayerLock,
  type PlaySegment,
} from "./state";
import { PLAYERS_PER_TEAM, type MatchId, type ParticipantId } from "./types";
import {
  isSimpleSocial,
  reservedCourtId,
  simpleSessionTimeIsUp,
  validateSimpleTeams,
} from "./simplePolicy";

/** Validates and starts a match at `event.at`; shared by `MatchStarted` and `SessionStarted.initialMatches`. */
export function startMatch(
  draft: StateDraft,
  assignment: MatchAssignment,
  event: { seq: number; at: number },
): SessionError | null {
  const { matchId, courtId, teamA, teamB } = assignment;
  if (typeof matchId !== "string" || matchId === "") {
    return sessionError("MALFORMED_EVENT", "A match needs a matchId.");
  }
  if (draft.next.startedMatchIds[matchId]) {
    return sessionError(
      "DUPLICATE_ID",
      `Match id ${matchId} has already been used in this session.`,
    );
  }
  const courtState = draft.next.courts[courtId];
  const courtLabel = draft.courtLabel(courtId);
  if (!courtState) {
    return sessionError(
      "UNKNOWN_COURT",
      `${courtLabel} is not in this session.`,
    );
  }
  if (isCourtClosed(courtState)) {
    return sessionError("COURT_CLOSED", `${courtLabel} is closed.`);
  }
  if (courtState.activeMatchId !== null) {
    return sessionError("COURT_BUSY", `${courtLabel} already has a match.`);
  }
  const teamSize = PLAYERS_PER_TEAM[courtState.court.format];
  if (
    !Array.isArray(teamA) ||
    !Array.isArray(teamB) ||
    teamA.length !== teamSize ||
    teamB.length !== teamSize
  ) {
    return sessionError(
      "INVALID_TEAMS",
      `${courtLabel} is ${courtState.court.format}: each team needs exactly ${teamSize} player${teamSize === 1 ? "" : "s"}.`,
    );
  }
  const playerIds = [...teamA, ...teamB];
  if (new Set(playerIds).size !== playerIds.length) {
    return sessionError(
      "INVALID_TEAMS",
      "A player can't take two places in one match.",
    );
  }
  const consumedLocks: Record<ParticipantId, PlayerLock> = {};
  if (isSimpleSocial(draft.next.config)) {
    if (simpleSessionTimeIsUp(draft.next, event.at))
      return sessionError(
        "SESSION_TIME_UP",
        "Session time is up; finish the active games.",
      );
    if (courtState.closeScheduledBySeq)
      return sessionError(
        "COURT_CLOSED",
        "This court closes after its game; no new game starts there.",
      );
    const error = validateSimpleTeams(teamA, teamB, draft.next.participants);
    if (error) return error;
    const call = courtState.nextGroup;
    if (assignment.calledEventId !== undefined || call) {
      if (
        !call ||
        assignment.calledEventId !== call.calledEventId ||
        JSON.stringify([teamA, teamB]) !==
          JSON.stringify([call.teamA, call.teamB])
      ) {
        return sessionError(
          "UNKNOWN_CALLED_GROUP",
          "Start the current called group or explicitly change it first.",
        );
      }
    }
    for (const id of playerIds) {
      const reserved = reservedCourtId(draft.next, id, event.at);
      if (reserved !== null && reserved !== courtId)
        return sessionError(
          "PLAYER_RESERVED",
          "A player is called for another court.",
        );
    }
  }
  for (const participantId of playerIds) {
    const participantState = requireAvailableParticipant(
      draft,
      participantId,
      event.at,
    );
    if (isSessionError(participantState)) return participantState;
    if (participantState.lock !== null) {
      consumedLocks[participantId] = participantState.lock;
    }
  }

  // A manual queue rank lasts until the player next goes on court.
  const clearsARank = draft.next.queueOrder.some((participantId) =>
    playerIds.includes(participantId),
  );
  const queueOrderAtStart = clearsARank ? draft.next.queueOrder : [];
  draft.next.queueOrder = draft.next.queueOrder.filter(
    (participantId) => !playerIds.includes(participantId),
  );

  const segments: PlaySegment[] = playerIds.map((participantId, index) => ({
    participantId,
    team: index < teamSize ? "A" : "B",
    from: event.at,
    to: null,
    startedByReplacementSeq: null,
    endedMidMatchBySeq: null,
    countGameForOut: false,
  }));
  draft.set("startedMatchIds", matchId, true);
  draft.set("matches", matchId, {
    matchId,
    courtId,
    status: "active",
    startedAt: event.at,
    startedBySeq: event.seq,
    endedAt: null,
    endedBySeq: null,
    segments,
    consumedLocks,
    ...(isSimpleSocial(draft.next.config) && courtState.nextGroup
      ? {
          consumedCall: {
            ...courtState.nextGroup,
            teamA: [...courtState.nextGroup.teamA],
            teamB: [...courtState.nextGroup.teamB],
          },
        }
      : {}),
    queueOrderAtStart,
  });
  draft.set("courts", courtId, {
    ...courtState,
    ...(isSimpleSocial(draft.next.config) ? { nextGroup: null } : {}),
    activeMatchId: matchId,
    matchIds: [...courtState.matchIds, matchId],
  });
  for (const participantId of playerIds) {
    const participantState = draft.next.participants[participantId];
    draft.set("participants", participantId, {
      ...participantState,
      activeMatchId: matchId,
      lock: null,
      matchIds: [...participantState.matchIds, matchId],
    });
  }
  return null;
}

export const handleMatchStarted: EventHandler<"MatchStarted"> = (
  draft,
  event,
) => startMatch(draft, event.payload, event);

function requireMatch(
  draft: StateDraft,
  matchId: MatchId,
): SessionError | MatchState {
  return (
    draft.next.matches[matchId] ??
    sessionError("UNKNOWN_MATCH", `Match ${matchId} is not in this session.`)
  );
}

/** The match a `MatchStartReverted` undoes, from its target and optional `matchId`. */
function startRevertMatchId(
  event: SessionEventOf<"MatchStartReverted">,
  target: HistoryEntry,
): SessionError | MatchId {
  const requestedMatchId = event.payload.matchId;
  if (target.event.type === "SessionStarted") {
    const initialMatches = target.event.payload.initialMatches ?? [];
    const isInitialMatch = initialMatches.some(
      (assignment) => assignment.matchId === requestedMatchId,
    );
    if (typeof requestedMatchId !== "string" || !isInitialMatch) {
      return sessionError(
        "TARGET_MISMATCH",
        "Name one of the matches started with the session to undo it; starting the session itself can't be undone.",
      );
    }
    return requestedMatchId;
  }
  const startedMatchId = targetEvent(target, "MatchStarted").payload.matchId;
  if (requestedMatchId !== undefined && requestedMatchId !== startedMatchId) {
    return sessionError(
      "TARGET_MISMATCH",
      `Action ${target.event.seq} started a different match.`,
    );
  }
  return startedMatchId;
}

export const handleMatchStartReverted: EventHandler<"MatchStartReverted"> = (
  draft,
  event,
  target,
) => {
  const matchId = startRevertMatchId(event, target);
  if (typeof matchId !== "string") return matchId;
  const match = draft.next.matches[matchId];
  if (!match) {
    // Only reachable for a first match: a MatchStarted undo is caught by compensatedBySeq.
    return sessionError(
      "ALREADY_COMPENSATED",
      "That match's start has already been undone.",
    );
  }
  if (match.status !== "active") {
    return sessionError(
      "UNDO_BLOCKED",
      `That match is ${match.status}; undo its ${match.status === "completed" ? "completion" : "abandonment"} first.`,
    );
  }
  if (
    match.segments.some(
      (segment) =>
        segment.startedByReplacementSeq !== null ||
        segment.endedMidMatchBySeq !== null,
    )
  ) {
    return sessionError(
      "UNDO_BLOCKED",
      "A player was replaced or removed in that match; undo that first, or abandon the match instead.",
    );
  }

  const courtState = draft.next.courts[match.courtId];
  if (match.consumedCall) {
    if (courtState.nextGroup) {
      return sessionError(
        "UNDO_BLOCKED",
        "Release the newer called group before undoing this start.",
      );
    }
    for (const participantId of [
      ...match.consumedCall.teamA,
      ...match.consumedCall.teamB,
    ]) {
      if (
        participantId !== null &&
        reservedCourtId(draft.next, participantId, event.at) !== null
      ) {
        return sessionError(
          "UNDO_BLOCKED",
          "Release the player's newer called group before undoing this start.",
        );
      }
    }
  }
  draft.remove("matches", matchId);
  draft.set("courts", match.courtId, {
    ...courtState,
    activeMatchId: null,
    matchIds: courtState.matchIds.filter((id) => id !== matchId),
    ...(match.consumedCall
      ? {
          nextGroup: {
            ...match.consumedCall,
            teamA: [...match.consumedCall.teamA],
            teamB: [...match.consumedCall.teamB],
          },
        }
      : {}),
  });
  for (const segment of match.segments) {
    const participantState = draft.next.participants[segment.participantId];
    const consumedLock = match.consumedLocks[segment.participantId];
    draft.set("participants", segment.participantId, {
      ...participantState,
      activeMatchId: null,
      matchIds: participantState.matchIds.filter((id) => id !== matchId),
      lock: participantState.lock ?? consumedLock ?? null,
    });
  }
  draft.next.queueOrder = reinsertClearedRanks(
    draft.next.queueOrder,
    match.queueOrderAtStart,
    new Set(match.segments.map((segment) => segment.participantId)),
  );
  return null;
};

/**
 * Puts the ranks a match start cleared back into `currentOrder`, each right
 * after its nearest predecessor in `orderAtStart` that is still queued (or at
 * the front). While the order has only lost entries since the start (later
 * starts), it is a subsequence of `orderAtStart`, so this is exactly the order
 * the log would give without the start. After a newer reorder the ranks are
 * placed relative to their old neighbours, as the host last ordered them.
 */
function reinsertClearedRanks(
  currentOrder: readonly ParticipantId[],
  orderAtStart: readonly ParticipantId[],
  starterIds: ReadonlySet<ParticipantId>,
): ParticipantId[] {
  const queueOrder = [...currentOrder];
  orderAtStart.forEach((participantId, startIndex) => {
    if (!starterIds.has(participantId) || queueOrder.includes(participantId)) {
      return;
    }
    let insertAt = 0;
    for (let index = startIndex - 1; index >= 0; index -= 1) {
      const predecessorIndex = queueOrder.indexOf(orderAtStart[index]);
      if (predecessorIndex !== -1) {
        insertAt = predecessorIndex + 1;
        break;
      }
    }
    queueOrder.splice(insertAt, 0, participantId);
  });
  return queueOrder;
}

function finishMatch(
  draft: StateDraft,
  event: SessionEventOf<"MatchCompleted" | "MatchAbandoned">,
  status: Exclude<MatchStatus, "active">,
): SessionError | null {
  const match = requireMatch(draft, event.payload.matchId);
  if (isSessionError(match)) return match;
  if (match.status !== "active") {
    return sessionError(
      "MATCH_NOT_ACTIVE",
      `That match on ${draft.courtLabel(match.courtId)} is already ${match.status}.`,
    );
  }
  draft.set("matches", match.matchId, {
    ...match,
    status,
    endedAt: event.at,
    endedBySeq: event.seq,
    segments: match.segments.map((segment) =>
      segment.to === null ? { ...segment, to: event.at } : segment,
    ),
  });
  draft.set("courts", match.courtId, {
    ...draft.next.courts[match.courtId],
    activeMatchId: null,
  });
  for (const segment of currentLineup(match)) {
    draft.set("participants", segment.participantId, {
      ...draft.next.participants[segment.participantId],
      activeMatchId: null,
    });
  }
  return null;
}

export const handleMatchCompleted: EventHandler<"MatchCompleted"> = (
  draft,
  event,
) => finishMatch(draft, event, "completed");

export const handleMatchAbandoned: EventHandler<"MatchAbandoned"> = (
  draft,
  event,
) => finishMatch(draft, event, "abandoned");

/** Makes a finished match live again, as if it had never ended. */
function reopenMatch(
  draft: StateDraft,
  target: HistoryEntry,
  matchId: MatchId,
  now: number,
): SessionError | null {
  const match = requireMatch(draft, matchId);
  if (isSessionError(match)) return match;
  const endedBySeq = target.event.seq;
  if (match.endedBySeq !== endedBySeq || match.endedAt === null) {
    return sessionError("TARGET_MISMATCH", "That match is not ended by it.");
  }
  const courtState = draft.next.courts[match.courtId];
  const courtLabel = draft.courtLabel(match.courtId);
  if (courtState.activeMatchId !== null) {
    return sessionError(
      "UNDO_BLOCKED",
      `${courtLabel} has a match in progress; complete or undo it first.`,
    );
  }
  const courtUsedSince = courtState.matchIds.some(
    (id) => (draft.next.matches[id]?.startedBySeq ?? 0) > endedBySeq,
  );
  if (courtUsedSince) {
    return sessionError(
      "UNDO_BLOCKED",
      `Another match has been played on ${courtLabel} since; undo it first.`,
    );
  }
  if (courtState.closures.some((closure) => closure.closedBySeq > endedBySeq)) {
    return sessionError(
      "UNDO_BLOCKED",
      `${courtLabel} has been closed since; this match can no longer be reopened.`,
    );
  }
  const lineup = currentLineup(match);
  for (const segment of lineup) {
    const participantState = draft.next.participants[segment.participantId];
    const label = draft.participantLabel(segment.participantId);
    if (reservedCourtId(draft.next, segment.participantId, now) !== null)
      return sessionError(
        "UNDO_BLOCKED",
        "Release the player's called group before undoing the finish.",
      );
    if (participantState.activeMatchId !== null) {
      return sessionError(
        "UNDO_BLOCKED",
        `${label} is now in another match; undo or complete it first.`,
      );
    }
    if (hasPlayedSince(draft.next, participantState, endedBySeq, matchId)) {
      return sessionError(
        "UNDO_BLOCKED",
        `${label} has played another match since; undo it first.`,
      );
    }
    const lastPresence =
      participantState.presence[participantState.presence.length - 1];
    if (
      !isPresent(participantState) ||
      lastPresence.startedBySeq > endedBySeq
    ) {
      return sessionError(
        "UNDO_BLOCKED",
        `${label} has left since this match ended; the match can no longer be reopened.`,
      );
    }
    if (participantState.skips.some((skip) => skip.skippedBySeq > endedBySeq)) {
      return sessionError(
        "UNDO_BLOCKED",
        `${label} has been skipped since this match ended; the match can no longer be reopened.`,
      );
    }
  }

  const lineupIds = new Set(lineup.map((segment) => segment.participantId));
  draft.set("matches", matchId, {
    ...match,
    status: "active",
    endedAt: null,
    endedBySeq: null,
    segments: match.segments.map((segment) =>
      segment.endedMidMatchBySeq === null ? { ...segment, to: null } : segment,
    ),
  });
  draft.set("courts", match.courtId, { ...courtState, activeMatchId: matchId });
  for (const participantId of lineupIds) {
    draft.set("participants", participantId, {
      ...draft.next.participants[participantId],
      activeMatchId: matchId,
    });
  }
  return null;
}

export const handleMatchCompletionReverted: EventHandler<
  "MatchCompletionReverted"
> = (draft, event, target) =>
  reopenMatch(
    draft,
    target,
    targetEvent(target, "MatchCompleted").payload.matchId,
    event.at,
  );

export const handleMatchAbandonReverted: EventHandler<
  "MatchAbandonReverted"
> = (draft, event, target) =>
  reopenMatch(
    draft,
    target,
    targetEvent(target, "MatchAbandoned").payload.matchId,
    event.at,
  );

/** Index of `participantId`'s seat in an active match, or an error when the match or player doesn't qualify. */
function requireSeatInActiveMatch(
  draft: StateDraft,
  match: MatchState,
  participantId: ParticipantId,
  actionNoun: string,
): SessionError | number {
  if (match.status !== "active") {
    return sessionError(
      "MATCH_NOT_ACTIVE",
      `That match is ${match.status}; only a match in progress can have a ${actionNoun}.`,
    );
  }
  const seatIndex = match.segments.findIndex(
    (segment) =>
      segment.participantId === participantId &&
      segment.endedMidMatchBySeq === null,
  );
  if (seatIndex === -1) {
    return sessionError(
      "PLAYER_NOT_IN_MATCH",
      `${draft.participantLabel(participantId)} is not playing in that match.`,
    );
  }
  return seatIndex;
}

/** Ends a player's segment mid-match and frees them; returns the new segments. */
function takeOffCourt(
  draft: StateDraft,
  match: MatchState,
  seatIndex: number,
  event: { seq: number; at: number },
  countGameForOut: boolean,
): PlaySegment[] {
  const segments = [...match.segments];
  segments[seatIndex] = {
    ...segments[seatIndex],
    to: event.at,
    endedMidMatchBySeq: event.seq,
    countGameForOut: countGameForOut === true,
  };
  const participantId = segments[seatIndex].participantId;
  draft.set("participants", participantId, {
    ...draft.next.participants[participantId],
    activeMatchId: null,
  });
  return segments;
}

export const handlePlayerReplaced: EventHandler<"PlayerReplaced"> = (
  draft,
  event,
) => {
  const { matchId, outId, inId, countGameForOut } = event.payload;
  const match = requireMatch(draft, matchId);
  if (isSessionError(match)) return match;
  const outIndex = requireSeatInActiveMatch(draft, match, outId, "replacement");
  if (typeof outIndex !== "number") return outIndex;
  const incoming = requireAvailableParticipant(draft, inId, event.at);
  if (isSessionError(incoming)) return incoming;
  if (isSimpleSocial(draft.next.config)) {
    if (reservedCourtId(draft.next, inId, event.at) !== null)
      return sessionError(
        "PLAYER_RESERVED",
        "This player is called for another game.",
      );
    const lineup = currentLineup(match);
    const team = (side: "A" | "B") =>
      lineup
        .filter((segment) => segment.team === side)
        .map((segment) =>
          segment.participantId === outId ? inId : segment.participantId,
        );
    const error = validateSimpleTeams(
      team("A"),
      team("B"),
      draft.next.participants,
    );
    if (error) return error;
  }

  const segments = takeOffCourt(draft, match, outIndex, event, countGameForOut);
  segments.push({
    participantId: inId,
    team: match.segments[outIndex].team,
    from: event.at,
    to: null,
    startedByReplacementSeq: event.seq,
    endedMidMatchBySeq: null,
    countGameForOut: false,
  });
  draft.set("matches", matchId, { ...match, segments });
  draft.set("participants", inId, {
    ...incoming,
    activeMatchId: matchId,
    matchIds: incoming.matchIds.includes(matchId)
      ? incoming.matchIds
      : [...incoming.matchIds, matchId],
  });
  return null;
};

// With no replacement the match continues short-handed (the seat stays empty)
// and the court stays busy until the host completes or abandons it. This is the
// simplest rule that keeps one match per court and needs no auto-ending.
export const handlePlayerRemovedMidMatch: EventHandler<
  "PlayerRemovedMidMatch"
> = (draft, event) => {
  const { matchId, participantId, countGameForOut } = event.payload;
  const match = requireMatch(draft, matchId);
  if (isSessionError(match)) return match;
  const seatIndex = requireSeatInActiveMatch(
    draft,
    match,
    participantId,
    "removal",
  );
  if (typeof seatIndex !== "number") return seatIndex;
  if (currentLineup(match).length === 1) {
    return sessionError(
      "INVALID_TEAMS",
      `${draft.participantLabel(participantId)} is the last player on court; abandon the match instead.`,
    );
  }
  const segments = takeOffCourt(
    draft,
    match,
    seatIndex,
    event,
    countGameForOut,
  );
  draft.set("matches", matchId, { ...match, segments });
  return null;
};

/** The match an undo inside a match targets; it must still be in progress. */
function requireActiveMatchForUndo(
  draft: StateDraft,
  matchId: MatchId,
): SessionError | MatchState {
  const match = requireMatch(draft, matchId);
  if (isSessionError(match)) return match;
  if (match.status !== "active") {
    return sessionError(
      "UNDO_BLOCKED",
      `That match is ${match.status}; undo its ${match.status === "completed" ? "completion" : "abandonment"} first.`,
    );
  }
  return match;
}

/**
 * Why a player taken off court at `takenOffSeq` can't go back on, or null.
 * `takenOffVerb` completes "since being …" (e.g. "replaced").
 */
function returnToCourtBlocker(
  draft: StateDraft,
  participantId: ParticipantId,
  takenOffSeq: number,
  takenOffVerb: string,
): SessionError | null {
  const participantState = draft.next.participants[participantId];
  const label = draft.participantLabel(participantId);
  if (participantState.activeMatchId !== null) {
    return sessionError(
      "UNDO_BLOCKED",
      `${label} is now in another match; undo or complete it first.`,
    );
  }
  if (hasPlayedSince(draft.next, participantState, takenOffSeq)) {
    return sessionError(
      "UNDO_BLOCKED",
      `${label} has played another match since; undo it first.`,
    );
  }
  const lastPresence =
    participantState.presence[participantState.presence.length - 1];
  if (!isPresent(participantState) || lastPresence.startedBySeq > takenOffSeq) {
    return sessionError(
      "UNDO_BLOCKED",
      `${label} has left since being ${takenOffVerb}; this can no longer be undone.`,
    );
  }
  if (participantState.skips.some((skip) => skip.skippedBySeq > takenOffSeq)) {
    return sessionError(
      "UNDO_BLOCKED",
      `${label} has been skipped since being ${takenOffVerb}; this can no longer be undone.`,
    );
  }
  return null;
}

/** Reopens the segment at `seatIndex` and puts its player back in the match; returns the new segments. */
function putBackOnCourt(
  draft: StateDraft,
  match: MatchState,
  seatIndex: number,
): PlaySegment[] {
  const segments = [...match.segments];
  segments[seatIndex] = {
    ...segments[seatIndex],
    to: null,
    endedMidMatchBySeq: null,
    countGameForOut: false,
  };
  const participantId = segments[seatIndex].participantId;
  draft.set("participants", participantId, {
    ...draft.next.participants[participantId],
    activeMatchId: match.matchId,
  });
  return segments;
}

export const handlePlayerReplacementReverted: EventHandler<
  "PlayerReplacementReverted"
> = (draft, event, target) => {
  const replacementSeq = target.event.seq;
  const { matchId, outId, inId } = targetEvent(
    target,
    "PlayerReplaced",
  ).payload;
  const match = requireActiveMatchForUndo(draft, matchId);
  if (isSessionError(match)) return match;
  const inIndex = match.segments.findIndex(
    (segment) => segment.startedByReplacementSeq === replacementSeq,
  );
  const outIndex = match.segments.findIndex(
    (segment) => segment.endedMidMatchBySeq === replacementSeq,
  );
  if (inIndex === -1 || outIndex === -1) {
    return sessionError(
      "TARGET_MISMATCH",
      "That replacement is not in this match.",
    );
  }
  if (match.segments[inIndex].endedMidMatchBySeq !== null) {
    return sessionError(
      "UNDO_BLOCKED",
      `${draft.participantLabel(inId)} has been replaced or removed since; undo that first.`,
    );
  }
  const blocker = returnToCourtBlocker(
    draft,
    outId,
    replacementSeq,
    "replaced",
  );
  if (blocker) return blocker;

  const segments = putBackOnCourt(draft, match, outIndex).filter(
    (_, index) => index !== inIndex,
  );
  draft.set("matches", matchId, { ...match, segments });
  const incoming = draft.next.participants[inId];
  const stillHasSegmentInMatch = segments.some(
    (segment) => segment.participantId === inId,
  );
  draft.set("participants", inId, {
    ...incoming,
    activeMatchId: null,
    matchIds: stillHasSegmentInMatch
      ? incoming.matchIds
      : incoming.matchIds.filter((id) => id !== matchId),
  });
  return null;
};

export const handlePlayerRemovalReverted: EventHandler<
  "PlayerRemovalReverted"
> = (draft, event, target) => {
  const removalSeq = target.event.seq;
  const { matchId, participantId } = targetEvent(
    target,
    "PlayerRemovedMidMatch",
  ).payload;
  const match = requireActiveMatchForUndo(draft, matchId);
  if (isSessionError(match)) return match;
  const seatIndex = match.segments.findIndex(
    (segment) => segment.endedMidMatchBySeq === removalSeq,
  );
  if (seatIndex === -1) {
    return sessionError(
      "TARGET_MISMATCH",
      "That removal is not in this match.",
    );
  }
  const blocker = returnToCourtBlocker(
    draft,
    participantId,
    removalSeq,
    "removed",
  );
  if (blocker) return blocker;

  draft.set("matches", matchId, {
    ...match,
    segments: putBackOnCourt(draft, match, seatIndex),
  });
  return null;
};
