// Presence, skip and lock events.
import { targetEvent, type EventHandler, type StateDraft } from "./draft";
import { sessionError, type SessionError } from "./errors";
import {
  hasPlayedSince,
  isCourtClosed,
  isPresent,
  isSkipped,
  type ParticipantState,
  type PresenceInterval,
} from "./state";
import { PLAYERS_PER_MATCH, type ParticipantId } from "./types";
import { invalidateCalledSeat } from "./calledGroupHandlers";
import {
  isSimpleSocial,
  isSimpleSocialV2,
  reservedCourtId,
  SIMPLE_SOCIAL_REST_MS,
  validateSimpleParticipant,
} from "./simplePolicy";

/** Looks up a participant who must be present, not playing and not skipped. */
export function requireAvailableParticipant(
  draft: StateDraft,
  participantId: ParticipantId,
  now: number = draft.next.lastAt ?? -Infinity,
): SessionError | ParticipantState {
  const participantState = draft.next.participants[participantId];
  if (!participantState) {
    return sessionError(
      "UNKNOWN_PARTICIPANT",
      `${draft.participantLabel(participantId)} is not in this session.`,
    );
  }
  const label = draft.participantLabel(participantId);
  if (!isPresent(participantState)) {
    return sessionError("PLAYER_NOT_PRESENT", `${label} has left the session.`);
  }
  if (participantState.activeMatchId !== null) {
    return sessionError(
      "PLAYER_PLAYING",
      `${label} is already playing on ${playingCourtLabel(draft, participantState)}.`,
    );
  }
  if (isSkipped(participantState, now)) {
    return sessionError("PLAYER_SKIPPED", `${label} is skipped.`);
  }
  return participantState;
}

export function isSessionError(
  value: SessionError | object,
): value is SessionError {
  return "code" in value && "message" in value;
}

function playingCourtLabel(
  draft: StateDraft,
  participantState: ParticipantState,
): string {
  const matchId = participantState.activeMatchId;
  const match = matchId === null ? undefined : draft.next.matches[matchId];
  return match ? draft.courtLabel(match.courtId) : "a court";
}

function requireKnownParticipant(
  draft: StateDraft,
  participantId: ParticipantId,
): SessionError | ParticipantState {
  return (
    draft.next.participants[participantId] ??
    sessionError(
      "UNKNOWN_PARTICIPANT",
      `${draft.participantLabel(participantId)} is not in this session.`,
    )
  );
}

export const handlePlayerJoined: EventHandler<"PlayerJoined"> = (
  draft,
  event,
) => {
  const { participant } = event.payload;
  if (
    typeof participant?.participantId !== "string" ||
    participant.participantId === ""
  ) {
    return sessionError("MALFORMED_EVENT", "PlayerJoined needs a participant.");
  }
  const existing = draft.next.participants[participant.participantId];
  if (isSimpleSocial(draft.next.config)) {
    const error = validateSimpleParticipant(participant);
    if (error) return error;
  }
  if (existing && isPresent(existing)) {
    return sessionError(
      "PLAYER_ALREADY_PRESENT",
      `${draft.participantLabel(participant.participantId)} is already in the session.`,
    );
  }
  const interval: PresenceInterval = {
    from: event.at,
    to: null,
    startKind: "joined",
    startedBySeq: event.seq,
    endedBySeq: null,
  };
  // A returning participant keeps their original snapshot and stats.
  draft.set(
    "participants",
    participant.participantId,
    existing
      ? { ...existing, presence: [...existing.presence, interval] }
      : {
          participant,
          presence: [interval],
          skips: [],
          lock: null,
          activeMatchId: null,
          matchIds: [],
        },
  );
  return null;
};

export const handlePlayerJoinReverted: EventHandler<"PlayerJoinReverted"> = (
  draft,
  event,
  target,
) => {
  const participantId = targetEvent(target, "PlayerJoined").payload.participant
    .participantId;
  const participantState = requireKnownParticipant(draft, participantId);
  if (isSessionError(participantState)) return participantState;
  const label = draft.participantLabel(participantId);
  const lastPresence =
    participantState.presence[participantState.presence.length - 1];
  if (reservedCourtId(draft.next, participantId, event.at) !== null) {
    return sessionError(
      "UNDO_BLOCKED",
      "Release this player's called group before undoing their arrival.",
    );
  }
  if (
    lastPresence?.startedBySeq !== target.event.seq ||
    lastPresence.to !== null
  ) {
    return sessionError(
      "UNDO_BLOCKED",
      `${label} has left since joining, so this join can no longer be undone.`,
    );
  }
  if (hasPlayedSince(draft.next, participantState, target.event.seq)) {
    return sessionError(
      "UNDO_BLOCKED",
      `${label} has played since joining; undo their matches first.`,
    );
  }
  // Only a skip or lock made since this join depends on it. One kept from an
  // earlier stay (a player can leave while skipped or locked) survives the undo.
  const joinSeq = target.event.seq;
  const lastSkip = participantState.skips[participantState.skips.length - 1];
  if (
    isSkipped(participantState, event.at) &&
    lastSkip.skippedBySeq > joinSeq
  ) {
    return sessionError("UNDO_BLOCKED", `Un-skip ${label} first.`);
  }
  if ((participantState.lock?.lockedBySeq ?? -1) > joinSeq) {
    return sessionError("UNDO_BLOCKED", `Unlock ${label} first.`);
  }
  const isFirstJoin = participantState.presence.length === 1;
  // A first-join undo removes the participant, so the manual order must not
  // still name them. After a rejoin they stay known, so a rank is harmless.
  if (isFirstJoin && draft.next.queueOrder.includes(participantId)) {
    return sessionError(
      "UNDO_BLOCKED",
      `${label} is in the manual queue order; undo that reorder or reorder without them first.`,
    );
  }
  if (isFirstJoin) {
    draft.remove("participants", participantId);
  } else {
    draft.set("participants", participantId, {
      ...participantState,
      presence: participantState.presence.slice(0, -1),
    });
  }
  return null;
};

export const handlePlayerLeft: EventHandler<"PlayerLeft"> = (draft, event) => {
  const { participantId } = event.payload;
  const participantState = requireKnownParticipant(draft, participantId);
  if (isSessionError(participantState)) return participantState;
  const label = draft.participantLabel(participantId);
  if (!isPresent(participantState)) {
    return sessionError("PLAYER_NOT_PRESENT", `${label} has already left.`);
  }
  if (participantState.activeMatchId !== null) {
    return sessionError(
      "PLAYER_PLAYING",
      `${label} is playing; replace them in their match first.`,
    );
  }
  const presence = [...participantState.presence];
  presence[presence.length - 1] = {
    ...presence[presence.length - 1],
    to: event.at,
    endedBySeq: event.seq,
  };
  draft.set("participants", participantId, { ...participantState, presence });
  invalidateCalledSeat(draft, participantId);
  return null;
};

export const handlePlayerLeaveReverted: EventHandler<"PlayerLeaveReverted"> = (
  draft,
  event,
  target,
) => {
  const { participantId } = targetEvent(target, "PlayerLeft").payload;
  const participantState = requireKnownParticipant(draft, participantId);
  if (isSessionError(participantState)) return participantState;
  const lastPresence =
    participantState.presence[participantState.presence.length - 1];
  if (lastPresence?.endedBySeq !== target.event.seq) {
    return sessionError(
      "PLAYER_ALREADY_PRESENT",
      `${draft.participantLabel(participantId)} has already rejoined.`,
    );
  }
  draft.set("participants", participantId, {
    ...participantState,
    presence: [
      ...participantState.presence,
      {
        from: event.at,
        to: null,
        startKind: "returned",
        startedBySeq: event.seq,
        endedBySeq: null,
      },
    ],
  });
  return null;
};

export const handlePlayerSkipped: EventHandler<"PlayerSkipped"> = (
  draft,
  event,
) => {
  const participantState = requireAvailableParticipant(
    draft,
    event.payload.participantId,
    event.at,
  );
  if (isSessionError(participantState)) return participantState;
  if (isSimpleSocialV2(draft.next.config)) {
    if (
      event.payload.returnsAt !== undefined ||
      (event.payload.reason !== "break" && event.payload.reason !== "noReply")
    )
      return sessionError(
        "MALFORMED_EVENT",
        "A break lasts until Ready and needs a reason (break or noReply).",
      );
  } else if (
    isSimpleSocial(draft.next.config) &&
    event.payload.returnsAt !== event.at + SIMPLE_SOCIAL_REST_MS
  ) {
    return sessionError("MALFORMED_EVENT", "Rest must last ten minutes.");
  }
  if (
    !isSimpleSocial(draft.next.config) &&
    event.payload.returnsAt !== undefined
  ) {
    return sessionError(
      "POLICY_ACTION_NOT_ALLOWED",
      "Timed rest requires the simple-social policy.",
    );
  }
  draft.set("participants", event.payload.participantId, {
    ...participantState,
    skips: [
      ...participantState.skips,
      {
        from: event.at,
        to: null,
        skippedBySeq: event.seq,
        ...(event.payload.returnsAt === undefined
          ? {}
          : { returnsAt: event.payload.returnsAt }),
        ...(isSimpleSocialV2(draft.next.config)
          ? { reason: event.payload.reason }
          : {}),
      },
    ],
  });
  invalidateCalledSeat(draft, event.payload.participantId);
  return null;
};

export const handlePlayerUnskipped: EventHandler<"PlayerUnskipped"> = (
  draft,
  event,
  target,
) => {
  const { participantId } = targetEvent(target, "PlayerSkipped").payload;
  const participantState = requireKnownParticipant(draft, participantId);
  if (isSessionError(participantState)) return participantState;
  const skips = [...participantState.skips];
  const lastSkip = skips[skips.length - 1];
  if (
    lastSkip?.skippedBySeq !== target.event.seq ||
    lastSkip.to !== null ||
    !isSkipped(participantState, event.at)
  ) {
    return sessionError(
      "PLAYER_NOT_SKIPPED",
      `${draft.participantLabel(participantId)} is not skipped by that action.`,
    );
  }
  skips[skips.length - 1] = { ...lastSkip, to: event.at };
  draft.set("participants", participantId, { ...participantState, skips });
  return null;
};

/** Locks and manual reordering are only allowed when the session's rotation rules allow them. */
export function requireManualAssignments(
  draft: StateDraft,
): SessionError | null {
  if (draft.next.config?.rotation.rules.allowManualAssignments === false) {
    return sessionError(
      "MANUAL_ASSIGNMENTS_OFF",
      "Manual assignments are switched off for this session.",
    );
  }
  return null;
}

export const handlePlayerLocked: EventHandler<"PlayerLocked"> = (
  draft,
  event,
) => {
  const { participantId, courtId } = event.payload;
  const manualAssignmentsError = requireManualAssignments(draft);
  if (manualAssignmentsError) return manualAssignmentsError;
  const participantState = requireKnownParticipant(draft, participantId);
  if (isSessionError(participantState)) return participantState;
  const label = draft.participantLabel(participantId);
  if (!isPresent(participantState)) {
    return sessionError("PLAYER_NOT_PRESENT", `${label} has left the session.`);
  }
  if (participantState.lock !== null) {
    return sessionError("PLAYER_LOCKED", `${label} is already locked.`);
  }
  if (courtId !== undefined) {
    const courtState = draft.next.courts[courtId];
    if (!courtState) {
      return sessionError(
        "UNKNOWN_COURT",
        `${draft.courtLabel(courtId)} is not in this session.`,
      );
    }
    if (isCourtClosed(courtState)) {
      return sessionError(
        "COURT_CLOSED",
        `${draft.courtLabel(courtId)} is closed; reopen it first.`,
      );
    }
    const seatCount = PLAYERS_PER_MATCH[courtState.court.format];
    const lockedToCourt = Object.values(draft.next.participants).filter(
      (other) => isPresent(other) && other.lock?.courtId === courtId,
    ).length;
    if (lockedToCourt >= seatCount) {
      return sessionError(
        "COURT_FULL",
        `${draft.courtLabel(courtId)} already has ${seatCount} locked players.`,
      );
    }
  }
  draft.set("participants", participantId, {
    ...participantState,
    lock: { courtId: courtId ?? null, lockedBySeq: event.seq },
  });
  return null;
};

export const handlePlayerUnlocked: EventHandler<"PlayerUnlocked"> = (
  draft,
  event,
  target,
) => {
  const { participantId } = targetEvent(target, "PlayerLocked").payload;
  const participantState = requireKnownParticipant(draft, participantId);
  if (isSessionError(participantState)) return participantState;
  if (participantState.lock?.lockedBySeq !== target.event.seq) {
    return sessionError(
      "PLAYER_NOT_LOCKED",
      `That lock on ${draft.participantLabel(participantId)} is no longer in effect (it is used up when they start a match).`,
    );
  }
  draft.set("participants", participantId, {
    ...participantState,
    lock: null,
  });
  return null;
};
