// The derived session state: `state = replay(events)`. Treat every value as
// immutable; `applyEvent` returns a new state and never mutates its input.
import type { SessionEvent } from "./events";
import type {
  CourtConfig,
  CourtId,
  EpochMs,
  MatchId,
  Participant,
  ParticipantId,
  SessionConfig,
  TimeInterval,
} from "./types";

export type SessionPhase = "notStarted" | "live" | "ended";

/** One stretch of presence. Closed by `PlayerLeft`. */
export interface PresenceInterval extends TimeInterval {
  /**
   * `joined` starts a fresh wait (session start or `PlayerJoined`).
   * `returned` (an undone leave) continues the wait from before they left.
   */
  startKind: "joined" | "returned";
  startedBySeq: number;
  endedBySeq: number | null;
}

/** A skip; `to: null` while still skipped. */
export interface SkipInterval extends TimeInterval {
  skippedBySeq: number;
}

export interface PlayerLock {
  /** Null = any court. */
  courtId: CourtId | null;
  lockedBySeq: number;
}

export interface ParticipantState {
  participant: Participant;
  /** Non-overlapping, in time order. The last one is open while present. */
  presence: PresenceInterval[];
  skips: SkipInterval[];
  lock: PlayerLock | null;
  activeMatchId: MatchId | null;
  /** Every match (active or finished) they have played in, in start order. */
  matchIds: MatchId[];
}

/** One player's time in one seat of a match. */
export interface PlaySegment extends TimeInterval {
  participantId: ParticipantId;
  team: "A" | "B";
  /** Seq of the `PlayerReplaced` that brought them in, or null for the starting lineup. */
  startedByReplacementSeq: number | null;
  /**
   * Seq of the `PlayerReplaced` or `PlayerRemovedMidMatch` that took them off
   * court before the match ended, or null if they stayed to the end.
   */
  endedMidMatchBySeq: number | null;
  /** For players taken off mid-match: whether they are credited with the game when the match completes. */
  countGameForOut: boolean;
}

export type MatchStatus = "active" | "completed" | "abandoned";

export interface MatchState {
  matchId: MatchId;
  courtId: CourtId;
  status: MatchStatus;
  startedAt: EpochMs;
  startedBySeq: number;
  endedAt: EpochMs | null;
  endedBySeq: number | null;
  segments: PlaySegment[];
  /** Locks used up by this match start, restored if the start is undone. */
  consumedLocks: Record<ParticipantId, PlayerLock>;
  /**
   * The manual order just before this start, kept only when it cleared a
   * starter's rank (else empty), so an undo can put each rank back after the
   * same neighbour rather than at a stale position.
   */
  queueOrderAtStart: ParticipantId[];
}

export interface ClosureInterval extends TimeInterval {
  closedBySeq: number;
}

export interface CourtState {
  court: CourtConfig;
  addedAt: EpochMs;
  addedBySeq: number;
  closures: ClosureInterval[];
  activeMatchId: MatchId | null;
  /** Every match (active or finished) played on this court, in start order. */
  matchIds: MatchId[];
}

export interface PauseInterval extends TimeInterval {
  pausedBySeq: number;
}

/** The parts of state an event replaced, kept so its undo can restore them. */
export interface HistoryBefore {
  queueOrder?: ParticipantId[];
  queueOrderSetBySeq?: number | null;
  suggestionSeed?: number;
  suggestionSeedSetBySeq?: number | null;
  pausedBySeq?: number | null;
  resumedBySeq?: number | null;
}

export interface HistoryEntry {
  event: SessionEvent;
  /** Seq of the event that undid this one, or null. */
  compensatedBySeq: number | null;
  before: HistoryBefore;
}

export interface SessionState {
  phase: SessionPhase;
  /** 0 before any event. */
  lastSeq: number;
  lastAt: EpochMs | null;
  /** Null until `SessionStarted`. */
  config: SessionConfig | null;
  startedAt: EpochMs | null;
  endedAt: EpochMs | null;
  pauses: PauseInterval[];
  /** Seq of the `Paused` currently in effect (null when running). */
  pausedBySeq: number | null;
  /** Seq of the `Resumed` that ended the latest pause (null if none, or paused). */
  resumedBySeq: number | null;
  /** Everyone who has joined the session at least once, in join order. */
  participants: Record<ParticipantId, ParticipantState>;
  courts: Record<CourtId, CourtState>;
  /** Every non-undone match, in start order. */
  matches: Record<MatchId, MatchState>;
  /**
   * Every match id ever started, including undone starts, so an id is never
   * reused (`matches` rows and history keep referring to it). Audit data: an
   * undone start leaves its id here.
   */
  startedMatchIds: Record<MatchId, true>;
  /** Host's manual order; may contain ids of players who have since left. */
  queueOrder: ParticipantId[];
  queueOrderSetBySeq: number | null;
  suggestionSeed: number;
  suggestionSeedSetBySeq: number | null;
  /** Every accepted event in seq order. */
  history: HistoryEntry[];
}

/** The state before any event. */
export function createInitialSessionState(): SessionState {
  return {
    phase: "notStarted",
    lastSeq: 0,
    lastAt: null,
    config: null,
    startedAt: null,
    endedAt: null,
    pauses: [],
    pausedBySeq: null,
    resumedBySeq: null,
    participants: {},
    courts: {},
    matches: {},
    startedMatchIds: {},
    queueOrder: [],
    queueOrderSetBySeq: null,
    suggestionSeed: 0,
    suggestionSeedSetBySeq: null,
    history: [],
  };
}

/** Index of the history entry for `seq`, or -1. Seqs are strictly increasing, so binary search. */
export function findHistoryIndex(state: SessionState, seq: number): number {
  let low = 0;
  let high = state.history.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const middleSeq = state.history[middle].event.seq;
    if (middleSeq === seq) return middle;
    if (middleSeq < seq) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

/** The history entry for `seq`, or undefined. */
export function findHistoryEntry(
  state: SessionState,
  seq: number,
): HistoryEntry | undefined {
  const index = findHistoryIndex(state, seq);
  return index === -1 ? undefined : state.history[index];
}

export function isPresent(participantState: ParticipantState): boolean {
  const last = participantState.presence[participantState.presence.length - 1];
  return last !== undefined && last.to === null;
}

export function isSkipped(participantState: ParticipantState): boolean {
  const last = participantState.skips[participantState.skips.length - 1];
  return last !== undefined && last.to === null;
}

export function isCourtClosed(courtState: CourtState): boolean {
  const last = courtState.closures[courtState.closures.length - 1];
  return last !== undefined && last.to === null;
}

/** Segments still on court (active match) or that finished with the match. */
export function currentLineup(match: MatchState): PlaySegment[] {
  return match.segments.filter(
    (segment) => segment.endedMidMatchBySeq === null,
  );
}

/** Players credited with a game if (or because) this match completes. */
export function creditedParticipantIds(match: MatchState): ParticipantId[] {
  const credited = new Set<ParticipantId>();
  for (const segment of match.segments) {
    if (segment.endedMidMatchBySeq === null || segment.countGameForOut) {
      credited.add(segment.participantId);
    }
  }
  return [...credited];
}

export function participantName(participant: Participant): string {
  return `${participant.firstName} ${participant.lastName}`.trim();
}

/** Seq of the event that put this segment's player on court. */
export function segmentStartSeq(
  match: MatchState,
  segment: PlaySegment,
): number {
  return segment.startedByReplacementSeq ?? match.startedBySeq;
}

/** Whether the participant went on court (in any match other than `ignoredMatchId`) after `seq`. */
export function hasPlayedSince(
  state: SessionState,
  participantState: ParticipantState,
  seq: number,
  ignoredMatchId?: MatchId,
): boolean {
  const participantId = participantState.participant.participantId;
  return participantState.matchIds.some((matchId) => {
    const match = state.matches[matchId];
    if (!match || matchId === ignoredMatchId) return false;
    return match.segments.some(
      (segment) =>
        segment.participantId === participantId &&
        segmentStartSeq(match, segment) > seq,
    );
  });
}
