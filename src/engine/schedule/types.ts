// The scheduler's input is a plain snapshot, so it stays decoupled from how
// session state is stored. `scheduleInputFromSession` builds it from a replayed
// session; tests and simulations can also build it directly.
import type {
  CourtFormat,
  CourtId,
  ParticipantId,
  RotationPreferences,
  SkillLevel,
} from "../session";

/** Status of a present player. Players who have left the session are not in the snapshot. */
export type SchedulePlayerStatus = "waiting" | "playing" | "skipped";

/**
 * One present player. Every duration is active session time in milliseconds
 * (paused time excluded), measured at the snapshot's moment.
 */
export interface SchedulePlayer {
  participantId: ParticipantId;
  /** Null when unknown; scored as intermediate for team balance. */
  skill: SkillLevel | null;
  status: SchedulePlayerStatus;
  /** Completed games credited so far (`g_i`). */
  gamesCompleted: number;
  /** Games they will be credited with when their current match completes (0 or 1). */
  pendingGameCredit: number;
  /** Time present, excluding skipped and away time (`p_i`). Always `playMs + totalWaitMs`. */
  presentMs: number;
  /** Time on court (`play_i`). */
  playMs: number;
  /** Accumulated waiting (`W_i`). */
  totalWaitMs: number;
  /** Current wait since they last became available (`w_i`); 0 unless waiting. */
  currentWaitMs: number;
  /** Time since they last came off court; null if they have not played yet. */
  restMs: number | null;
  /** For each completed game: time since it ended. Drives recent participation (m8). */
  completedGameAgesMs: number[];
  /** Times partnered with each other player in this session. */
  partnerCounts: Record<ParticipantId, number>;
  /** Times faced each other player in this session. */
  opponentCounts: Record<ParticipantId, number>;
  /** Host lock: pinned to the next match. */
  isLocked: boolean;
  /** Court of the lock; null = any court (or unlocked). */
  lockedCourtId: CourtId | null;
  /** Position in the host's manual order (0 = most urgent), or null. */
  manualQueueRank: number | null;
  /** Court they are playing on; null unless playing. */
  currentCourtId: CourtId | null;
}

/** An open court. Closed courts are not in the snapshot. */
export interface ScheduleCourt {
  courtId: CourtId;
  name: string;
  format: CourtFormat;
  /** Active time of the match in progress; null when the court is free. */
  currentMatchElapsedMs: number | null;
}

export interface ScheduleInput {
  /** Target match minutes + changeover, in ms (the plan's `slot`). */
  slotMs: number;
  /** Expected length of a match: the session's own average once it has one, else the target. */
  expectedMatchMs: number;
  preferences: RotationPreferences;
  /** The suggestion seed (changes with "Shuffle"). */
  seed: number;
  players: SchedulePlayer[];
  courts: ScheduleCourt[];
}

/** One suggested match for a court. */
export interface CourtSuggestion {
  courtId: CourtId;
  courtName: string;
  format: CourtFormat;
  /** True for a free court ("Ready now"); false for a forecast on a busy court. */
  isReadyNow: boolean;
  /** Estimated time until the court frees (0 when ready now). Always an estimate. */
  expectedFreeInMs: number;
  teamA: ParticipantId[];
  teamB: ParticipantId[];
  /** Strongest reasons first, host-readable (plan §5.6). Forecast figures are marked "~". */
  reasons: string[];
  /**
   * How many other groups are as fair as this one. "Shuffle" (a new seed)
   * picks among them; 0 means there is no other fair option to show.
   */
  otherFairGroupCount: number;
}

/** A court that cannot be filled because fewer than `k` players are available for it. */
export interface UnfilledCourt {
  courtId: CourtId;
  courtName: string;
  isReadyNow: boolean;
  expectedFreeInMs: number;
  /** Players available for this court. */
  availablePlayerCount: number;
  playersNeeded: number;
}

/** A waiting player in priority order (the live "Players waiting" queue). */
export interface QueueEntry {
  participantId: ParticipantId;
  /** Priority score P (higher plays sooner). */
  priority: number;
}

export interface Recommendation {
  /** Free courts with a group, in the order they were built. */
  readyNow: CourtSuggestion[];
  /** Forecasts for busy courts, soonest first. Only "Ready now" groups are final. */
  upNext: CourtSuggestion[];
  /** Courts (free or forecast) shown as "Not enough players". */
  unfilledCourts: UnfilledCourt[];
  /** Waiting (eligible) players, highest priority first. */
  waitingQueue: QueueEntry[];
}
