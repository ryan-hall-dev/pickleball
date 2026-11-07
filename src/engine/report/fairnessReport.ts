// Fairness reporting (plan §5.7): measures how fair a session has been,
// independently of the scheduler that made the decisions. Never imported by
// `../schedule`.
import {
  courtMetrics,
  playerMetrics,
  type EpochMs,
  type ParticipantId,
  type SessionState,
} from "../session";

const MINUTE_MS = 60_000;
/** Fewer participants than this and Jain's index is shown as "—". */
const MINIMUM_PLAYERS_FOR_INDEX = 2;

export interface SummaryStatistics {
  min: number;
  mean: number;
  max: number;
  /** Population standard deviation. */
  standardDeviation: number;
}

export interface PlayerFairness {
  participantId: ParticipantId;
  gamesCompleted: number;
  /** Fair-share expectation for the time present: `e_i = (Σg / Σp) · p_i`. */
  fairShareGames: number;
  /** `e_i − g_i`: positive means behind their fair share (m3). */
  gamesBehindFairShare: number;
  presentMs: number;
  playMs: number;
  totalWaitMs: number;
}

export interface FairnessReport {
  /** Everyone who joined the session at least once, including those who left. */
  playerCount: number;
  /** Null with no players. */
  games: (SummaryStatistics & { spread: number }) | null;
  playingTimeMs: SummaryStatistics | null;
  /** Over players waiting right now; null when nobody is waiting. */
  currentWaitMs: { mean: number; max: number } | null;
  accumulatedWaitMs: SummaryStatistics | null;
  /** Court time in use ÷ court time available (pauses and closures excluded), 0-1. Null before any court time. */
  courtUtilisation: number | null;
  /** Jain's index on games vs fair share, 0-100. Null ("—") before any completed game or with fewer than 2 players. */
  jainGamesIndex: number | null;
  /** Jain's index on playing time vs fair share, 0-100. Same null rule. */
  jainPlayTimeIndex: number | null;
  players: PlayerFairness[];
}

export function summarise(values: readonly number[]): SummaryStatistics | null {
  if (values.length === 0) return null;
  let total = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    total += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const mean = total / values.length;
  let squaredDeviations = 0;
  for (const value of values) squaredDeviations += (value - mean) ** 2;
  return {
    min,
    mean,
    max,
    standardDeviation: Math.sqrt(squaredDeviations / values.length),
  };
}

/** Jain's fairness index `(Σx)² / (n·Σx²) × 100`: 100 is perfectly even, 100/n the least. */
export function jainIndex(values: readonly number[]): number {
  let total = 0;
  let totalOfSquares = 0;
  for (const value of values) {
    total += value;
    totalOfSquares += value * value;
  }
  if (totalOfSquares === 0) return 100;
  return ((total * total) / (values.length * totalOfSquares)) * 100;
}

/**
 * Jain's index on `(actual + 1) / (expected + 1)`: the +1 keeps players who
 * have just arrived from distorting it.
 */
function jainVsFairShare(actual: number[], expected: number[]): number {
  return jainIndex(
    actual.map((value, index) => (value + 1) / (expected[index] + 1)),
  );
}

/** The fairness report at `now` (server epoch ms). */
export function buildFairnessReport(
  state: SessionState,
  now: EpochMs,
): FairnessReport {
  const metrics = playerMetrics(state, now);
  const slotMs = state.config
    ? (state.config.targetMatchMinutes + state.config.changeoverMinutes) *
      MINUTE_MS
    : MINUTE_MS;

  let totalGames = 0;
  let totalPresentMs = 0;
  let totalPlayMs = 0;
  for (const player of metrics) {
    totalGames += player.gamesCompleted;
    totalPresentMs += player.presentMs;
    totalPlayMs += player.playMs;
  }
  const gamesPerPresentMs =
    totalPresentMs === 0 ? 0 : totalGames / totalPresentMs;
  const playPerPresentMs =
    totalPresentMs === 0 ? 0 : totalPlayMs / totalPresentMs;

  const players: PlayerFairness[] = metrics.map((player) => {
    const fairShareGames = gamesPerPresentMs * player.presentMs;
    return {
      participantId: player.participantId,
      gamesCompleted: player.gamesCompleted,
      fairShareGames,
      gamesBehindFairShare: fairShareGames - player.gamesCompleted,
      presentMs: player.presentMs,
      playMs: player.playMs,
      totalWaitMs: player.totalWaitMs,
    };
  });

  const gameStatistics = summarise(
    players.map((player) => player.gamesCompleted),
  );
  const currentWaits = metrics
    .map((player) => player.currentWaitMs)
    .filter((wait): wait is number => wait !== null);
  const currentWaitStatistics = summarise(currentWaits);

  let openMs = 0;
  let busyMs = 0;
  for (const court of courtMetrics(state, now)) {
    openMs += court.openMs;
    busyMs += court.busyMs;
  }

  const hasIndex =
    totalGames > 0 && players.length >= MINIMUM_PLAYERS_FOR_INDEX;
  return {
    playerCount: players.length,
    games: gameStatistics && {
      ...gameStatistics,
      spread: gameStatistics.max - gameStatistics.min,
    },
    playingTimeMs: summarise(players.map((player) => player.playMs)),
    currentWaitMs: currentWaitStatistics && {
      mean: currentWaitStatistics.mean,
      max: currentWaitStatistics.max,
    },
    accumulatedWaitMs: summarise(players.map((player) => player.totalWaitMs)),
    courtUtilisation: openMs === 0 ? null : busyMs / openMs,
    jainGamesIndex: hasIndex
      ? jainVsFairShare(
          players.map((player) => player.gamesCompleted),
          players.map((player) => player.fairShareGames),
        )
      : null,
    jainPlayTimeIndex: hasIndex
      ? jainVsFairShare(
          players.map((player) => player.playMs / slotMs),
          players.map(
            (player) => (playPerPresentMs * player.presentMs) / slotMs,
          ),
        )
      : null,
    players,
  };
}
