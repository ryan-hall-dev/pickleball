// The session action log: one event per host action. Rows are append-only;
// undo appends a compensating event that names its `targetSeq`.
import type {
  ActorId,
  CourtConfig,
  CourtId,
  EpochMs,
  EventId,
  MatchId,
  Participant,
  ParticipantId,
  SessionConfig,
} from "./types";

/** Why a simple-social-v2 player is paused. */
export type SkipReason = "break" | "noReply";

/** Payload of every pure compensating event: which action it undoes. */
export interface CompensationPayload {
  /** Seq of the action being undone. */
  targetSeq: number;
}

/** A match assignment: team A and team B, each `k / 2` participant ids. */
export interface MatchAssignment {
  matchId: MatchId;
  courtId: CourtId;
  teamA: ParticipantId[];
  teamB: ParticipantId[];
  /** Required when consuming a called group; omitted in historical/direct starts. */
  calledEventId?: EventId;
}

/** Payload of each event type, keyed by the event `type`. */
export interface SessionEventPayloads {
  /** Must be the first event. Not reversible. */
  SessionStarted: {
    config: SessionConfig;
    /** Participants present at start; each must be in `config.participants`. */
    initialAttendeeIds: ParticipantId[];
    /**
     * Matches started together with the session. Each can be undone on its own
     * with a `MatchStartReverted` naming it (see there); the start itself can't.
     */
    initialMatches?: MatchAssignment[];
  };
  /** A participant arrives (late check-in) or comes back after leaving. Starts a new wait. */
  PlayerJoined: { participant: Participant };
  PlayerJoinReverted: CompensationPayload;
  /** A participant leaves (the host's "remove"). Not allowed while playing. */
  PlayerLeft: { participantId: ParticipantId };
  PlayerLeaveReverted: CompensationPayload;
  /**
   * Skip until un-skipped. Skipped time is not presence. Not allowed while playing.
   * simple-social-v1: a ten-minute rest (`returnsAt`). simple-social-v2: an
   * open break until the player or a host says Ready (no `returnsAt`), with
   * why: the player's own break, or paused by a host for not replying.
   */
  PlayerSkipped: {
    participantId: ParticipantId;
    returnsAt?: EpochMs;
    reason?: SkipReason;
  };
  /** Ends a skip (the host's "un-skip" and the undo of a skip are the same action). */
  PlayerUnskipped: CompensationPayload;
  /** Pins a participant to the next match, optionally on one court. Consumed when they start a match. */
  PlayerLocked: { participantId: ParticipantId; courtId?: CourtId };
  PlayerUnlocked: CompensationPayload;
  CourtAdded: { court: CourtConfig };
  CourtAddReverted: CompensationPayload;
  /** Closing requires the court to be free. */
  CourtClosed: { courtId: CourtId };
  CourtReopened: CompensationPayload;
  NextGroupCalled: {
    courtId: CourtId;
    teamA: ParticipantId[];
    teamB: ParticipantId[];
  };
  NextGroupChanged: {
    calledEventId: EventId;
    teamA: ParticipantId[];
    teamB: ParticipantId[];
  };
  NextGroupReleased: { calledEventId: EventId };
  /**
   * simple-social-v2: a player in an Up next group says they're ready (or a
   * host confirms them in person). Only someone in the group now; a
   * replacement starts unconfirmed.
   */
  NextGroupSeatConfirmed: {
    calledEventId: EventId;
    participantId: ParticipantId;
  };
  /**
   * simple-social-v2: a host moves an Up next group to another open court with
   * no game in progress; if that court has a group, the two swap. Confirmations
   * move with their group.
   */
  NextGroupMoved: { calledEventId: EventId; toCourtId: CourtId };
  /**
   * simple-social-v2: "Close after this game". The court's Up next group goes
   * back to Ready (wait kept) and nothing new is prepared there; the court
   * closes when its game ends. Requires a game in progress.
   */
  CourtCloseScheduled: { courtId: CourtId };
  CourtCloseCancelled: CompensationPayload;
  /**
   * simple-social-v2 friend pair (D4): `participantId` asks `friendId` to be
   * on the same team for their next game. Both must be Ready and in no other
   * pair or request.
   */
  FriendPairRequested: {
    participantId: ParticipantId;
    friendId: ParticipantId;
  };
  /** The friend agrees; the pair waits as one, ranked by the shorter wait. */
  FriendPairAccepted: { requestSeq: number };
  /** Declined, cancelled, or ended by a host. A break or leaving ends it by itself. */
  FriendPairEnded: { requestSeq: number };
  MatchStarted: MatchAssignment;
  /**
   * Undoes a match start: `targetSeq` is the `MatchStarted`, or, for a match
   * started with the session, the `SessionStarted` seq plus that match's
   * `matchId`. Undoing one first match leaves the SessionStarted (and its other
   * matches) in force, so that history entry is never marked compensated; the
   * match's absence from state is what makes a second undo of it fail.
   */
  MatchStartReverted: CompensationPayload & { matchId?: MatchId };
  MatchCompleted: { matchId: MatchId };
  MatchCompletionReverted: CompensationPayload;
  /**
   * `outId` leaves the match mid-game and `inId` takes the same seat. `outId`
   * keeps the partial play time; they are credited with a game when the match
   * completes only if `countGameForOut` is true.
   */
  PlayerReplaced: {
    matchId: MatchId;
    outId: ParticipantId;
    inId: ParticipantId;
    countGameForOut: boolean;
  };
  PlayerReplacementReverted: CompensationPayload;
  /**
   * `participantId` leaves the match mid-game and nobody takes their seat (e.g.
   * an injury with no one free). The match carries on short-handed until it is
   * completed or abandoned; the empty seat stays empty. They keep the partial
   * play time and are credited with a game when the match completes only if
   * `countGameForOut` is true ("count this game"). The last player on court
   * can't be removed: abandon the match instead.
   */
  PlayerRemovedMidMatch: {
    matchId: MatchId;
    participantId: ParticipantId;
    countGameForOut: boolean;
  };
  PlayerRemovalReverted: CompensationPayload;
  /** Ends a match without credit: play time counts, games don't. */
  MatchAbandoned: { matchId: MatchId };
  MatchAbandonReverted: CompensationPayload;
  /**
   * Host's manual priority order (most urgent first). A participant's rank
   * lasts until they next start a match. As an undo it carries `targetSeq` and
   * the order that was in place before the target.
   */
  QueueReordered: { participantIds: ParticipantId[]; targetSeq?: number };
  /** New seed for the suggestions. As an undo it carries `targetSeq` and the previous seed. */
  SuggestionsShuffled: { seed: number; targetSeq?: number };
  /** As an undo of a `Resumed` it carries `targetSeq`. */
  Paused: { targetSeq?: number };
  /** As an undo of a `Paused` it carries `targetSeq`. */
  Resumed: { targetSeq?: number };
  /** Requires no match in progress. Not reversible. */
  SessionEnded: Record<string, never>;
}

export type SessionEventType = keyof SessionEventPayloads;

/** The envelope shared by every event (`session_events` row). */
export interface SessionEventEnvelope<
  TType extends SessionEventType = SessionEventType,
> {
  /** Strictly increasing within a session. */
  seq: number;
  eventId: EventId;
  /** Server time, epoch ms; never decreases along the log. */
  at: EpochMs;
  actorId: ActorId;
  type: TType;
  payload: SessionEventPayloads[TType];
}

/** One event of a specific type. */
export type SessionEventOf<TType extends SessionEventType> =
  SessionEventEnvelope<TType>;

/** The discriminated union of every session event. */
export type SessionEvent = {
  [TType in SessionEventType]: SessionEventEnvelope<TType>;
}[SessionEventType];

/** Envelope fields the caller supplies when building an event. */
export type EventMeta = Pick<
  SessionEvent,
  "seq" | "eventId" | "at" | "actorId"
>;

/** Compensating event type for each reversible action type. */
export const COMPENSATING_EVENT_TYPE = {
  PlayerJoined: "PlayerJoinReverted",
  PlayerLeft: "PlayerLeaveReverted",
  PlayerSkipped: "PlayerUnskipped",
  PlayerLocked: "PlayerUnlocked",
  CourtAdded: "CourtAddReverted",
  CourtClosed: "CourtReopened",
  CourtCloseScheduled: "CourtCloseCancelled",
  MatchStarted: "MatchStartReverted",
  MatchCompleted: "MatchCompletionReverted",
  PlayerReplaced: "PlayerReplacementReverted",
  PlayerRemovedMidMatch: "PlayerRemovalReverted",
  MatchAbandoned: "MatchAbandonReverted",
  QueueReordered: "QueueReordered",
  SuggestionsShuffled: "SuggestionsShuffled",
  Paused: "Resumed",
  Resumed: "Paused",
} as const satisfies Partial<Record<SessionEventType, SessionEventType>>;

/** Action types that can be undone (when not themselves an undo). */
export type ReversibleEventType = keyof typeof COMPENSATING_EVENT_TYPE;

/** The `targetSeq` of a compensating event, or null for an ordinary action. */
export function compensationTargetSeq(event: SessionEvent): number | null {
  const payload = event.payload as { targetSeq?: unknown };
  return typeof payload.targetSeq === "number" ? payload.targetSeq : null;
}

export function isReversibleEventType(
  type: SessionEventType,
): type is ReversibleEventType {
  return Object.prototype.hasOwnProperty.call(COMPENSATING_EVENT_TYPE, type);
}
