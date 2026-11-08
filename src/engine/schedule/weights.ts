// Scoring weights and caps (plan §5.3). Defaults were calibrated by simulation
// in M1; docs/engine.md records how and the measured results.
import type { RotationObjective, RotationPreferences } from "../session";

/**
 * Weights (points per unit) and saturation caps (in games or slots) for each
 * term of the player priority score and the group value.
 */
export interface ScoringWeights {
  /** wFair, cF: games behind fair share for the time present (m3). */
  fairShare: number;
  fairShareCap: number;
  /** wRaw, cR: games behind the session mean (m1), the count players can see. */
  rawGames: number;
  rawGamesCap: number;
  /**
   * wPlay, cP: court minutes behind fair share (m4). Fair share = the session's
   * court minutes per minute present × this player's time present, so long and
   * short matches count (game counts don't see that).
   */
  playingTime: number;
  playingTimeCap: number;
  /** wWait, cW, β: current wait (m6), with urgency rising after one slot. */
  currentWait: number;
  currentWaitCap: number;
  waitUrgency: number;
  /** wRest: time since last match (m7), capped at `REST_CAP_SLOTS`. */
  rest: number;
  /** wRec, cRec: recent participation (m8), subtracted. */
  recentGames: number;
  recentGamesCap: number;
  /** wCons: consecutive-match penalty for a player who just came off. */
  consecutive: number;
  /** wPartner, wOpp: per repeated pairing (each pair saturates at `PAIR_REPEAT_CAP`). */
  repeatPartner: number;
  repeatOpponent: number;
  /** wSkill: per skill level of difference between the two teams. */
  skillImbalance: number;
}

/** Calibrated defaults (see docs/engine.md, "Calibration"). */
export const DEFAULT_SCORING_WEIGHTS: Readonly<ScoringWeights> = {
  fairShare: 1.0,
  fairShareCap: 1.5,
  rawGames: 0.25,
  rawGamesCap: 1.0,
  playingTime: 0.6,
  playingTimeCap: 1.0,
  currentWait: 0.8,
  currentWaitCap: 2.0,
  waitUrgency: 1.0,
  rest: 0.25,
  recentGames: 0.4,
  recentGamesCap: 1.5,
  consecutive: 0.6,
  repeatPartner: 0.3,
  repeatOpponent: 0.1,
  skillImbalance: 0.1,
};

/** m7 is capped here: a player rested for two slots counts as fully rested. */
export const REST_CAP_SLOTS = 2;
/** m8 half-life: the last few rounds count most. */
export const RECENT_GAMES_HALF_LIFE_SLOTS = 2;
/** A player rested for less than this "just came off" (consecutive penalty). */
export const JUST_CAME_OFF_SLOTS = 0.5;
/** Each pair's repeat count saturates here so mixing never outweighs fairness. */
export const PAIR_REPEAT_CAP = 2;
/**
 * Seeded jitter added to every priority: it breaks exact ties without
 * favouring ids or join order, and lets "Shuffle" vary near-equal choices.
 */
export const TIE_BREAK_JITTER_POINTS = 0.02;
/**
 * Points per position of the host's manual order. Larger than any possible
 * spread of the other terms, so the host's order is followed.
 */
export const HOST_OVERRIDE_POINTS_PER_POSITION = 100;

/** Multiplier for each objective by its rank (1st ×2.0, 2nd ×1.5, 3rd ×1.2, rest ×1.0). */
const RANK_FACTORS = [2.0, 1.5, 1.2];

function rankFactor(
  objectiveOrder: readonly RotationObjective[],
  objective: RotationObjective,
): number {
  const rank = objectiveOrder.indexOf(objective);
  return rank === -1 ? 1 : (RANK_FACTORS[rank] ?? 1);
}

/**
 * The weights after the host's priority order scales them and the rule
 * toggles switch terms off. Caps are never scaled. "Full courts" scales
 * nothing in the MVP: a free court is always filled when it can be (§5.5).
 */
export function resolveScoringWeights(
  preferences: RotationPreferences,
  baseWeights: Readonly<ScoringWeights> = DEFAULT_SCORING_WEIGHTS,
): ScoringWeights {
  const { objectiveOrder, rules } = preferences;
  const equalGames =
    rankFactor(objectiveOrder, "equalGames") * (rules.fewerGamesFirst ? 1 : 0);
  const shortestWaits =
    rankFactor(objectiveOrder, "shortestWaits") *
    (rules.longestWaitFirst ? 1 : 0);
  const playingTime = rankFactor(objectiveOrder, "playingTime");
  const noBackToBack = rankFactor(objectiveOrder, "noBackToBack");
  const mixPartners = rankFactor(objectiveOrder, "mixPartners");
  return {
    ...baseWeights,
    fairShare: baseWeights.fairShare * equalGames,
    rawGames: baseWeights.rawGames * equalGames,
    currentWait: baseWeights.currentWait * shortestWaits,
    playingTime: baseWeights.playingTime * playingTime,
    rest: baseWeights.rest * noBackToBack,
    recentGames: baseWeights.recentGames * noBackToBack,
    consecutive:
      baseWeights.consecutive *
      noBackToBack *
      (rules.preventConsecutive ? 1 : 0),
    repeatPartner:
      baseWeights.repeatPartner * mixPartners * (rules.mixPartners ? 1 : 0),
    repeatOpponent:
      baseWeights.repeatOpponent *
      mixPartners *
      (rules.minimiseRepeatOpponents ? 1 : 0),
  };
}
