import { formatSessionWhen } from "@/lib/sessionTime";
import type { CheckinSessionHeader } from "@/server/checkin/checkinResults";

// Pure copy for the check-in header (P1-P5): "Sat 7 Nov · 18:00 – 20:00 ·
// 80 min left" and the "~6m to first game" tile. Times count from the
// database's `now` in the page read, so every phone agrees.

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

function minutesFromNowUntil(isoTime: string, isoNow: string): number | null {
  const milliseconds = Date.parse(isoTime) - Date.parse(isoNow);
  return Number.isFinite(milliseconds) ? milliseconds / MS_PER_MINUTE : null;
}

/** "80 min left" until the planned end (rounded up), or null once it has passed. */
export function formatTimeLeft(plannedEnd: string, now: string): string | null {
  const minutesLeft = minutesFromNowUntil(plannedEnd, now);
  if (minutesLeft === null || minutesLeft <= 0) return null;
  return `${Math.ceil(minutesLeft)} min left`;
}

/**
 * The "to first game" tile's value, estimated from the planned start:
 * "~6m" (rounded up), whole hours ("~2h") from an hour away so it fits the
 * tile, and "Now" once the planned start has passed.
 */
export function formatFirstGameEstimate(
  plannedStart: string,
  now: string,
): string {
  const minutesToStart = minutesFromNowUntil(plannedStart, now);
  if (minutesToStart === null || minutesToStart <= 0) return "Now";
  const roundedUpMinutes = Math.ceil(minutesToStart);
  if (roundedUpMinutes < MINUTES_PER_HOUR) return `~${roundedUpMinutes}m`;
  return `~${Math.round(roundedUpMinutes / MINUTES_PER_HOUR)}h`;
}

/** "Sat 7 Nov · 18:00 – 20:00" in the browser's time zone. */
export function formatCheckinSessionWhen(
  session: Pick<CheckinSessionHeader, "plannedStart" | "plannedEnd">,
): string {
  return formatSessionWhen(
    new Date(session.plannedStart),
    new Date(session.plannedEnd),
  );
}

/** The header's date line, with the time left when the session hasn't ended. */
export function formatCheckinHeaderWhen(
  session: Pick<CheckinSessionHeader, "plannedStart" | "plannedEnd">,
  now: string,
): string {
  const timeLeft = formatTimeLeft(session.plannedEnd, now);
  const when = formatCheckinSessionWhen(session);
  return timeLeft ? `${when} · ${timeLeft}` : when;
}
