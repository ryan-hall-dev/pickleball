import { formatLocalClockTime, formatSessionWhen } from "@/lib/sessionTime";
import type { CheckinSessionHeader } from "@/server/checkin/checkinResults";

const MS_PER_MINUTE = 60_000;

/** Whole minutes remaining according to the database clock, rounded up. */
export function formatTimeLeft(endsAt: string, now: string): string | null {
  const minutesLeft = (Date.parse(endsAt) - Date.parse(now)) / MS_PER_MINUTE;
  if (!Number.isFinite(minutesLeft) || minutesLeft <= 0) return null;
  return `${Math.ceil(minutesLeft)} min left`;
}

type SessionTiming = Pick<
  CheckinSessionHeader,
  "status" | "durationMinutes" | "startedAt" | "endsAt"
>;

/** Drafts promise a duration, never a scheduled first-game time. */
export function formatCheckinSessionWhen(session: SessionTiming): string {
  if (session.status === "draft")
    return session.durationMinutes === null
      ? "Duration unavailable"
      : `${session.durationMinutes} min session`;
  if (session.startedAt === null) return "Start time unavailable";
  if (session.endsAt === null) {
    // The actual start is recorded but the saved duration is unusable: say
    // when it started and nothing about when it ends.
    return `Started ${formatLocalClockTime(new Date(session.startedAt))} · end time unavailable`;
  }
  return formatSessionWhen(
    new Date(session.startedAt),
    new Date(session.endsAt),
  );
}

export function formatCheckinHeaderWhen(
  session: SessionTiming,
  now: string,
): string {
  const when = formatCheckinSessionWhen(session);
  if (session.status === "draft" || session.endsAt === null) return when;
  const timeLeft = formatTimeLeft(session.endsAt, now);
  return `${when} · ${timeLeft ?? "Session time is up"}`;
}
