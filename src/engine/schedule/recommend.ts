// `recommend`: who plays next on every court (plan §5.4-5.5). Free courts get
// final "Ready now" groups; busy courts get forecasts, simulated forward to
// when each is expected to free. Cost is O(C·n); there is no combinatorial search.
import { PLAYERS_PER_MATCH, type ParticipantId } from "../session";
import {
  chooseGroup,
  evaluateGroup,
  fairAlternatives,
  SHORTLIST_EXTRA_PLAYERS,
  TopPriorityList,
  type GroupChoice,
} from "./groupSearch";
import {
  byPriorityDescending,
  decayFactor,
  manualRankCount,
  projectedSessionRates,
  projectSnapshot,
  scoreSnapshot,
  sessionRates,
  sharedPriorityDrift,
  waitingPriorityUpperBound,
  type SessionRates,
  snapshotAtNow,
  type PlayerSnapshot,
  type ScoredPlayer,
  type ScoringContext,
} from "./priority";
import { explainGroup } from "./reasons";
import { seededUnitValue } from "./seededRandom";
import type {
  CourtSuggestion,
  Recommendation,
  ScheduleCourt,
  ScheduleInput,
  SchedulePlayer,
  UnfilledCourt,
} from "./types";
import {
  DEFAULT_SCORING_WEIGHTS,
  resolveScoringWeights,
  type ScoringWeights,
} from "./weights";

const MINIMUM_IMPROVEMENT = 1e-9;

function assertValidInput(input: ScheduleInput): void {
  if (!(input.slotMs > 0) || !(input.expectedMatchMs > 0)) {
    throw new Error(
      `recommend needs a positive slotMs and expectedMatchMs (got ${input.slotMs}, ${input.expectedMatchMs}).`,
    );
  }
  const seenIds = new Set<ParticipantId>();
  for (const player of input.players) {
    if (seenIds.has(player.participantId)) {
      throw new Error(
        `recommend got participant ${player.participantId} twice.`,
      );
    }
    seenIds.add(player.participantId);
  }
}

/** Host locks are hard constraints: a lock to a court (or to any court) takes a seat there. */
function isLockedTo(player: SchedulePlayer, court: ScheduleCourt): boolean {
  return (
    player.isLocked &&
    (player.lockedCourtId === null || player.lockedCourtId === court.courtId)
  );
}

function isLockedElsewhere(
  player: SchedulePlayer,
  court: ScheduleCourt,
): boolean {
  return (
    player.isLocked &&
    player.lockedCourtId !== null &&
    player.lockedCourtId !== court.courtId
  );
}

interface CourtGroupAttempt {
  court: ScheduleCourt;
  seatCount: number;
  choice: GroupChoice | null;
  lockedCount: number;
  /** Players in the pool this court may use. */
  availablePlayerCount: number;
  /** Other groups as fair as `choice` (0 = no other fair option). */
  otherFairGroupCount: number;
}

/** Short-list size for a court: its seats plus `SHORTLIST_EXTRA_PLAYERS` outsiders. */
function shortlistCapacity(court: ScheduleCourt): number {
  return PLAYERS_PER_MATCH[court.format] + SHORTLIST_EXTRA_PLAYERS;
}

/**
 * Best group for one court. `forced` are the players locked to it;
 * `rankedCandidates` the best other available players, highest priority
 * first (at least `shortlistCapacity` of them when there are that many).
 * When other groups are as fair (within tolerance), the seed picks among
 * them, so a new seed ("Shuffle") gives a different but equally fair group.
 */
function attemptCourtGroup(
  court: ScheduleCourt,
  forced: ScoredPlayer[],
  rankedCandidates: readonly ScoredPlayer[],
  availablePlayerCount: number,
  weights: ScoringWeights,
  seed: number,
): CourtGroupAttempt {
  const seatCount = PLAYERS_PER_MATCH[court.format];
  // Court-specific locks before any-court locks, then by priority.
  forced.sort((left, right) => {
    const leftSpecific = left.snapshot.player.lockedCourtId === null ? 1 : 0;
    const rightSpecific = right.snapshot.player.lockedCourtId === null ? 1 : 0;
    return leftSpecific - rightSpecific || byPriorityDescending(left, right);
  });
  const lockedCount = Math.min(forced.length, seatCount);
  const shortlist = rankedCandidates.slice(
    0,
    seatCount - lockedCount + SHORTLIST_EXTRA_PLAYERS,
  );
  const best = chooseGroup(seatCount, forced, shortlist, weights);
  const alternatives =
    best === null
      ? []
      : fairAlternatives(best, lockedCount, shortlist, weights);
  const options = best === null ? [] : [best, ...alternatives];
  const pickedIndex = Math.floor(
    seededUnitValue(seed, court.courtId) * options.length,
  );
  return {
    court,
    seatCount,
    choice: options[pickedIndex] ?? null,
    lockedCount,
    availablePlayerCount,
    otherFairGroupCount: alternatives.length,
  };
}

/** Best group for one court from an already-scored `pool` (any order). */
function attemptCourtGroupFromPool(
  court: ScheduleCourt,
  pool: readonly ScoredPlayer[],
  weights: ScoringWeights,
  seed: number,
): CourtGroupAttempt {
  const forced: ScoredPlayer[] = [];
  const candidates = new TopPriorityList(shortlistCapacity(court));
  let availablePlayerCount = 0;
  for (const scored of pool) {
    const player = scored.snapshot.player;
    if (isLockedElsewhere(player, court)) continue;
    availablePlayerCount += 1;
    if (isLockedTo(player, court)) forced.push(scored);
    else candidates.add(scored);
  }
  return attemptCourtGroup(
    court,
    forced,
    candidates.players,
    availablePlayerCount,
    weights,
    seed,
  );
}

function toSuggestion(
  attempt: CourtGroupAttempt,
  choice: GroupChoice,
  expectedFreeInMs: number,
  slotMs: number,
): CourtSuggestion {
  const ids = (team: ScoredPlayer[]) =>
    team.map((member) => member.snapshot.player.participantId);
  return {
    courtId: attempt.court.courtId,
    courtName: attempt.court.name,
    format: attempt.court.format,
    isReadyNow: attempt.court.currentMatchElapsedMs === null,
    expectedFreeInMs,
    teamA: ids(choice.split.teamA),
    teamB: ids(choice.split.teamB),
    reasons: explainGroup(choice, attempt.lockedCount, slotMs, {
      isForecast: attempt.court.currentMatchElapsedMs !== null,
    }),
    otherFairGroupCount: attempt.otherFairGroupCount,
  };
}

function toUnfilled(
  attempt: CourtGroupAttempt,
  expectedFreeInMs: number,
): UnfilledCourt {
  return {
    courtId: attempt.court.courtId,
    courtName: attempt.court.name,
    isReadyNow: attempt.court.currentMatchElapsedMs === null,
    expectedFreeInMs,
    availablePlayerCount: attempt.availablePlayerCount,
    playersNeeded: attempt.seatCount,
  };
}

/** Courts with the same format and no court-specific locks get the same group, so it is built once. */
function courtKindKey(
  court: ScheduleCourt,
  courtIdsWithLocks: ReadonlySet<string>,
): string {
  return courtIdsWithLocks.has(court.courtId)
    ? `court:${court.courtId}`
    : `format:${court.format}`;
}

interface CourtGroup {
  attempt: CourtGroupAttempt;
  choice: GroupChoice;
}

/**
 * Build order between two courts: courts holding host locks first (so a lock
 * is never left unseated because players ran out), then more seats (so scarce
 * players fill a doubles court before a singles one), then higher group value.
 */
function isBuiltBefore(
  candidate: CourtGroupAttempt,
  current: CourtGroupAttempt,
): boolean {
  const candidateHasLocks = candidate.lockedCount > 0;
  const currentHasLocks = current.lockedCount > 0;
  if (candidateHasLocks !== currentHasLocks) return candidateHasLocks;
  if (candidate.seatCount !== current.seatCount) {
    return candidate.seatCount > current.seatCount;
  }
  return (
    (candidate.choice?.groupValue ?? -Infinity) >
    (current.choice?.groupValue ?? -Infinity)
  );
}

/**
 * Builds groups for the courts that are free now, one at a time, in
 * `isBuiltBefore` order.
 */
function buildCourtGroups(
  courtsFreeTogether: readonly ScheduleCourt[],
  scoredPool: readonly ScoredPlayer[],
  weights: ScoringWeights,
  seed: number,
): { groups: CourtGroup[]; unfilled: CourtGroupAttempt[] } {
  let pool = [...scoredPool];
  const remainingCourts = [...courtsFreeTogether];
  const groups: CourtGroup[] = [];
  const courtIdsWithLocks = new Set<string>();
  for (const scored of pool) {
    const lockedCourtId = scored.snapshot.player.lockedCourtId;
    if (lockedCourtId !== null) courtIdsWithLocks.add(lockedCourtId);
  }
  while (remainingCourts.length > 0) {
    const attemptsByKind = new Map<string, CourtGroupAttempt>();
    for (const court of remainingCourts) {
      const key = courtKindKey(court, courtIdsWithLocks);
      if (!attemptsByKind.has(key)) {
        attemptsByKind.set(
          key,
          attemptCourtGroupFromPool(court, pool, weights, seed),
        );
      }
    }
    let best: CourtGroup | null = null;
    for (const attempt of attemptsByKind.values()) {
      if (attempt.choice === null) continue;
      if (best === null || isBuiltBefore(attempt, best.attempt)) {
        best = { attempt, choice: attempt.choice };
      }
    }
    if (best === null) {
      return {
        groups,
        unfilled: remainingCourts.map((court) =>
          attemptCourtGroupFromPool(court, pool, weights, seed),
        ),
      };
    }
    groups.push(best);
    remainingCourts.splice(remainingCourts.indexOf(best.attempt.court), 1);
    const seated = new Set(best.choice.members);
    pool = pool.filter((scored) => !seated.has(scored));
  }
  return { groups, unfilled: [] };
}

/**
 * One cross-court pass: for each group with repeat or balance penalties, take
 * the best single swap of unlocked players with another group if it raises
 * the two groups' combined value. Priorities are unchanged by a swap, so only
 * the team penalties move.
 */
function improveAcrossCourts(
  groups: CourtGroup[],
  weights: ScoringWeights,
): void {
  const isUnlocked = (scored: ScoredPlayer) => !scored.snapshot.player.isLocked;
  for (let first = 0; first < groups.length; first += 1) {
    if (groups[first].choice.split.penalty <= 0) continue;
    let bestSwap: {
      second: number;
      firstChoice: GroupChoice;
      secondChoice: GroupChoice;
      gain: number;
    } | null = null;
    for (let second = 0; second < groups.length; second += 1) {
      if (second === first) continue;
      const firstMembers = groups[first].choice.members;
      const secondMembers = groups[second].choice.members;
      const currentValue =
        groups[first].choice.groupValue + groups[second].choice.groupValue;
      for (
        let firstIndex = 0;
        firstIndex < firstMembers.length;
        firstIndex += 1
      ) {
        if (!isUnlocked(firstMembers[firstIndex])) continue;
        for (
          let secondIndex = 0;
          secondIndex < secondMembers.length;
          secondIndex += 1
        ) {
          if (!isUnlocked(secondMembers[secondIndex])) continue;
          const swappedFirst = [...firstMembers];
          const swappedSecond = [...secondMembers];
          swappedFirst[firstIndex] = secondMembers[secondIndex];
          swappedSecond[secondIndex] = firstMembers[firstIndex];
          const firstChoice = evaluateGroup(swappedFirst, weights);
          const secondChoice = evaluateGroup(swappedSecond, weights);
          const gain =
            firstChoice.groupValue + secondChoice.groupValue - currentValue;
          if (gain > (bestSwap?.gain ?? MINIMUM_IMPROVEMENT)) {
            bestSwap = { second, firstChoice, secondChoice, gain };
          }
        }
      }
    }
    if (bestSwap !== null) {
      groups[first] = { ...groups[first], choice: bestSwap.firstChoice };
      groups[bestSwap.second] = {
        ...groups[bestSwap.second],
        choice: bestSwap.secondChoice,
      };
    }
  }
}

/** Busy courts with their expected free time; an overdue court counts as freeing now. */
function busyCourtsByExpectedFreeTime(
  courts: readonly ScheduleCourt[],
  expectedMatchMs: number,
): Array<{ court: ScheduleCourt; expectedFreeInMs: number }> {
  return courts
    .filter((court) => court.currentMatchElapsedMs !== null)
    .map((court) => ({
      court,
      expectedFreeInMs: Math.max(
        0,
        expectedMatchMs - (court.currentMatchElapsedMs ?? 0),
      ),
    }))
    .sort((left, right) => left.expectedFreeInMs - right.expectedFreeInMs);
}

/**
 * Forecast groups for busy courts, soonest first (plan §5.5). Each court's
 * pool is the waiting players plus everyone expected off court no later than
 * that court (including its own players), all projected to and scored at that
 * court's expected free time. Players seated in a "Ready now" group or an
 * earlier forecast are not available again.
 */
function forecastBusyCourts(
  input: ScheduleInput,
  snapshotsNow: readonly PlayerSnapshot[],
  scoredWaitingNow: readonly ScoredPlayer[],
  ratesNow: SessionRates,
  readyNow: readonly CourtSuggestion[],
  weights: ScoringWeights,
  rankCount: number,
): { upNext: CourtSuggestion[]; unfilled: UnfilledCourt[] } {
  const { slotMs } = input;
  const busyCourts = busyCourtsByExpectedFreeTime(
    input.courts,
    input.expectedMatchMs,
  );
  const freeInSlotsByCourtId = new Map(
    busyCourts.map(({ court, expectedFreeInMs }) => [
      court.courtId,
      expectedFreeInMs / slotMs,
    ]),
  );
  const readyNowIds = new Set(
    readyNow.flatMap((suggestion) => [
      ...suggestion.teamA,
      ...suggestion.teamB,
    ]),
  );
  // Ready now players are about to play: they come back after one expected
  // match, credited with that game.
  const snapshots = snapshotsNow.map((snapshot) =>
    readyNowIds.has(snapshot.player.participantId)
      ? { ...snapshot, player: { ...snapshot.player, pendingGameCredit: 1 } }
      : snapshot,
  );
  // When each player (by snapshot index) is expected off court, in slots; null if not on court.
  const courtFreesAtSlots = snapshots.map(({ player }) => {
    if (readyNowIds.has(player.participantId)) {
      return input.expectedMatchMs / slotMs;
    }
    if (player.status !== "playing" || player.currentCourtId === null) {
      return null;
    }
    return freeInSlotsByCourtId.get(player.currentCourtId) ?? null;
  });

  let maximumWaitingPresentSlots = 0;
  for (const scored of scoredWaitingNow) {
    maximumWaitingPresentSlots = Math.max(
      maximumWaitingPresentSlots,
      scored.snapshot.presentSlots,
    );
  }

  const upNext: CourtSuggestion[] = [];
  const unfilled: UnfilledCourt[] = [];
  // Ready now players are never reused in a forecast (they only feed the rates).
  const isSeatedInForecast = snapshots.map(({ player }) =>
    readyNowIds.has(player.participantId),
  );
  const onCourtIndexes = courtFreesAtSlots.flatMap((freesAt, index) =>
    freesAt === null ? [] : [index],
  );
  const indexById = new Map(
    snapshots.map((snapshot, index) => [snapshot.player.participantId, index]),
  );
  // Snapshot index of each waiting player, in `scoredWaitingNow` order.
  const waitingIndexes = scoredWaitingNow.map((scored) =>
    indexById.get(scored.snapshot.player.participantId)!,
  );
  for (const { court, expectedFreeInMs } of busyCourts) {
    const offsetSlots = expectedFreeInMs / slotMs;
    const context: ScoringContext = {
      weights,
      rates: projectedSessionRates(snapshots, offsetSlots, courtFreesAtSlots),
      manualRankCount: rankCount,
    };
    const sharedDrift = sharedPriorityDrift(
      ratesNow,
      context.rates,
      offsetSlots,
      maximumWaitingPresentSlots,
      weights,
    );
    const offsetDecay = decayFactor(offsetSlots);
    const forced: ScoredPlayer[] = [];
    const candidates = new TopPriorityList(shortlistCapacity(court));
    let availablePlayerCount = 0;
    const scoreAtCourtTime = (index: number) =>
      scoreSnapshot(
        projectSnapshot(
          snapshots[index],
          offsetSlots,
          courtFreesAtSlots[index],
        ),
        context,
      );
    // Players coming off court (few) are always scored exactly.
    for (const index of onCourtIndexes) {
      if (isSeatedInForecast[index]) continue;
      if (courtFreesAtSlots[index]! > offsetSlots) continue;
      const player = snapshots[index].player;
      if (isLockedElsewhere(player, court)) continue;
      availablePlayerCount += 1;
      if (isLockedTo(player, court)) forced.push(scoreAtCourtTime(index));
      else candidates.add(scoreAtCourtTime(index));
    }
    // Waiting players, best now first; rescored only if they could make the short list.
    for (let rank = 0; rank < scoredWaitingNow.length; rank += 1) {
      const index = waitingIndexes[rank];
      if (isSeatedInForecast[index] || courtFreesAtSlots[index] !== null) {
        continue;
      }
      const scoredNow = scoredWaitingNow[rank];
      const player = scoredNow.snapshot.player;
      if (isLockedElsewhere(player, court)) continue;
      availablePlayerCount += 1;
      if (isLockedTo(player, court)) {
        forced.push(scoreAtCourtTime(index));
        continue;
      }
      const upperBound = waitingPriorityUpperBound(
        scoredNow,
        offsetSlots,
        sharedDrift,
        weights,
        offsetDecay,
      );
      if (candidates.wouldAccept(upperBound)) {
        candidates.add(scoreAtCourtTime(index));
      }
    }
    const attempt = attemptCourtGroup(
      court,
      forced,
      candidates.players,
      availablePlayerCount,
      weights,
      input.seed,
    );
    if (attempt.choice === null) {
      unfilled.push(toUnfilled(attempt, expectedFreeInMs));
      continue;
    }
    for (const member of attempt.choice.members) {
      isSeatedInForecast[indexById.get(member.snapshot.player.participantId)!] =
        true;
    }
    upNext.push(
      toSuggestion(attempt, attempt.choice, expectedFreeInMs, slotMs),
    );
  }
  return { upNext, unfilled };
}

export interface RecommendOptions {
  /** Weights before the host's order and toggles apply (calibration only). */
  baseWeights?: Readonly<ScoringWeights>;
  /**
   * Whether to forecast busy courts ("Up next"). Callers that only act on
   * Ready now groups (whole-session simulations) skip it: it is most of the
   * cost at 50 courts. Default true.
   */
  includeUpNext?: boolean;
}

/**
 * Recommends groups for every open court. Free courts get a "Ready now" group
 * whenever at least `k` players are eligible; otherwise they are listed as
 * unfilled. Deterministic for a given input (the seed breaks ties).
 */
export function recommend(
  input: ScheduleInput,
  options: RecommendOptions = {},
): Recommendation {
  const { baseWeights = DEFAULT_SCORING_WEIGHTS, includeUpNext = true } =
    options;
  assertValidInput(input);
  const weights = resolveScoringWeights(input.preferences, baseWeights);
  const snapshots = input.players.map((player) =>
    snapshotAtNow(player, input.slotMs, input.seed),
  );
  const rankCount = manualRankCount(input.players);
  const contextNow: ScoringContext = {
    weights,
    rates: sessionRates(snapshots),
    manualRankCount: rankCount,
  };
  const scoredWaiting = snapshots
    .filter((snapshot) => snapshot.player.status === "waiting")
    .map((snapshot) => scoreSnapshot(snapshot, contextNow))
    .sort(byPriorityDescending);

  const freeCourts = input.courts.filter(
    (court) => court.currentMatchElapsedMs === null,
  );
  const readyNowResult = buildCourtGroups(
    freeCourts,
    scoredWaiting,
    weights,
    input.seed,
  );
  improveAcrossCourts(readyNowResult.groups, weights);
  const readyNow = readyNowResult.groups.map(({ attempt, choice }) =>
    toSuggestion(attempt, choice, 0, input.slotMs),
  );
  const forecast = includeUpNext
    ? forecastBusyCourts(
        input,
        snapshots,
        scoredWaiting,
        contextNow.rates,
        readyNow,
        weights,
        rankCount,
      )
    : { upNext: [], unfilled: [] };

  return {
    readyNow,
    upNext: forecast.upNext,
    unfilledCourts: [
      ...readyNowResult.unfilled.map((attempt) => toUnfilled(attempt, 0)),
      ...forecast.unfilled,
    ],
    waitingQueue: scoredWaiting.map((scored) => ({
      participantId: scored.snapshot.player.participantId,
      priority: scored.priority,
    })),
  };
}
