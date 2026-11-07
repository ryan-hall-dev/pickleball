// Session lifecycle, pause, courts, queue order and suggestion seed.
import { targetEvent, type EventHandler, type StateDraft } from "./draft";
import { sessionError, type SessionError } from "./errors";
import { startMatch } from "./matchHandlers";
import { requireManualAssignments } from "./playerHandlers";
import { isCourtClosed, type HistoryEntry, type SessionState } from "./state";
import {
  PLAYERS_PER_MATCH,
  type CourtConfig,
  type ParticipantId,
  type SessionConfig,
} from "./types";

function isPositiveFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateCourt(court: CourtConfig): SessionError | null {
  if (typeof court?.courtId !== "string" || court.courtId === "") {
    return sessionError("INVALID_CONFIG", "Every court needs a courtId.");
  }
  if (!Object.prototype.hasOwnProperty.call(PLAYERS_PER_MATCH, court.format)) {
    return sessionError(
      "INVALID_CONFIG",
      `Court ${court.name} has an unknown format "${String(court.format)}".`,
    );
  }
  return null;
}

function validateConfig(
  config: SessionConfig,
  initialAttendeeIds: ParticipantId[],
): SessionError | null {
  if (!config || !Array.isArray(config.courts) || config.courts.length === 0) {
    return sessionError(
      "INVALID_CONFIG",
      "A session needs at least one court.",
    );
  }
  for (const court of config.courts) {
    const courtError = validateCourt(court);
    if (courtError) return courtError;
  }
  const courtIds = config.courts.map((court) => court.courtId);
  if (new Set(courtIds).size !== courtIds.length) {
    return sessionError("DUPLICATE_ID", "A court is listed twice.");
  }
  if (
    !isPositiveFinite(config.targetMatchMinutes) ||
    !isPositiveFinite(config.plannedDurationMinutes) ||
    !(
      typeof config.changeoverMinutes === "number" &&
      config.changeoverMinutes >= 0
    )
  ) {
    return sessionError(
      "INVALID_CONFIG",
      "Match length and session length must be positive, and changeover can't be negative.",
    );
  }
  const objectives = config.rotation?.objectiveOrder;
  if (
    !Array.isArray(objectives) ||
    new Set(objectives).size !== objectives.length
  ) {
    return sessionError(
      "INVALID_CONFIG",
      "Rotation objectives must be a list without repeats.",
    );
  }
  if (!Array.isArray(config.participants)) {
    return sessionError("INVALID_CONFIG", "The roster is missing.");
  }
  const rosterIds = new Set(
    config.participants.map((participant) => participant.participantId),
  );
  if (rosterIds.size !== config.participants.length) {
    return sessionError("DUPLICATE_ID", "A participant is listed twice.");
  }
  if (!Array.isArray(initialAttendeeIds)) {
    return sessionError("INVALID_CONFIG", "The attendee list is missing.");
  }
  if (new Set(initialAttendeeIds).size !== initialAttendeeIds.length) {
    return sessionError("DUPLICATE_ID", "An attendee is listed twice.");
  }
  const unknownAttendee = initialAttendeeIds.find((id) => !rosterIds.has(id));
  if (unknownAttendee !== undefined) {
    return sessionError(
      "UNKNOWN_PARTICIPANT",
      `Attendee ${unknownAttendee} is not in the roster.`,
    );
  }
  return null;
}

export const handleSessionStarted: EventHandler<"SessionStarted"> = (
  draft,
  event,
) => {
  const { config, initialAttendeeIds, initialMatches = [] } = event.payload;
  const configError = validateConfig(config, initialAttendeeIds);
  if (configError) return configError;

  const next = draft.next;
  next.phase = "live";
  next.config = config;
  next.startedAt = event.at;
  const rosterById = new Map(
    config.participants.map((participant) => [
      participant.participantId,
      participant,
    ]),
  );
  for (const participantId of initialAttendeeIds) {
    draft.set("participants", participantId, {
      participant: rosterById.get(participantId)!,
      presence: [
        {
          from: event.at,
          to: null,
          startKind: "joined",
          startedBySeq: event.seq,
          endedBySeq: null,
        },
      ],
      skips: [],
      lock: null,
      activeMatchId: null,
      matchIds: [],
    });
  }
  for (const court of config.courts) {
    draft.set("courts", court.courtId, {
      court,
      addedAt: event.at,
      addedBySeq: event.seq,
      closures: [],
      activeMatchId: null,
      matchIds: [],
    });
  }
  if (!Array.isArray(initialMatches)) {
    return sessionError("MALFORMED_EVENT", "initialMatches must be a list.");
  }
  for (const assignment of initialMatches) {
    const matchError = startMatch(draft, assignment, event);
    if (matchError) return matchError;
  }
  return null;
};

export const handleSessionEnded: EventHandler<"SessionEnded"> = (
  draft,
  event,
) => {
  const activeMatchCount = Object.values(draft.next.matches).filter(
    (match) => match.status === "active",
  ).length;
  if (activeMatchCount > 0) {
    return sessionError(
      "MATCHES_IN_PROGRESS",
      `${activeMatchCount} match${activeMatchCount === 1 ? " is" : "es are"} still in progress; complete or abandon ${activeMatchCount === 1 ? "it" : "them"} first.`,
    );
  }
  if (draft.next.pausedBySeq !== null) closeCurrentPause(draft, event.at);
  draft.next.pausedBySeq = null;
  draft.next.phase = "ended";
  draft.next.endedAt = event.at;
  return null;
};

function closeCurrentPause(draft: StateDraft, at: number): void {
  const pauses = [...draft.next.pauses];
  pauses[pauses.length - 1] = { ...pauses[pauses.length - 1], to: at };
  draft.next.pauses = pauses;
}

/** Undo pairing for Paused/Resumed: only the pause or resume currently in effect can be undone. */
function rememberPauseState(draft: StateDraft): void {
  draft.before = {
    pausedBySeq: draft.next.pausedBySeq,
    resumedBySeq: draft.next.resumedBySeq,
  };
}

function restorePauseState(draft: StateDraft, target: HistoryEntry): void {
  draft.next.pausedBySeq = target.before.pausedBySeq ?? null;
  draft.next.resumedBySeq = target.before.resumedBySeq ?? null;
}

export const handlePaused: EventHandler<"Paused"> = (draft, event, target) => {
  if (draft.next.pausedBySeq !== null) {
    return sessionError("SESSION_PAUSED", "The session is already paused.");
  }
  if (target && draft.next.resumedBySeq !== target.event.seq) {
    return sessionError(
      "UNDO_BLOCKED",
      "Only the latest resume can be undone.",
    );
  }
  rememberPauseState(draft);
  draft.next.pauses = [
    ...draft.next.pauses,
    { from: event.at, to: null, pausedBySeq: event.seq },
  ];
  if (target) {
    restorePauseState(draft, target);
  } else {
    draft.next.pausedBySeq = event.seq;
    draft.next.resumedBySeq = null;
  }
  return null;
};

export const handleResumed: EventHandler<"Resumed"> = (
  draft,
  event,
  target,
) => {
  if (draft.next.pausedBySeq === null) {
    return sessionError("SESSION_NOT_PAUSED", "The session is not paused.");
  }
  if (target && draft.next.pausedBySeq !== target.event.seq) {
    return sessionError(
      "UNDO_BLOCKED",
      "Only the pause currently in effect can be undone.",
    );
  }
  rememberPauseState(draft);
  closeCurrentPause(draft, event.at);
  if (target) {
    restorePauseState(draft, target);
  } else {
    draft.next.pausedBySeq = null;
    draft.next.resumedBySeq = event.seq;
  }
  return null;
};

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * The order an undone reorder brings back: the order before it, minus anyone
 * who has started a match since (a rank lasts until the player next starts a
 * match) and anyone no longer in the session (an undone first join).
 */
export function restorableQueueOrder(
  state: SessionState,
  target: HistoryEntry,
): ParticipantId[] {
  const targetSeq = target.event.seq;
  const startedMatchSince = new Set<ParticipantId>();
  for (const match of Object.values(state.matches)) {
    if (match.startedBySeq <= targetSeq) continue;
    for (const segment of match.segments) {
      if (segment.startedByReplacementSeq === null) {
        startedMatchSince.add(segment.participantId);
      }
    }
  }
  return (target.before.queueOrder ?? []).filter(
    (participantId) =>
      state.participants[participantId] !== undefined &&
      !startedMatchSince.has(participantId),
  );
}

export const handleQueueReordered: EventHandler<"QueueReordered"> = (
  draft,
  event,
  target,
) => {
  const { participantIds } = event.payload;
  if (!Array.isArray(participantIds)) {
    return sessionError("MALFORMED_EVENT", "participantIds must be a list.");
  }
  if (target) {
    if (draft.next.queueOrderSetBySeq !== target.event.seq) {
      return sessionError(
        "UNDO_BLOCKED",
        "A later reorder replaced this one; undo that first.",
      );
    }
    if (!sameOrder(participantIds, restorableQueueOrder(draft.next, target))) {
      return sessionError(
        "TARGET_MISMATCH",
        "An undo of a reorder must restore the previous order (minus players who have started a match since).",
      );
    }
  } else {
    const manualAssignmentsError = requireManualAssignments(draft);
    if (manualAssignmentsError) return manualAssignmentsError;
    if (new Set(participantIds).size !== participantIds.length) {
      return sessionError(
        "INVALID_QUEUE_ORDER",
        "A player appears twice in the order.",
      );
    }
    const unknownId = participantIds.find(
      (participantId) => !draft.next.participants[participantId],
    );
    if (unknownId !== undefined) {
      return sessionError(
        "UNKNOWN_PARTICIPANT",
        `${draft.participantLabel(unknownId)} is not in this session.`,
      );
    }
  }
  draft.before = {
    queueOrder: draft.next.queueOrder,
    queueOrderSetBySeq: draft.next.queueOrderSetBySeq,
  };
  draft.next.queueOrder = [...participantIds];
  draft.next.queueOrderSetBySeq = target
    ? (target.before.queueOrderSetBySeq ?? null)
    : event.seq;
  return null;
};

export const handleSuggestionsShuffled: EventHandler<"SuggestionsShuffled"> = (
  draft,
  event,
  target,
) => {
  const { seed } = event.payload;
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    return sessionError(
      "MALFORMED_EVENT",
      "The shuffle seed must be a number.",
    );
  }
  if (target) {
    if (draft.next.suggestionSeedSetBySeq !== target.event.seq) {
      return sessionError(
        "UNDO_BLOCKED",
        "A later shuffle replaced this one; undo that first.",
      );
    }
    if (seed !== target.before.suggestionSeed) {
      return sessionError(
        "TARGET_MISMATCH",
        "An undo of a shuffle must restore the previous seed.",
      );
    }
  }
  draft.before = {
    suggestionSeed: draft.next.suggestionSeed,
    suggestionSeedSetBySeq: draft.next.suggestionSeedSetBySeq,
  };
  draft.next.suggestionSeed = seed;
  draft.next.suggestionSeedSetBySeq = target
    ? (target.before.suggestionSeedSetBySeq ?? null)
    : event.seq;
  return null;
};

export const handleCourtAdded: EventHandler<"CourtAdded"> = (draft, event) => {
  const { court } = event.payload;
  const courtError = validateCourt(court);
  if (courtError) return courtError;
  if (draft.next.courts[court.courtId]) {
    return sessionError(
      "DUPLICATE_ID",
      `${draft.courtLabel(court.courtId)} is already in this session.`,
    );
  }
  draft.set("courts", court.courtId, {
    court,
    addedAt: event.at,
    addedBySeq: event.seq,
    closures: [],
    activeMatchId: null,
    matchIds: [],
  });
  return null;
};

export const handleCourtAddReverted: EventHandler<"CourtAddReverted"> = (
  draft,
  event,
  target,
) => {
  const { courtId } = targetEvent(target, "CourtAdded").payload.court;
  const courtState = draft.next.courts[courtId];
  if (!courtState || courtState.addedBySeq !== target.event.seq) {
    return sessionError(
      "UNKNOWN_COURT",
      `${draft.courtLabel(courtId)} is not in this session.`,
    );
  }
  const label = draft.courtLabel(courtId);
  if (courtState.matchIds.length > 0) {
    return sessionError(
      "UNDO_BLOCKED",
      `Matches have been played on ${label}; undo them first, or close the court instead.`,
    );
  }
  const lockedHere = Object.values(draft.next.participants).find(
    (participantState) => participantState.lock?.courtId === courtId,
  );
  if (lockedHere) {
    return sessionError(
      "UNDO_BLOCKED",
      `${draft.participantLabel(lockedHere.participant.participantId)} is locked to ${label}; unlock them first.`,
    );
  }
  // A lock used up by a match start comes back if that start is undone, so it
  // must not end up pointing at a court that no longer exists.
  const matchHoldingLockHere = Object.values(draft.next.matches).find((match) =>
    Object.values(match.consumedLocks).some((lock) => lock.courtId === courtId),
  );
  if (matchHoldingLockHere) {
    return sessionError(
      "UNDO_BLOCKED",
      `A player's lock to ${label} was used by the match on ${draft.courtLabel(matchHoldingLockHere.courtId)}; undo the match start on ${draft.courtLabel(matchHoldingLockHere.courtId)} first.`,
    );
  }
  draft.remove("courts", courtId);
  return null;
};

export const handleCourtClosed: EventHandler<"CourtClosed"> = (
  draft,
  event,
) => {
  const { courtId } = event.payload;
  const courtState = draft.next.courts[courtId];
  const label = draft.courtLabel(courtId);
  if (!courtState) {
    return sessionError("UNKNOWN_COURT", `${label} is not in this session.`);
  }
  if (isCourtClosed(courtState)) {
    return sessionError("COURT_CLOSED", `${label} is already closed.`);
  }
  if (courtState.activeMatchId !== null) {
    return sessionError(
      "COURT_BUSY",
      `${label} has a match in progress; complete or abandon it first.`,
    );
  }
  draft.set("courts", courtId, {
    ...courtState,
    closures: [
      ...courtState.closures,
      { from: event.at, to: null, closedBySeq: event.seq },
    ],
  });
  return null;
};

export const handleCourtReopened: EventHandler<"CourtReopened"> = (
  draft,
  event,
  target,
) => {
  const { courtId } = targetEvent(target, "CourtClosed").payload;
  const courtState = draft.next.courts[courtId];
  const label = draft.courtLabel(courtId);
  if (!courtState) {
    return sessionError("UNKNOWN_COURT", `${label} is not in this session.`);
  }
  const closures = [...courtState.closures];
  const lastClosure = closures[closures.length - 1];
  if (
    lastClosure?.closedBySeq !== target.event.seq ||
    lastClosure.to !== null
  ) {
    return sessionError(
      "COURT_NOT_CLOSED",
      `${label} is not closed by that action.`,
    );
  }
  closures[closures.length - 1] = { ...lastClosure, to: event.at };
  draft.set("courts", courtId, { ...courtState, closures });
  return null;
};
