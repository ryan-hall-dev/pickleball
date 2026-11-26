// Wait-first selection is independent of grouping: variety cannot displace a player.
import { playerMetrics } from "../session/metrics";
import { acceptedFriendPairs } from "../session/pairHandlers";
import {
  isSimpleSocial,
  isSimpleSocialV2,
  simpleSessionTimeIsUp,
  validateSimpleTeams,
} from "../session/simplePolicy";
import {
  currentLineup,
  isCourtClosed,
  isPresent,
  isSkipped,
  type SessionState,
} from "../session/state";
import type { CourtId, EpochMs, ParticipantId } from "../session/types";

export interface SimpleSuggestion {
  courtId: CourtId;
  teamA: ParticipantId[];
  teamB: ParticipantId[];
  reason: string;
}

type Candidate = { id: ParticipantId; rank: number; male: boolean };
type GameType = "mixed" | "sameSex";

function lexicographicallyEarlier(
  left: Candidate[],
  right: Candidate[],
): boolean {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].rank !== right[index].rank)
      return left[index].rank < right[index].rank;
  }
  return false;
}

/** Only completed games establish a streak; abandoned games never reset one. */
function repeatedTypes(state: SessionState): Map<ParticipantId, GameType> {
  const histories = new Map<ParticipantId, GameType[]>();
  const completed = Object.values(state.matches)
    .filter((match) => match.status === "completed")
    .sort(
      (left, right) =>
        left.endedAt! - right.endedAt! ||
        left.startedBySeq - right.startedBySeq,
    );
  for (const match of completed) {
    const lineup = currentLineup(match);
    const genders = lineup.map(
      ({ participantId }) =>
        state.participants[participantId]?.participant.gender,
    );
    if (genders.length !== 4 || genders.some((gender) => gender === undefined))
      continue;
    const men = genders.filter((gender) => gender === "male").length;
    if (men !== 0 && men !== 2 && men !== 4) continue;
    const type = men === 2 ? "mixed" : "sameSex";
    for (const { participantId } of lineup) {
      const history = histories.get(participantId) ?? [];
      history.push(type);
      histories.set(participantId, history);
    }
  }
  return new Map(
    [...histories].flatMap(([id, history]) =>
      history.length >= 2 && history.at(-1) === history.at(-2)
        ? [[id, history.at(-1)!]]
        : [],
    ),
  );
}

function oldestFeasibleSet(
  candidates: Candidate[],
  maximumGames: number,
): Candidate[] {
  const men = candidates.filter((player) => player.male);
  const women = candidates.filter((player) => !player.male);
  let selected: Candidate[] = [];
  // Maximise filled courts before comparing wait vectors. Even gender counts
  // are sufficient: pairs combine into either mixed or same-sex games.
  for (
    let games = Math.min(maximumGames, Math.floor(candidates.length / 4));
    games > 0 && selected.length === 0;
    games -= 1
  ) {
    for (let maleCount = 0; maleCount <= games * 4; maleCount += 2) {
      const femaleCount = games * 4 - maleCount;
      if (maleCount > men.length || femaleCount > women.length) continue;
      const option = [
        ...men.slice(0, maleCount),
        ...women.slice(0, femaleCount),
      ].sort((left, right) => left.rank - right.rank);
      if (selected.length === 0 || lexicographicallyEarlier(option, selected))
        selected = option;
    }
  }
  return selected;
}

function regroupForVariety(
  state: SessionState,
  baseline: Candidate[][],
): Candidate[][] {
  const selected = baseline.flat();
  const streaks = repeatedTypes(state);
  const selectedMen = selected.filter((player) => player.male);
  const selectedWomen = selected.filter((player) => !player.male);
  let bestGroups: Candidate[][] = baseline;

  const penalty = (player: Candidate, type: GameType) =>
    Number(streaks.get(player.id) === type);
  const groupPenalty = (groups: Candidate[][]) =>
    groups.reduce(
      (sum, group) =>
        sum +
        group.reduce(
          (subtotal, player) =>
            subtotal +
            penalty(
              player,
              group.every((other) => other.male === group[0].male)
                ? "sameSex"
                : "mixed",
            ),
          0,
        ),
      0,
    );
  let bestPenalty = groupPenalty(baseline);
  // For a fixed number of mixed games, assigning the smallest penalty delta
  // is optimal. This explores all gender layouts in polynomial time.
  for (
    let mixedGames = 0;
    mixedGames * 2 <= Math.min(selectedMen.length, selectedWomen.length);
    mixedGames += 1
  ) {
    if (
      (selectedMen.length - mixedGames * 2) % 4 ||
      (selectedWomen.length - mixedGames * 2) % 4
    )
      continue;
    const byMixedPreference = (left: Candidate, right: Candidate) =>
      penalty(left, "mixed") -
        penalty(left, "sameSex") -
        (penalty(right, "mixed") - penalty(right, "sameSex")) ||
      left.rank - right.rank;
    const males = [...selectedMen].sort(byMixedPreference);
    const females = [...selectedWomen].sort(byMixedPreference);
    const groups: Candidate[][] = [];
    for (let index = 0; index < mixedGames * 2; index += 2)
      groups.push([
        males[index],
        females[index],
        males[index + 1],
        females[index + 1],
      ]);
    for (const sameSex of [
      males.slice(mixedGames * 2),
      females.slice(mixedGames * 2),
    ]) {
      for (let index = 0; index < sameSex.length; index += 4)
        groups.push(sameSex.slice(index, index + 4));
    }
    const totalPenalty = groupPenalty(groups);
    if (totalPenalty < bestPenalty) {
      bestPenalty = totalPenalty;
      bestGroups = groups;
    }
  }
  bestGroups.sort(
    (left, right) =>
      Math.min(...left.map((player) => player.rank)) -
      Math.min(...right.map((player) => player.rank)),
  );
  return bestGroups;
}

/** Present, free, unreserved players with a gender, longest current wait first. */
function rankedCandidates(state: SessionState, now: EpochMs): Candidate[] {
  const reserved = new Set(
    Object.values(state.courts).flatMap((court) =>
      court.nextGroup
        ? [...court.nextGroup.teamA, ...court.nextGroup.teamB]
        : [],
    ),
  );
  return playerMetrics(state, now)
    .filter((player) => {
      const participant = state.participants[player.participantId];
      return (
        isPresent(participant) &&
        participant.activeMatchId === null &&
        !isSkipped(participant, now) &&
        !reserved.has(player.participantId) &&
        (player.participant.gender === "male" ||
          player.participant.gender === "female")
      );
    })
    .sort(
      (left, right) =>
        (right.currentWaitMs ?? 0) - (left.currentWaitMs ?? 0) ||
        (left.participantId < right.participantId
          ? -1
          : left.participantId > right.participantId
            ? 1
            : 0),
    )
    .map((player, rank): Candidate => ({
      id: player.participantId,
      rank,
      male: player.participant.gender === "male",
    }));
}

/**
 * Prepare groups from players available NOW, including for a busy requested court.
 * Gender prefixes enumerate O(players) feasible sets, never four-player combinations.
 * Requested court order is preserved; called groups are reserved on every court.
 */
export function simpleRecommend(
  state: SessionState,
  now: EpochMs,
  requestedCourtIds: readonly CourtId[],
): SimpleSuggestion[] {
  if (
    !isSimpleSocial(state.config) ||
    state.phase !== "live" ||
    state.pausedBySeq !== null ||
    simpleSessionTimeIsUp(state, now)
  )
    return [];
  const courtIds = [...new Set(requestedCourtIds)].filter((id) => {
    const court = state.courts[id];
    return (
      court &&
      court.court.format === "doubles" &&
      !isCourtClosed(court) &&
      !court.closeScheduledBySeq &&
      !court.nextGroup
    );
  });
  const candidates = rankedCandidates(state, now);
  const pairs = isSimpleSocialV2(state.config)
    ? acceptedFriendPairs(state).filter(
        (pair) =>
          candidates.some((player) => player.id === pair.participantId) &&
          candidates.some((player) => player.id === pair.friendId),
      )
    : [];
  if (pairs.length > 0)
    return withFriendPairs(state, now, courtIds, candidates, pairs);
  let remaining = oldestFeasibleSet(candidates, courtIds.length);
  const groups: Candidate[][] = [];
  while (remaining.length > 0) {
    const chosen = oldestFeasibleSet(remaining, 1);
    const chosenIds = new Set(chosen.map((player) => player.id));
    // Both gender counts stay even, so removing a valid four preserves feasibility.
    const males = chosen.filter((player) => player.male);
    const females = chosen.filter((player) => !player.male);
    groups.push(
      males.length === 2
        ? [males[0], females[0], males[1], females[1]]
        : chosen,
    );
    remaining = remaining.filter((player) => !chosenIds.has(player.id));
  }
  const freeIndices = groups.flatMap((_, index) =>
    state.courts[courtIds[index]].activeMatchId === null ? [index] : [],
  );
  if (freeIndices.length > 1) {
    const regrouped = regroupForVariety(
      state,
      freeIndices.map((index) => groups[index]),
    );
    freeIndices.forEach((groupIndex, index) => {
      groups[groupIndex] = regrouped[index];
    });
  }
  return groups.map((group, index) => {
    const ids = group.map((player) => player.id);
    const [teamA, teamB] = isSimpleSocialV2(state.config)
      ? arrangeTeams(state, now, ids, [])
      : [ids.slice(0, 2), ids.slice(2)];
    return {
      courtId: courtIds[index],
      teamA,
      teamB,
      reason: "Longest eligible waits; variety within the selected players.",
    };
  });
}

const SKILL_POINTS = { beginner: 1, intermediate: 2, advanced: 3 } as const;

/**
 * simple-social-v2 (D7): wait picks the four; this only splits them into
 * teams. Among the valid splits (the doubles rule, a friend pair together),
 * fewest repeat partnerships first, then the closest skill, then the given
 * order.
 */
export function arrangeTeams(
  state: SessionState,
  now: EpochMs,
  four: readonly ParticipantId[],
  keepTogether: ReadonlyArray<readonly [ParticipantId, ParticipantId]>,
): [ParticipantId[], ParticipantId[]] {
  const [a, b, c, d] = four;
  const splits: Array<[ParticipantId[], ParticipantId[]]> = [
    [
      [a, b],
      [c, d],
    ],
    [
      [a, c],
      [b, d],
    ],
    [
      [a, d],
      [b, c],
    ],
  ];
  const metrics = new Map(
    playerMetrics(state, now).map((player) => [player.participantId, player]),
  );
  const together = (team: ParticipantId[], pair: readonly ParticipantId[]) =>
    pair.every((id) => team.includes(id));
  const partners = (team: ParticipantId[]) =>
    metrics.get(team[0])?.partnerCounts[team[1]] ?? 0;
  const skill = (team: ParticipantId[]) =>
    team.reduce((sum, id) => {
      const level = state.participants[id]?.participant.skill;
      return sum + (level ? SKILL_POINTS[level] : 2);
    }, 0);
  let best: [ParticipantId[], ParticipantId[]] | null = null;
  let bestScore: [number, number] = [Infinity, Infinity];
  for (const split of splits) {
    if (validateSimpleTeams(split[0], split[1], state.participants)) continue;
    if (
      keepTogether.some(
        (pair) => !together(split[0], pair) && !together(split[1], pair),
      )
    )
      continue;
    const score: [number, number] = [
      partners(split[0]) + partners(split[1]),
      Math.abs(skill(split[0]) - skill(split[1])),
    ];
    if (
      score[0] < bestScore[0] ||
      (score[0] === bestScore[0] && score[1] < bestScore[1])
    ) {
      best = split;
      bestScore = score;
    }
  }
  return (
    best ?? [
      [a, b],
      [c, d],
    ]
  );
}

/** A player alone, or an accepted friend pair (two seats, one team). */
interface WaitingUnit {
  ids: ParticipantId[];
  /** The pair's rank is the better (shorter-wait) of the two (D4). */
  rank: number;
}

/**
 * Wait-first groups when friend pairs are waiting: each pair is one unit
 * ranked by the shorter of the two waits, and stays on one team. Court by
 * court, the earliest-ranked units that make a valid game of four are
 * chosen; a pair that can't fit yet keeps waiting.
 */
function withFriendPairs(
  state: SessionState,
  now: EpochMs,
  courtIds: readonly CourtId[],
  candidates: readonly Candidate[],
  pairs: ReadonlyArray<{
    participantId: ParticipantId;
    friendId: ParticipantId;
  }>,
): SimpleSuggestion[] {
  const rankOf = new Map(candidates.map((player) => [player.id, player.rank]));
  const paired = new Set(
    pairs.flatMap((pair) => [pair.participantId, pair.friendId]),
  );
  let units: WaitingUnit[] = [
    ...candidates
      .filter((player) => !paired.has(player.id))
      .map((player) => ({ ids: [player.id], rank: player.rank })),
    ...pairs.map((pair) => ({
      ids: [pair.participantId, pair.friendId],
      // Ranks are wait order: the lower rank is the longer wait, so the
      // pair counts as its shorter wait (D4): the higher rank of the two.
      rank: Math.max(
        rankOf.get(pair.participantId)!,
        rankOf.get(pair.friendId)!,
      ),
    })),
  ].sort((left, right) => left.rank - right.rank);

  const suggestions: SimpleSuggestion[] = [];
  for (const courtId of courtIds) {
    const chosen: WaitingUnit[] = [];
    const search = (from: number, seats: number): boolean => {
      if (seats === 4) {
        const four = chosen.flatMap((unit) => unit.ids);
        const keep = chosen
          .filter((unit) => unit.ids.length === 2)
          .map((unit) => unit.ids as [ParticipantId, ParticipantId]);
        const [teamA, teamB] = arrangeTeams(state, now, four, keep);
        return (
          !validateSimpleTeams(teamA, teamB, state.participants) &&
          keep.every(
            (pair) =>
              pair.every((id) => teamA.includes(id)) ||
              pair.every((id) => teamB.includes(id)),
          )
        );
      }
      for (let index = from; index < units.length; index += 1) {
        if (seats + units[index].ids.length > 4) continue;
        chosen.push(units[index]);
        if (search(index + 1, seats + units[index].ids.length)) return true;
        chosen.pop();
      }
      return false;
    };
    if (!search(0, 0)) break;
    const four = chosen.flatMap((unit) => unit.ids);
    const keep = chosen
      .filter((unit) => unit.ids.length === 2)
      .map((unit) => unit.ids as [ParticipantId, ParticipantId]);
    const [teamA, teamB] = arrangeTeams(state, now, four, keep);
    suggestions.push({
      courtId,
      teamA,
      teamB,
      reason: "Longest eligible waits; friends on one team.",
    });
    const used = new Set(four);
    units = units.filter((unit) => !unit.ids.some((id) => used.has(id)));
  }
  return suggestions;
}

/** Where to fill a group's empty seats (a `NextGroupChanged`). */
export interface SimpleRefill {
  courtId: CourtId;
  calledEventId: string;
  teamA: ParticipantId[];
  teamB: ParticipantId[];
}

/** How far down the waiting order to look for a valid fill. */
const REFILL_CANDIDATE_LIMIT = 12;

/**
 * simple-social-v2 (D9): fills each Up next group's empty seats with the
 * longest-waiting valid players, keeping everyone else in their seat. The
 * earliest-ranked fill that makes a valid game wins; with none, the seat
 * stays open and visible (h12). Groups are filled in court order of their
 * call, so one player is never offered to two groups.
 */
export function simpleRefill(
  state: SessionState,
  now: EpochMs,
): SimpleRefill[] {
  if (
    !isSimpleSocialV2(state.config) ||
    state.phase !== "live" ||
    simpleSessionTimeIsUp(state, now)
  )
    return [];
  // A friend pair waits as one: never split it to fill a single seat.
  const paired = new Set(
    acceptedFriendPairs(state).flatMap((pair) => [
      pair.participantId,
      pair.friendId,
    ]),
  );
  let candidates = rankedCandidates(state, now)
    .filter((player) => !paired.has(player.id))
    .slice(0, REFILL_CANDIDATE_LIMIT);
  const refills: SimpleRefill[] = [];
  const courts = Object.values(state.courts).filter(
    (court) =>
      court.nextGroup &&
      !isCourtClosed(court) &&
      [...court.nextGroup.teamA, ...court.nextGroup.teamB].includes(null),
  );
  for (const court of courts) {
    const group = court.nextGroup!;
    const seats = [...group.teamA, ...group.teamB];
    const open = seats.flatMap((id, index) => (id === null ? [index] : []));
    const fill = firstValidFill(state, seats, open, candidates);
    if (!fill) continue;
    const filled = [...seats];
    open.forEach((seatIndex, index) => {
      filled[seatIndex] = fill[index].id;
    });
    const used = new Set(fill.map((player) => player.id));
    candidates = candidates.filter((player) => !used.has(player.id));
    refills.push({
      courtId: court.court.courtId,
      calledEventId: group.calledEventId,
      teamA: filled.slice(0, 2) as ParticipantId[],
      teamB: filled.slice(2) as ParticipantId[],
    });
  }
  return refills;
}

/** Earliest-ranked candidates (lexicographic by rank) that make a valid game. */
function firstValidFill(
  state: SessionState,
  seats: Array<ParticipantId | null>,
  open: number[],
  candidates: Candidate[],
): Candidate[] | null {
  const chosen: Candidate[] = [];
  const search = (from: number): Candidate[] | null => {
    if (chosen.length === open.length) {
      const filled = [...seats];
      open.forEach((seatIndex, index) => {
        filled[seatIndex] = chosen[index].id;
      });
      return validateSimpleTeams(
        filled.slice(0, 2) as ParticipantId[],
        filled.slice(2) as ParticipantId[],
        state.participants,
      )
        ? null
        : [...chosen];
    }
    for (let index = from; index < candidates.length; index += 1) {
      chosen.push(candidates[index]);
      const found = search(index + 1);
      chosen.pop();
      if (found) return found;
    }
    return null;
  };
  return search(0);
}
