/** Digits in the emailed sign-in code (supabase/config.toml `otp_length`). */
export const LOGIN_CODE_LENGTH = 6;

export type RequestLoginCodeOutcome =
  /** Also returned for emails that aren't invited, so the form can't be used to discover hosts. */
  "CODE_SENT" | "INVALID_EMAIL" | "RATE_LIMITED" | "UNAVAILABLE";

export type VerifyLoginCodeFailure =
  | "INVALID_CODE_FORMAT"
  | "WRONG_OR_EXPIRED_CODE"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

/** The parts of a Supabase AuthError the mapping needs. */
export interface AuthErrorLike {
  code?: string;
  status?: number;
}

// Unknown or not-invited emails: signups are disabled and the form never creates users.
const NOT_INVITED_ERROR_CODES = new Set([
  "otp_disabled",
  "signup_disabled",
  "user_not_found",
  "email_address_not_authorized",
]);
// Supabase's per-IP limit. Its per-email send limit (over_email_send_rate_limit)
// only fires for existing users, so reporting it would reveal who is invited.
const RATE_LIMIT_ERROR_CODES = new Set(["over_request_rate_limit"]);
/** Reported to the visitor as a sent code; the server logs it (without the email). */
export const HIDDEN_EMAIL_SEND_LIMIT_ERROR_CODE = "over_email_send_rate_limit";
const INVALID_EMAIL_ERROR_CODES = new Set([
  "email_address_invalid",
  "validation_failed",
]);
const WRONG_CODE_ERROR_CODES = new Set(["otp_expired", "invalid_credentials"]);

function isRateLimited(error: AuthErrorLike): boolean {
  return (
    (error.code !== undefined && RATE_LIMIT_ERROR_CODES.has(error.code)) ||
    error.status === 429
  );
}

export function requestLoginCodeOutcomeFromError(
  error: AuthErrorLike | null,
): RequestLoginCodeOutcome {
  if (!error) return "CODE_SENT";
  if (error.code === HIDDEN_EMAIL_SEND_LIMIT_ERROR_CODE) return "CODE_SENT";
  if (isRateLimited(error)) return "RATE_LIMITED";
  if (error.code && NOT_INVITED_ERROR_CODES.has(error.code)) return "CODE_SENT";
  if (error.code && INVALID_EMAIL_ERROR_CODES.has(error.code)) {
    return "INVALID_EMAIL";
  }
  return "UNAVAILABLE";
}

export function verifyLoginCodeFailureFromError(
  error: AuthErrorLike,
): VerifyLoginCodeFailure {
  if (isRateLimited(error)) return "RATE_LIMITED";
  if (
    (error.code && WRONG_CODE_ERROR_CODES.has(error.code)) ||
    error.status === 403
  ) {
    return "WRONG_OR_EXPIRED_CODE";
  }
  return "UNAVAILABLE";
}

/** Strips spaces and dashes people type or paste; null unless exactly the code's digits remain. */
export function normalizeLoginCode(rawCode: string): string | null {
  const digitsOnly = rawCode.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${LOGIN_CODE_LENGTH}}$`).test(digitsOnly)
    ? digitsOnly
    : null;
}
