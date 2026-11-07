// Player measurements (plan §5.2) and the bounded priority score P (§5.3).
// Every measurement is in games or slots so the weights mean the same at any
// session length.
import { seededUnitValue } from "./seededRandom";
import type { ScheduleInput, SchedulePlayer } from "./types";
import {
  HOST_OVERRIDE_POINTS_PER_POSITION,
  JUST_CAME_OFF_SLOTS,
  RECENT_GAMES_HALF_LIFE_SLOTS,
  REST_CAP_SLOTS,
  TIE_BREAK_JITTER_POINTS,
  type ScoringWeights,
} from "./weights";

/** `sat(x, c) = c·tanh(x/c)`: linear near zero, levels off at ±c. */
export function saturate(value: number, cap: number): number {
  return cap * Math.tanh(value / cap);
}

/** A player's quantities at one evaluation moment (now or a forecast), in games and slots. */
export interface PlayerSnapshot {
  player: SchedulePlayer;
  gamesCompleted: number;
  presentSlots: number;
  playSlots: number;
  waitSlots: number;
  currentWaitSlots: number;
  /** Null if they have not played yet. */
  restSlots: number | null;
  /** Completed games with exponential decay (m8). */
  recentGames: number;
  /** Seeded tie-break jitter in points, fixed for the whole recommendation. */
  tieBreak: number;
}

export function decayFactor(elapsedSlots: number): number {
  return Math.pow(0.5, elapsedSlots / RECENT_GAMES_HALF_LIFE_SLOTS);
}

/** The player's snapshot at the input's moment. */
export function snapshotAtNow(
  player: SchedulePlayer,
  slotMs: number,
  seed: number,
): PlayerSnapshot {
  let recentGames = 0;
  for (const ageMs of player.completedGameAgesMs) {
    recentGames += decayFactor(ageMs / slotMs);
  }
  return {
    player,
    gamesCompleted: player.gamesCompleted,
    presentSlots: player.presentMs / slotMs,
    playSlots: player.playMs / slotMs,
    waitSlots: player.totalWaitMs / slotMs,
    currentWaitSlots: player.currentWaitMs / slotMs,
    restSlots: player.restMs === null ? null : player.restMs / slotMs,
    recentGames,
    tieBreak:
      TIE_BREAK_JITTER_POINTS * seededUnitValue(seed, player.participantId),
  };
}

/**
 * The snapshot `offsetSlots` later, assuming no pause. `courtFreesAtSlots` is
 * when the player's current (or about-to-start) match is expected to end;
 * null if they are not on court.
 */
export function projectSnapshot(
  snapshot: PlayerSnapshot,
  offsetSlots: number,
  courtFreesAtSlots: number | null,
): PlayerSnapshot {
  const decayedRecentGames = snapshot.recentGames * decayFactor(offsetSlots);
  if (snapshot.player.status === "skipped") {
    return {
      ...snapshot,
      restSlots:
        snapshot.restSlots === null ? null : snapshot.restSlots + offsetSlots,
      recentGames: decayedRecentGames,
    };
  }
  if (courtFreesAtSlots === null) {
    return {
      ...snapshot,
      presentSlots: snapshot.presentSlots + offsetSlots,
      waitSlots: snapshot.waitSlots + offsetSlots,
      currentWaitSlots: snapshot.currentWaitSlots + offsetSlots,
      restSlots:
        snapshot.restSlots === null ? null : snapshot.restSlots + offsetSlots,
      recentGames: decayedRecentGames,
    };
  }
  if (courtFreesAtSlots > offsetSlots) {
    return {
      ...snapshot,
      presentSlots: snapshot.presentSlots + offsetSlots,
      playSlots: snapshot.playSlots + offsetSlots,
      currentWaitSlots: 0,
      recentGames: decayedRecentGames,
    };
  }
  const restedSlots = offsetSlots - courtFreesAtSlots;
  const credit = snapshot.player.pendingGameCredit;
  return {
    ...snapshot,
    gamesCompleted: snapshot.gamesCompleted + credit,
    presentSlots: snapshot.presentSlots + offsetSlots,
    playSlots: snapshot.playSlots + courtFreesAtSlots,
    waitSlots: snapshot.waitSlots + restedSlots,
    currentWaitSlots: restedSlots,
    restSlots: restedSlots,
    recentGames: decayedRecentGames + credit * decayFactor(restedSlots),
  };
}

/** Session-wide rates over all present players (plan §5.2). A 0 denominator gives 0. */
export interface SessionRates {
  /** Σg / Σp: games per slot present. */
  gameRate: number;
  /** Σplay / Σp. */
  playRate: number;
  /** ΣW / Σp. */
  waitRate: number;
  /** Σg / n. */
  meanGames: number;
}

export function sessionRates(
  snapshots: readonly PlayerSnapshot[],
): SessionRates {
  let totalGames = 0;
  let totalPresent = 0;
  let totalPlay = 0;
  let totalWait = 0;
  for (const snapshot of snapshots) {
    totalGames += snapshot.gamesCompleted;
    totalPresent += snapshot.presentSlots;
    totalPlay += snapshot.playSlots;
    totalWait += snapshot.waitSlots;
  }
  const perPresent = (total: number) =>
    totalPresent === 0 ? 0 : total / totalPresent;
  return {
    gameRate: perPresent(totalGames),
    playRate: perPresent(totalPlay),
    waitRate: perPresent(totalWait),
    meanGames: snapshots.length === 0 ? 0 : totalGames / snapshots.length,
  };
}

/**
 * `sessionRates` of every snapshot projected `offsetSlots` ahead, computed
 * without building the projections (the forecast does this once per busy
 * court). Must agree with `projectSnapshot`; a test checks they do.
 */
export function projectedSessionRates(
  snapshots: readonly PlayerSnapshot[],
  offsetSlots: number,
  courtFreesAtSlots: readonly (number | null)[],
): SessionRates {
  let totalGames = 0;
  let totalPresent = 0;
  let totalPlay = 0;
  let totalWait = 0;
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    const freesAt = courtFreesAtSlots[index];
    totalGames += snapshot.gamesCompleted;
    totalPresent += snapshot.presentSlots;
    totalPlay += snapshot.playSlots;
    totalWait += snapshot.waitSlots;
    if (snapshot.player.status === "skipped") continue;
    totalPresent += offsetSlots;
    if (freesAt === null) {
      totalWait += offsetSlots;
    } else if (freesAt > offsetSlots) {
      totalPlay += offsetSlots;
    } else {
      totalGames += snapshot.player.pendingGameCredit;
      totalPlay += freesAt;
      totalWait += offsetSlots - freesAt;
    }
  }
  const perPresent = (total: number) =>
    totalPresent === 0 ? 0 : total / totalPresent;
  return {
    gameRate: perPresent(totalGames),
    playRate: perPresent(totalPlay),
    waitRate: perPresent(totalWait),
    meanGames: snapshots.length === 0 ? 0 : totalGames / snapshots.length,
  };
}

/** The raw measurements m1-m8 for one player. */
export interface PlayerMeasurements {
  /** m3: fair-share games minus games played (positive = behind). */
  gameDeficit: number;
  /** m1: session mean games minus games played. */
  gamesBehindMean: number;
  /** m4: fair-share playing time minus playing time, in slots. */
  playDeficit: number;
  /** m5: waiting beyond fair share, in slots. */
  waitExcess: number;
  /** m6, in slots. */
  currentWaitSlots: number;
  /** m7, capped at `REST_CAP_SLOTS` (the cap for someone who has not played). */
  restSlots: number;
  /** m8. */
  recentGames: number;
  justCameOff: boolean;
}

/** Each term's signed contribution to P, in points. */
export interface PriorityTerms {
  fairShare: number;
  rawGames: number;
  playingTime: number;
  currentWait: number;
  accumulatedWait: number;
  rest: number;
  recentGames: number;
  consecutive: number;
  hostOverride: number;
  tieBreak: number;
}

export type PriorityTermName = keyof PriorityTerms;

export interface ScoredPlayer {
  snapshot: PlayerSnapshot;
  measurements: PlayerMeasurements;
  terms: PriorityTerms;
  /** P: the sum of the terms. */
  priority: number;
}

export function measurePlayer(
  snapshot: PlayerSnapshot,
  rates: SessionRates,
): PlayerMeasurements {
  return {
    gameDeficit:
      rates.gameRate * snapshot.presentSlots - snapshot.gamesCompleted,
    gamesBehindMean: rates.meanGames - snapshot.gamesCompleted,
    playDeficit: rates.playRate * snapshot.presentSlots - snapshot.playSlots,
    waitExcess: snapshot.waitSlots - rates.waitRate * snapshot.presentSlots,
    currentWaitSlots: snapshot.currentWaitSlots,
    restSlots:
      snapshot.restSlots === null
        ? REST_CAP_SLOTS
        : Math.min(snapshot.restSlots, REST_CAP_SLOTS),
    recentGames: snapshot.recentGames,
    justCameOff:
      snapshot.restSlots !== null && snapshot.restSlots < JUST_CAME_OFF_SLOTS,
  };
}

/** Everything that is the same for every player scored at one moment. */
export interface ScoringContext {
  weights: ScoringWeights;
  rates: SessionRates;
  /** 1 + the largest manual queue rank among present players (0 if none). */
  manualRankCount: number;
}

export function manualRankCount(players: readonly SchedulePlayer[]): number {
  let count = 0;
  for (const player of players) {
    if (player.manualQueueRank !== null) {
      count = Math.max(count, player.manualQueueRank + 1);
    }
  }
  return count;
}

export function scoreSnapshot(
  snapshot: PlayerSnapshot,
  context: ScoringContext,
): ScoredPlayer {
  const { weights } = context;
  const measurements = measurePlayer(snapshot, context.rates);
  const urgentWait = urgentWaitArgument(measurements.currentWaitSlots, weights);
  const rank = snapshot.player.manualQueueRank;
  const terms: PriorityTerms = {
    fairShare:
      weights.fairShare *
      saturate(measurements.gameDeficit, weights.fairShareCap),
    rawGames:
      weights.rawGames *
      saturate(measurements.gamesBehindMean, weights.rawGamesCap),
    playingTime:
      weights.playingTime *
      saturate(measurements.playDeficit, weights.playingTimeCap),
    currentWait:
      weights.currentWait * saturate(urgentWait, weights.currentWaitCap),
    accumulatedWait:
      weights.accumulatedWait *
      saturate(measurements.waitExcess, weights.accumulatedWaitCap),
    rest: weights.rest * measurements.restSlots,
    recentGames:
      -weights.recentGames *
      saturate(measurements.recentGames, weights.recentGamesCap),
    consecutive: measurements.justCameOff ? -weights.consecutive : 0,
    hostOverride:
      rank === null
        ? 0
        : (context.manualRankCount - rank) * HOST_OVERRIDE_POINTS_PER_POSITION,
    tieBreak: snapshot.tieBreak,
  };
  const priority =
    terms.fairShare +
    terms.rawGames +
    terms.playingTime +
    terms.currentWait +
    terms.accumulatedWait +
    terms.rest +
    terms.recentGames +
    terms.consecutive +
    terms.hostOverride +
    terms.tieBreak;
  return { snapshot, measurements, terms, priority };
}

function urgentWaitArgument(
  waitSlots: number,
  weights: ScoringWeights,
): number {
  return waitSlots + weights.waitUrgency * Math.max(0, waitSlots - 1) ** 2;
}

/**
 * The part of `waitingPriorityUpperBound` shared by every waiting player at
 * one forecast time: how far the session-rate terms can move between now and
 * `offsetSlots` later. `maximumPresentSlots` is the largest time present among
 * waiting players now.
 */
export function sharedPriorityDrift(
  ratesNow: SessionRates,
  ratesThen: SessionRates,
  offsetSlots: number,
  maximumPresentSlots: number,
  weights: ScoringWeights,
): number {
  const rateDrift = (now: number, then: number) =>
    Math.abs(then - now) * maximumPresentSlots + Math.abs(then) * offsetSlots;
  return (
    weights.fairShare * rateDrift(ratesNow.gameRate, ratesThen.gameRate) +
    weights.rawGames * Math.abs(ratesThen.meanGames - ratesNow.meanGames) +
    weights.playingTime * rateDrift(ratesNow.playRate, ratesThen.playRate) +
    weights.accumulatedWait *
      (offsetSlots * Math.abs(1 - ratesThen.waitRate) +
        Math.abs(ratesThen.waitRate - ratesNow.waitRate) *
          maximumPresentSlots) +
    weights.rest * offsetSlots
  );
}

/**
 * An upper bound on a waiting player's priority `offsetSlots` later, from
 * their score now, without projecting or rescoring them. Each term is
 * `w·sat(argument)` and `sat` changes by at most the change in its argument,
 * so P can rise by at most Σ w·|Δargument|. The forecast uses this to skip
 * players who cannot make a court's short list; a property test checks the
 * bound holds.
 */
export function waitingPriorityUpperBound(
  scoredNow: ScoredPlayer,
  offsetSlots: number,
  sharedDrift: number,
  weights: ScoringWeights,
  offsetDecay: number = decayFactor(offsetSlots),
): number {
  const { measurements, snapshot } = scoredNow;
  const wait = measurements.currentWaitSlots;
  const waitDrift =
    weights.currentWait *
    (urgentWaitArgument(wait + offsetSlots, weights) -
      urgentWaitArgument(wait, weights));
  const recentGamesDrift =
    weights.recentGames * measurements.recentGames * (1 - offsetDecay);
  const consecutiveDrift =
    measurements.justCameOff &&
    (snapshot.restSlots ?? 0) + offsetSlots >= JUST_CAME_OFF_SLOTS
      ? weights.consecutive
      : 0;
  return (
    scoredNow.priority +
    sharedDrift +
    waitDrift +
    recentGamesDrift +
    consecutiveDrift
  );
}

/** Higher priority first. */
export function byPriorityDescending(
  left: ScoredPlayer,
  right: ScoredPlayer,
): number {
  return right.priority - left.priority;
}

/**
 * Scores every waiting player at the input's moment, highest priority first.
 * Session rates are taken over all present players (playing or not).
 */
export function scoreWaitingPlayers(
  input: ScheduleInput,
  weights: ScoringWeights,
): ScoredPlayer[] {
  const snapshots = input.players.map((player) =>
    snapshotAtNow(player, input.slotMs, input.seed),
  );
  const context: ScoringContext = {
    weights,
    rates: sessionRates(snapshots),
    manualRankCount: manualRankCount(input.players),
  };
  return snapshots
    .filter((snapshot) => snapshot.player.status === "waiting")
    .map((snapshot) => scoreSnapshot(snapshot, context))
    .sort(byPriorityDescending);
}
