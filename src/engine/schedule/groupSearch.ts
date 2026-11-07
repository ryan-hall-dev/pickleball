// Choosing the best group for one court (plan §5.4): greedy start from the
// top scorers, then single-swap improvement against a short list. Never an
// exhaustive search.
import type { SkillLevel } from "../session";
import { saturate, type ScoredPlayer } from "./priority";
import { PAIR_REPEAT_CAP, type ScoringWeights } from "./weights";

/** Outsiders kept on the short list beyond the `k` seats (`s` in the plan). */
export const SHORTLIST_EXTRA_PLAYERS = 6;
/** Swap rounds are capped so the search always finishes fast. */
export const MAX_SWAP_ROUNDS = 10;
/** A swap must improve the group value by more than this (floating-point noise). */
const MINIMUM_IMPROVEMENT = 1e-9;

const SKILL_POINTS: Record<SkillLevel, number> = {
  beginner: 1,
  intermediate: 2,
  advanced: 3,
};

function skillPoints(player: ScoredPlayer): number {
  const skill = player.snapshot.player.skill;
  return skill === null ? SKILL_POINTS.intermediate : SKILL_POINTS[skill];
}

/** Saturated repeat counts for small integer counts, so the hot loop avoids tanh. */
const SATURATED_REPEAT_COUNTS = Array.from({ length: 32 }, (_, count) =>
  saturate(count, PAIR_REPEAT_CAP),
);

function saturatedRepeats(count: number | undefined): number {
  if (count === undefined) return 0;
  return SATURATED_REPEAT_COUNTS[count] ?? saturate(count, PAIR_REPEAT_CAP);
}

function repeatedPartnerships(left: ScoredPlayer, right: ScoredPlayer): number {
  return saturatedRepeats(
    left.snapshot.player.partnerCounts[right.snapshot.player.participantId],
  );
}

function repeatedOpponents(left: ScoredPlayer, right: ScoredPlayer): number {
  return saturatedRepeats(
    left.snapshot.player.opponentCounts[right.snapshot.player.participantId],
  );
}

/** One way to split a group into two teams, with its penalty parts. */
export interface TeamSplit {
  teamA: ScoredPlayer[];
  teamB: ScoredPlayer[];
  /** Σ saturated repeat counts over partner pairs. */
  repeatPartners: number;
  /** Σ saturated repeat counts over opponent pairs. */
  repeatOpponents: number;
  /** |team A skill points − team B skill points|. */
  skillImbalance: number;
  /** wPartner·repeatPartners + wOpp·repeatOpponents + wSkill·skillImbalance. */
  penalty: number;
}

/** The lowest-penalty team split. Doubles has 3 possible splits, singles 1. */
export function bestTeamSplit(
  members: readonly ScoredPlayer[],
  weights: ScoringWeights,
): TeamSplit {
  if (members.length === 2) {
    const [first, second] = members;
    const repeatOpponents = repeatedOpponents(first, second);
    const skillImbalance = Math.abs(skillPoints(first) - skillPoints(second));
    return {
      teamA: [first],
      teamB: [second],
      repeatPartners: 0,
      repeatOpponents,
      skillImbalance,
      penalty:
        weights.repeatOpponent * repeatOpponents +
        weights.skillImbalance * skillImbalance,
    };
  }
  if (members.length !== 4) {
    throw new Error(`A match needs 2 or 4 players, got ${members.length}.`);
  }
  // Hot path (runs for every candidate group): plain numbers, and only the
  // winning split is built. Each of the 6 pairs is partnered in exactly one
  // split and opposed in the other two.
  const [first, second, third, fourth] = members;
  const partners12 = repeatedPartnerships(first, second);
  const partners34 = repeatedPartnerships(third, fourth);
  const partners13 = repeatedPartnerships(first, third);
  const partners24 = repeatedPartnerships(second, fourth);
  const partners14 = repeatedPartnerships(first, fourth);
  const partners23 = repeatedPartnerships(second, third);
  const opponents12 = repeatedOpponents(first, second);
  const opponents34 = repeatedOpponents(third, fourth);
  const opponents13 = repeatedOpponents(first, third);
  const opponents24 = repeatedOpponents(second, fourth);
  const opponents14 = repeatedOpponents(first, fourth);
  const opponents23 = repeatedOpponents(second, third);
  const allOpponents =
    opponents12 +
    opponents34 +
    opponents13 +
    opponents24 +
    opponents14 +
    opponents23;
  const skill1 = skillPoints(first);
  const skill2 = skillPoints(second);
  const skill3 = skillPoints(third);
  const skill4 = skillPoints(fourth);
  const candidates = [
    {
      repeatPartners: partners12 + partners34,
      repeatOpponents: allOpponents - opponents12 - opponents34,
      skillImbalance: Math.abs(skill1 + skill2 - skill3 - skill4),
    },
    {
      repeatPartners: partners13 + partners24,
      repeatOpponents: allOpponents - opponents13 - opponents24,
      skillImbalance: Math.abs(skill1 + skill3 - skill2 - skill4),
    },
    {
      repeatPartners: partners14 + partners23,
      repeatOpponents: allOpponents - opponents14 - opponents23,
      skillImbalance: Math.abs(skill1 + skill4 - skill2 - skill3),
    },
  ];
  let bestIndex = 0;
  let bestPenalty = Infinity;
  for (let index = 0; index < 3; index += 1) {
    const parts = candidates[index];
    const penalty =
      weights.repeatPartner * parts.repeatPartners +
      weights.repeatOpponent * parts.repeatOpponents +
      weights.skillImbalance * parts.skillImbalance;
    if (penalty < bestPenalty) {
      bestIndex = index;
      bestPenalty = penalty;
    }
  }
  const teams: Array<[ScoredPlayer[], ScoredPlayer[]]> = [
    [
      [first, second],
      [third, fourth],
    ],
    [
      [first, third],
      [second, fourth],
    ],
    [
      [first, fourth],
      [second, third],
    ],
  ];
  return {
    teamA: teams[bestIndex][0],
    teamB: teams[bestIndex][1],
    ...candidates[bestIndex],
    penalty: bestPenalty,
  };
}

export interface GroupChoice {
  members: ScoredPlayer[];
  split: TeamSplit;
  /** U(G) = Σ P_i − split penalty. */
  groupValue: number;
}

export function evaluateGroup(
  members: ScoredPlayer[],
  weights: ScoringWeights,
): GroupChoice {
  const split = bestTeamSplit(members, weights);
  let prioritySum = 0;
  for (const member of members) prioritySum += member.priority;
  return { members, split, groupValue: prioritySum - split.penalty };
}

/**
 * The best group of `seatCount` players: `forcedMembers` (host locks) always
 * take their seats; the rest come from `shortlist` (highest priority first,
 * not containing forced members). Returns null when there are not enough players.
 */
export function chooseGroup(
  seatCount: number,
  forcedMembers: readonly ScoredPlayer[],
  shortlist: readonly ScoredPlayer[],
  weights: ScoringWeights,
): GroupChoice | null {
  const forced = forcedMembers.slice(0, seatCount);
  const openSeats = seatCount - forced.length;
  if (shortlist.length < openSeats) return null;

  const chosen = shortlist.slice(0, openSeats);
  const outsiders = shortlist.slice(
    openSeats,
    openSeats + SHORTLIST_EXTRA_PLAYERS,
  );
  let best = evaluateGroup([...forced, ...chosen], weights);

  for (let round = 0; round < MAX_SWAP_ROUNDS; round += 1) {
    let bestSwap: {
      choice: GroupChoice;
      chosenIndex: number;
      outsiderIndex: number;
    } | null = null;
    for (let chosenIndex = 0; chosenIndex < chosen.length; chosenIndex += 1) {
      for (
        let outsiderIndex = 0;
        outsiderIndex < outsiders.length;
        outsiderIndex += 1
      ) {
        const bar = bestSwap?.choice.groupValue ?? best.groupValue;
        // A swap can at most remove the whole current penalty, so skip any
        // swap whose priority loss already rules out beating the bar.
        const valueUpperBound =
          best.groupValue +
          best.split.penalty +
          outsiders[outsiderIndex].priority -
          chosen[chosenIndex].priority;
        if (valueUpperBound <= bar + MINIMUM_IMPROVEMENT) continue;
        const candidate = [...chosen];
        candidate[chosenIndex] = outsiders[outsiderIndex];
        const choice = evaluateGroup([...forced, ...candidate], weights);
        if (choice.groupValue > bar + MINIMUM_IMPROVEMENT) {
          bestSwap = { choice, chosenIndex, outsiderIndex };
        }
      }
    }
    if (bestSwap === null) break;
    const swappedOut = chosen[bestSwap.chosenIndex];
    chosen[bestSwap.chosenIndex] = outsiders[bestSwap.outsiderIndex];
    outsiders[bestSwap.outsiderIndex] = swappedOut;
    best = bestSwap.choice;
  }
  return best;
}

/** Groups scoring within this many points of the best are treated as equally fair. */
export const FAIR_ALTERNATIVE_TOLERANCE_POINTS = 0.1;

/**
 * Equally fair alternatives to `best`: single swaps of an unlocked member
 * with a short-list outsider whose group value is within
 * `FAIR_ALTERNATIVE_TOLERANCE_POINTS` of the best. "Shuffle" picks among
 * these; none means there is no other fair option. `best.members` starts
 * with its `forcedCount` locked players.
 */
export function fairAlternatives(
  best: GroupChoice,
  forcedCount: number,
  shortlist: readonly ScoredPlayer[],
  weights: ScoringWeights,
): GroupChoice[] {
  const floor = best.groupValue - FAIR_ALTERNATIVE_TOLERANCE_POINTS;
  const outsiders = shortlist.filter(
    (player) => !best.members.includes(player),
  );
  const alternatives: GroupChoice[] = [];
  for (let index = forcedCount; index < best.members.length; index += 1) {
    for (const outsider of outsiders) {
      const valueUpperBound =
        best.groupValue +
        best.split.penalty +
        outsider.priority -
        best.members[index].priority;
      if (valueUpperBound < floor) continue;
      const swapped = [...best.members];
      swapped[index] = outsider;
      const choice = evaluateGroup(swapped, weights);
      if (choice.groupValue >= floor) alternatives.push(choice);
    }
  }
  return alternatives;
}

/** Keeps the `capacity` highest-priority players added so far, highest first. */
export class TopPriorityList {
  readonly players: ScoredPlayer[] = [];

  constructor(private readonly capacity: number) {}

  /** Whether a player with this priority would make the list (check before scoring one). */
  wouldAccept(priority: number): boolean {
    return (
      this.capacity > 0 &&
      (this.players.length < this.capacity ||
        priority > this.players[this.capacity - 1].priority)
    );
  }

  add(player: ScoredPlayer): void {
    if (!this.wouldAccept(player.priority)) return;
    const top = this.players;
    let index = top.length < this.capacity ? top.length : this.capacity - 1;
    while (index > 0 && top[index - 1].priority < player.priority) {
      top[index] = top[index - 1];
      index -= 1;
    }
    top[index] = player;
  }
}

/** The top `count` players by priority, highest first, in O(n·count). */
export function topByPriority(
  players: Iterable<ScoredPlayer>,
  count: number,
): ScoredPlayer[] {
  const top = new TopPriorityList(count);
  for (const player of players) top.add(player);
  return top.players;
}
