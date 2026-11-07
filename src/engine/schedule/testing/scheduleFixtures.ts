// Builders for scheduler inputs in tests. Test-only: never import from production code.
import type { CourtFormat, RotationPreferences } from "../../session";
import { DEFAULT_SIMULATION_PREFERENCES } from "../simulation/simulateSession";
import type { ScheduleCourt, ScheduleInput, SchedulePlayer } from "../types";

export const TEST_SLOT_MS = 17 * 60_000;
export const TEST_MINUTE_MS = 60_000;

export function testPlayerId(number: number): string {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
}

export function testCourtId(number: number): string {
  return `00000000-0000-4000-9000-${number.toString(16).padStart(12, "0")}`;
}

/** A waiting player who has just arrived, with overrides. */
export function makePlayer(
  number: number,
  overrides: Partial<SchedulePlayer> = {},
): SchedulePlayer {
  return {
    participantId: testPlayerId(number),
    skill: null,
    status: "waiting",
    gamesCompleted: 0,
    pendingGameCredit: 0,
    presentMs: 0,
    playMs: 0,
    totalWaitMs: 0,
    currentWaitMs: 0,
    restMs: null,
    completedGameAgesMs: [],
    partnerCounts: {},
    opponentCounts: {},
    isLocked: false,
    lockedCourtId: null,
    manualQueueRank: null,
    currentCourtId: null,
    ...overrides,
  };
}

export function makeCourt(
  number: number,
  format: CourtFormat = "doubles",
  currentMatchElapsedMs: number | null = null,
): ScheduleCourt {
  return {
    courtId: testCourtId(number),
    name: `Court ${number}`,
    format,
    currentMatchElapsedMs,
  };
}

export function makeInput(
  players: SchedulePlayer[],
  courts: ScheduleCourt[],
  overrides: Partial<ScheduleInput> = {},
): ScheduleInput {
  return {
    slotMs: TEST_SLOT_MS,
    expectedMatchMs: 15 * TEST_MINUTE_MS,
    preferences: DEFAULT_SIMULATION_PREFERENCES,
    seed: 1,
    players,
    courts,
    ...overrides,
  };
}

/** Preferences with `first` moved to the top of the objective order. */
export function preferencesWithFirst(
  first: RotationPreferences["objectiveOrder"][number],
): RotationPreferences {
  return {
    ...DEFAULT_SIMULATION_PREFERENCES,
    objectiveOrder: [
      first,
      ...DEFAULT_SIMULATION_PREFERENCES.objectiveOrder.filter(
        (objective) => objective !== first,
      ),
    ],
  };
}

/** Preferences with `last` moved to the bottom of the objective order. */
export function preferencesWithLast(
  last: RotationPreferences["objectiveOrder"][number],
): RotationPreferences {
  return {
    ...DEFAULT_SIMULATION_PREFERENCES,
    objectiveOrder: [
      ...DEFAULT_SIMULATION_PREFERENCES.objectiveOrder.filter(
        (objective) => objective !== last,
      ),
      last,
    ],
  };
}

/** Every participant id in a recommendation's "Ready now" groups. */
export function readyNowIds(recommendation: {
  readyNow: Array<{ teamA: string[]; teamB: string[] }>;
}): string[] {
  return recommendation.readyNow.flatMap((suggestion) => [
    ...suggestion.teamA,
    ...suggestion.teamB,
  ]);
}
