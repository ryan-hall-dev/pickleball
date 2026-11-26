// Core identifiers and the session configuration snapshot. Pure types only.

/** Session-level participant id (UUID, `session_participants.id`). */
export type ParticipantId = string;
/** Court id (UUID, `courts.id`). */
export type CourtId = string;
/** Match id (UUID, client-generated when the match is started). */
export type MatchId = string;
/** Client-generated idempotency key of an event (UUID, `session_events.event_id`). */
export type EventId = string;
/** The host user who performed an action (UUID, `auth.users.id`). */
export type ActorId = string;
/** Epoch milliseconds, always server time. */
export type EpochMs = number;

/** Doubles seats 4 players (2 v 2); singles seats 2 (1 v 1). */
export type CourtFormat = "doubles" | "singles";

/** Players needed for one match in each format (the "k" of the plan). */
export const PLAYERS_PER_MATCH: Readonly<Record<CourtFormat, number>> = {
  doubles: 4,
  singles: 2,
};

/** Players per team in each format. */
export const PLAYERS_PER_TEAM: Readonly<Record<CourtFormat, number>> = {
  doubles: 2,
  singles: 1,
};

/** A court as snapshotted into the session (names never act as identifiers). */
export interface CourtConfig {
  courtId: CourtId;
  name: string;
  format: CourtFormat;
}

export type Gender = "male" | "female";

export type SkillLevel = "beginner" | "intermediate" | "advanced";

/**
 * A participant as snapshotted into the session. Participants exist only
 * within their session (no cross-session identity). Historical
 * PlayerJoined / SessionStarted payloads may still carry an `isGuest` key;
 * it is never read.
 */
export interface Participant {
  participantId: ParticipantId;
  firstName: string;
  lastName: string;
  /** Null when unknown (sessions recorded before a level was required). */
  skill: SkillLevel | null;
  /** Omitted in historical sessions; required by simple-social-v1. */
  gender?: Gender;
}

/** The host's rotation objectives, ranked by importance (first = most important). */
export type RotationObjective =
  | "equalGames"
  | "shortestWaits"
  | "playingTime"
  | "fullCourts"
  | "noBackToBack"
  | "mixPartners";

/** Rule toggles that switch scoring terms on or off (see plan §5.3). */
export interface RotationRules {
  preventConsecutive: boolean;
  fewerGamesFirst: boolean;
  longestWaitFirst: boolean;
  mixPartners: boolean;
  minimiseRepeatOpponents: boolean;
  allowManualAssignments: boolean;
}

export interface RotationPreferences {
  /** Distinct objectives, most important first. */
  objectiveOrder: RotationObjective[];
  rules: RotationRules;
}

/**
 * The engine's calibrated defaults (docs/engine.md, "Calibration"): the order
 * and rules the weights were tuned with. Setup offers these as "Recommended";
 * tests and simulations use the same object so the values can't drift.
 */
export const RECOMMENDED_ROTATION_PREFERENCES: Readonly<RotationPreferences> =
  Object.freeze({
    objectiveOrder: Object.freeze([
      "equalGames",
      "shortestWaits",
      "playingTime",
      "fullCourts",
      "noBackToBack",
      "mixPartners",
    ]) as RotationObjective[],
    rules: Object.freeze({
      preventConsecutive: true,
      fewerGamesFirst: true,
      longestWaitFirst: true,
      mixPartners: true,
      minimiseRepeatOpponents: true,
      allowManualAssignments: true,
    }),
  });

/** Everything about a session that is fixed when it starts (`sessions.config_snapshot`). */
export interface SessionConfig {
  /**
   * Absent preserves the historical weighted policy and replay rules.
   * simple-social-v2 adds Up next confirmations, open breaks, group moves and
   * close-after-this-game (docs/plans/reclub-to-court-v1.md); v1 logs replay
   * unchanged.
   */
  policyVersion?: "simple-social-v1" | "simple-social-v2";
  /**
   * simple-social-v2: minutes after a game starts when its court's next four
   * are asked to get ready (whole minutes, 1-30).
   */
  upNextAfterMinutes?: number;
  /** Courts enabled at start. More can be added mid-session with `CourtAdded`. */
  courts: CourtConfig[];
  targetMatchMinutes: number;
  changeoverMinutes: number;
  /** Planned session length; drives `sessionClock().remainingMs`. */
  plannedDurationMinutes: number;
  rotation: RotationPreferences;
  /** The roster known at start. Attendees present at start are listed in `SessionStarted`. */
  participants: Participant[];
}

/** A half-open time span in epoch ms; `to: null` means still open. */
export interface TimeInterval {
  from: EpochMs;
  to: EpochMs | null;
}
