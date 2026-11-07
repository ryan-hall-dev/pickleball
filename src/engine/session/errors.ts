/** Why an event (or an undo) was rejected. Stable codes for the UI; messages are host-readable. */
export type SessionErrorCode =
  | "SEQ_NOT_INCREASING"
  | "TIME_WENT_BACKWARDS"
  | "MALFORMED_EVENT"
  | "SESSION_NOT_STARTED"
  | "SESSION_ALREADY_STARTED"
  | "SESSION_ENDED"
  | "SESSION_PAUSED"
  | "SESSION_NOT_PAUSED"
  | "INVALID_CONFIG"
  | "DUPLICATE_ID"
  | "UNKNOWN_PARTICIPANT"
  | "UNKNOWN_COURT"
  | "UNKNOWN_MATCH"
  | "PLAYER_NOT_PRESENT"
  | "PLAYER_ALREADY_PRESENT"
  | "PLAYER_PLAYING"
  | "PLAYER_SKIPPED"
  | "PLAYER_NOT_SKIPPED"
  | "PLAYER_LOCKED"
  | "PLAYER_NOT_LOCKED"
  | "PLAYER_NOT_IN_MATCH"
  | "COURT_CLOSED"
  | "COURT_NOT_CLOSED"
  | "COURT_BUSY"
  | "INVALID_TEAMS"
  | "MATCH_NOT_ACTIVE"
  | "MATCHES_IN_PROGRESS"
  | "INVALID_QUEUE_ORDER"
  | "UNKNOWN_TARGET"
  | "TARGET_MISMATCH"
  | "NOT_REVERSIBLE"
  | "ALREADY_COMPENSATED"
  /** The undo is blocked by a later action; the message says which to undo first. */
  | "UNDO_BLOCKED";

export interface SessionError {
  code: SessionErrorCode;
  message: string;
}

export function sessionError(
  code: SessionErrorCode,
  message: string,
): SessionError {
  return { code, message };
}
