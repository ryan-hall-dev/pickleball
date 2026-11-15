// Wait-first selection is independent of grouping: variety cannot displace a player.
import { playerMetrics } from "../session/metrics";
import { isSimpleSocial, simpleSessionTimeIsUp } from "../session/simplePolicy";
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
      !court.nextGroup
    );
  });
  const reserved = new Set(
    Object.values(state.courts).flatMap((court) =>
      court.nextGroup
        ? [...court.nextGroup.teamA, ...court.nextGroup.teamB]
        : [],
    ),
  );
  const candidates = playerMetrics(state, now)
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
  return groups.map((group, index) => ({
    courtId: courtIds[index],
    teamA: group.slice(0, 2).map((player) => player.id),
    teamB: group.slice(2).map((player) => player.id),
    reason: "Longest eligible waits; variety within the selected players.",
  }));
}
