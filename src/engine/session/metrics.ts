// Derived measurements at a moment in time. Every duration excludes paused
// time; nothing accrues after the session ends.
import { isSimpleSocial } from "./simplePolicy";
import { compensationTargetSeq, type SessionEventType } from "./events";
import { intervalsFrom, measureMs } from "./intervals";
import {
  creditedParticipantIds,
  currentLineup,
  isCourtClosed,
  isPresent,
  isSkipped,
  type CourtState,
  type MatchState,
  type MatchStatus,
  type ParticipantState,
  type SessionPhase,
  type SessionState,
} from "./state";
import type {
  ActorId,
  CourtConfig,
  CourtId,
  EpochMs,
  EventId,
  MatchId,
  Participant,
  ParticipantId,
  TimeInterval,
} from "./types";

/** `away` = left the session (they keep their stats and can rejoin). */
export type PlayerStatus = "waiting" | "playing" | "skipped" | "away";

export interface PlayerMetrics {
  participantId: ParticipantId;
  participant: Participant;
  status: PlayerStatus;
  /** Games credited from completed matches. */
  gamesCompleted: number;
  /** `gamesCompleted` plus games they will be credited with when their active match completes. */
  committedGames: number;
  /** Time present, excluding paused, skipped and away time. Always `playMs + totalWaitMs`. */
  presentMs: number;
  /** Time on court (including partial games before a replacement, and abandoned matches). */
  playMs: number;
  /** Present, not playing, not skipped time. */
  totalWaitMs: number;
  /**
   * When the current wait began: their last time off court, or their latest
   * `PlayerJoined` (session start for initial attendees), whichever is later.
   * Also retained while resting in simple-social sessions; otherwise null unless waiting.
   */
  currentWaitStartAt: EpochMs | null;
  /** Waiting time since `currentWaitStartAt`, excluding paused, skipped and away time. Frozen during simple-social rest; otherwise null unless waiting. */
  currentWaitMs: number | null;
  /** Last time they came off court (completed, abandoned or replaced out); null if never. */
  lastMatchEndAt: EpochMs | null;
  /** First arrival in the session. */
  joinedAt: EpochMs;
  /** Times partnered, from completed and in-progress matches (final lineups). */
  partnerCounts: Record<ParticipantId, number>;
  /** Times faced, from completed and in-progress matches (final lineups). */
  opponentCounts: Record<ParticipantId, number>;
  /** End time of each credited completed game, ascending (for recent-participation decay). */
  completedGameEndTimes: EpochMs[];
  isLocked: boolean;
  /** Court of the lock; null when unlocked or locked to any court. */
  lockedCourtId: CourtId | null;
  /** Position in the host's manual order (0 = first), or null. Ranks can have gaps. */
  manualQueueRank: number | null;
  currentMatchId: MatchId | null;
  currentCourtId: CourtId | null;
}

/** The moment metrics are measured at: never before the last event, never after the end. */
function measurementTime(state: SessionState, now: EpochMs): EpochMs {
  if (state.endedAt !== null) return state.endedAt;
  return Math.max(now, state.lastAt ?? now);
}

function playerStatus(
  participantState: ParticipantState,
  now: number,
): PlayerStatus {
  if (!isPresent(participantState)) return "away";
  if (participantState.activeMatchId !== null) return "playing";
  if (isSkipped(participantState, now)) return "skipped";
  return "waiting";
}

function increment(counts: Record<ParticipantId, number>, id: ParticipantId) {
  counts[id] = (counts[id] ?? 0) + 1;
}

function participantMetrics(
  state: SessionState,
  participantState: ParticipantState,
  until: EpochMs,
): PlayerMetrics {
  const participantId = participantState.participant.participantId;
  const pausedOrSkipped: TimeInterval[] = [
    ...state.pauses,
    ...participantState.skips.map((skip) => ({
      from: skip.from,
      to:
        skip.returnsAt === undefined
          ? skip.to
          : Math.min(skip.to ?? Infinity, skip.returnsAt),
    })),
  ];
  const presentMs = measureMs(
    participantState.presence,
    until,
    pausedOrSkipped,
  );

  const playIntervals: TimeInterval[] = [];
  const partnerCounts: Record<ParticipantId, number> = {};
  const opponentCounts: Record<ParticipantId, number> = {};
  const completedGameEndTimes: EpochMs[] = [];
  let gamesCompleted = 0;
  let committedGames = 0;
  let lastMatchEndAt: EpochMs | null = null;
  for (const matchId of participantState.matchIds) {
    const match = state.matches[matchId];
    for (const segment of match.segments) {
      if (segment.participantId !== participantId) continue;
      playIntervals.push(segment);
      if (segment.to !== null && (lastMatchEndAt ?? -Infinity) < segment.to) {
        lastMatchEndAt = segment.to;
      }
    }
    if (creditedParticipantIds(match).includes(participantId)) {
      if (match.status !== "abandoned") committedGames += 1;
      if (match.status === "completed" && match.endedAt !== null) {
        gamesCompleted += 1;
        completedGameEndTimes.push(match.endedAt);
      }
    }
    if (match.status === "abandoned") continue;
    const lineup = currentLineup(match);
    const ownSeat = lineup.find(
      (segment) => segment.participantId === participantId,
    );
    if (!ownSeat) continue;
    for (const segment of lineup) {
      if (segment.participantId === participantId) continue;
      increment(
        segment.team === ownSeat.team ? partnerCounts : opponentCounts,
        segment.participantId,
      );
    }
  }
  const playMs = measureMs(playIntervals, until, state.pauses);
  completedGameEndTimes.sort((left, right) => left - right);

  const status = playerStatus(participantState, until);
  let currentWaitStartAt: EpochMs | null = null;
  let currentWaitMs: number | null = null;
  if (
    status === "waiting" ||
    (status === "skipped" && isSimpleSocial(state.config))
  ) {
    const latestJoin = participantState.presence.findLast(
      (interval) => interval.startKind === "joined",
    );
    currentWaitStartAt = Math.max(
      latestJoin?.from ?? -Infinity,
      lastMatchEndAt ?? -Infinity,
    );
    currentWaitMs = measureMs(
      intervalsFrom(participantState.presence, currentWaitStartAt),
      until,
      pausedOrSkipped,
    );
  }

  const lock = participantState.lock;
  const manualQueueRank = state.queueOrder.indexOf(participantId);
  const currentMatch =
    participantState.activeMatchId === null
      ? undefined
      : state.matches[participantState.activeMatchId];
  return {
    participantId,
    participant: participantState.participant,
    status,
    gamesCompleted,
    committedGames,
    presentMs,
    playMs,
    totalWaitMs: presentMs - playMs,
    currentWaitStartAt,
    currentWaitMs,
    lastMatchEndAt,
    joinedAt: participantState.presence[0].from,
    partnerCounts,
    opponentCounts,
    completedGameEndTimes,
    isLocked: lock !== null,
    lockedCourtId: lock?.courtId ?? null,
    manualQueueRank: manualQueueRank === -1 ? null : manualQueueRank,
    currentMatchId: currentMatch?.matchId ?? null,
    currentCourtId: currentMatch?.courtId ?? null,
  };
}

/** Per-participant measurements at `now` (epoch ms, server time), in join order. Empty before the session starts. */
export function playerMetrics(
  state: SessionState,
  now: EpochMs,
): PlayerMetrics[] {
  const until = measurementTime(state, now);
  return Object.values(state.participants).map((participantState) =>
    participantMetrics(state, participantState, until),
  );
}

export interface SessionClock {
  phase: SessionPhase;
  startedAt: EpochMs | null;
  endedAt: EpochMs | null;
  isPaused: boolean;
  /** Start of the current pause, or null. */
  pausedSince: EpochMs | null;
  /** Session time so far, excluding pauses. */
  elapsedMs: number;
  /** Total paused time so far. */
  pausedMs: number;
  plannedMs: number;
  /** `plannedMs − elapsedMs`; negative once the session overruns. */
  remainingMs: number;
}

export function sessionClock(state: SessionState, now: EpochMs): SessionClock {
  const until = measurementTime(state, now);
  const plannedMs = (state.config?.plannedDurationMinutes ?? 0) * 60_000;
  const sessionSpan: TimeInterval[] =
    state.startedAt === null
      ? []
      : [{ from: state.startedAt, to: state.endedAt }];
  const elapsedMs = measureMs(sessionSpan, until, state.pauses);
  const currentPause =
    state.pausedBySeq === null ? undefined : state.pauses.at(-1);
  return {
    phase: state.phase,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    isPaused: currentPause !== undefined,
    pausedSince: currentPause?.from ?? null,
    elapsedMs,
    pausedMs: measureMs(state.pauses, until),
    plannedMs,
    remainingMs: plannedMs - elapsedMs,
  };
}

export type CourtStatus = "free" | "busy" | "closed";

export interface CourtMetrics {
  courtId: CourtId;
  court: CourtConfig;
  status: CourtStatus;
  currentMatchId: MatchId | null;
  /** Active (unpaused) time of the current match, or null. */
  currentMatchElapsedMs: number | null;
  /** Time available for play since the court was added, excluding pauses and closures. */
  openMs: number;
  /** Time with a match on it (any status), excluding pauses. */
  busyMs: number;
}

function matchActiveMs(
  state: SessionState,
  match: MatchState,
  until: EpochMs,
): number {
  return measureMs(
    [{ from: match.startedAt, to: match.endedAt }],
    until,
    state.pauses,
  );
}

function courtMetricsFor(
  state: SessionState,
  courtState: CourtState,
  until: EpochMs,
): CourtMetrics {
  const currentMatch =
    courtState.activeMatchId === null
      ? undefined
      : state.matches[courtState.activeMatchId];
  let status: CourtStatus = "free";
  if (currentMatch) status = "busy";
  else if (isCourtClosed(courtState)) status = "closed";
  return {
    courtId: courtState.court.courtId,
    court: courtState.court,
    status,
    currentMatchId: currentMatch?.matchId ?? null,
    currentMatchElapsedMs: currentMatch
      ? matchActiveMs(state, currentMatch, until)
      : null,
    openMs: measureMs([{ from: courtState.addedAt, to: null }], until, [
      ...state.pauses,
      ...courtState.closures,
    ]),
    busyMs: courtState.matchIds.reduce(
      (total, matchId) =>
        total + matchActiveMs(state, state.matches[matchId], until),
      0,
    ),
  };
}

/** Per-court status and usage at `now`, in the order courts were added. */
export function courtMetrics(
  state: SessionState,
  now: EpochMs,
): CourtMetrics[] {
  const until = measurementTime(state, now);
  return Object.values(state.courts).map((courtState) =>
    courtMetricsFor(state, courtState, until),
  );
}

export interface MatchRecordSegment {
  participantId: ParticipantId;
  team: "A" | "B";
  from: EpochMs;
  to: EpochMs | null;
  playMs: number;
  /** Replaced or removed before the match ended. */
  endedMidMatch: boolean;
  countGameForOut: boolean;
}

/**
 * Status to write to the match's `matches` row (one row per match id), or null
 * when it has no row: a match gets a row when it first ends, and an undone
 * completion or abandonment marks it `reverted` until it ends again. If the
 * start is then undone too, the match leaves `matchRecords` and its row simply
 * stays `reverted`.
 */
export type MatchesRowStatus = "completed" | "abandoned" | "reverted";

/** One match as it would be stored in the `matches` table (undone starts are omitted). */
export interface MatchRecord {
  matchId: MatchId;
  courtId: CourtId;
  courtName: string;
  status: MatchStatus;
  /** See `MatchesRowStatus`; null while in progress and never ended. */
  matchesRowStatus: MatchesRowStatus | null;
  /** Lineup at the end (or now, if active). */
  teamA: ParticipantId[];
  teamB: ParticipantId[];
  startedAt: EpochMs;
  endedAt: EpochMs | null;
  /** Unpaused duration (so far, if active). */
  activeDurationMs: number;
  /** Players credited with a game (only counts once the match is completed). */
  creditedParticipantIds: ParticipantId[];
  segments: MatchRecordSegment[];
}

/** Ids of matches whose completion or abandonment was undone at least once (ids are never reused). */
function matchIdsWithUndoneEnd(state: SessionState): Set<MatchId> {
  const matchIds = new Set<MatchId>();
  for (const { event, compensatedBySeq } of state.history) {
    if (compensatedBySeq === null) continue;
    if (event.type === "MatchCompleted" || event.type === "MatchAbandoned") {
      matchIds.add(event.payload.matchId);
    }
  }
  return matchIds;
}

function matchesRowStatus(
  match: MatchState,
  hadEndUndone: boolean,
): MatchesRowStatus | null {
  if (match.status !== "active") return match.status;
  return hadEndUndone ? "reverted" : null;
}

/** Every match in start order, at `now`. */
export function matchRecords(state: SessionState, now: EpochMs): MatchRecord[] {
  const until = measurementTime(state, now);
  const endUndoneMatchIds = matchIdsWithUndoneEnd(state);
  return Object.values(state.matches)
    .sort((left, right) => left.startedBySeq - right.startedBySeq)
    .map((match) => {
      const lineup = currentLineup(match);
      const teamIds = (team: "A" | "B") =>
        lineup
          .filter((segment) => segment.team === team)
          .map((segment) => segment.participantId);
      return {
        matchId: match.matchId,
        courtId: match.courtId,
        courtName: state.courts[match.courtId]?.court.name ?? "",
        status: match.status,
        matchesRowStatus: matchesRowStatus(
          match,
          endUndoneMatchIds.has(match.matchId),
        ),
        teamA: teamIds("A"),
        teamB: teamIds("B"),
        startedAt: match.startedAt,
        endedAt: match.endedAt,
        activeDurationMs: matchActiveMs(state, match, until),
        creditedParticipantIds: creditedParticipantIds(match),
        segments: match.segments.map((segment) => ({
          participantId: segment.participantId,
          team: segment.team,
          from: segment.from,
          to: segment.to,
          playMs: measureMs([segment], until, state.pauses),
          endedMidMatch: segment.endedMidMatchBySeq !== null,
          countGameForOut: segment.countGameForOut,
        })),
      };
    });
}

export interface ActionHistoryItem {
  seq: number;
  eventId: EventId;
  type: SessionEventType;
  actorId: ActorId;
  at: EpochMs;
  /** For an undo: the action it undid. */
  targetSeq: number | null;
  /** For a match-start undo that names its match: which one. Always set when undoing a match started with the session (whose target is the SessionStarted). */
  targetMatchId: MatchId | null;
  /** The undo that reversed this action, if any. Never set on SessionStarted: its first matches are undone one by one. */
  compensatedBySeq: number | null;
}

/** Who did what, oldest first. */
export function actionHistory(state: SessionState): ActionHistoryItem[] {
  return state.history.map(({ event, compensatedBySeq }) => ({
    seq: event.seq,
    eventId: event.eventId,
    type: event.type,
    actorId: event.actorId,
    at: event.at,
    targetSeq: compensationTargetSeq(event),
    targetMatchId:
      event.type === "MatchStartReverted"
        ? (event.payload.matchId ?? null)
        : null,
    compensatedBySeq,
  }));
}
