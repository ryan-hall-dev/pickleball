import type { Locale } from "@/i18n/locales";
import type { Messages } from "@/i18n/messages";
import { formatLocalClockTime, formatSessionWhen } from "@/lib/sessionTime";
import type { CheckinSessionHeader } from "@/server/checkin/checkinResults";

const MS_PER_MINUTE = 60_000;

/** Whole minutes remaining according to the database clock, rounded up. */
export function formatTimeLeft(
  endsAt: string,
  now: string,
  messages: Messages,
): string | null {
  const minutesLeft = (Date.parse(endsAt) - Date.parse(now)) / MS_PER_MINUTE;
  if (!Number.isFinite(minutesLeft) || minutesLeft <= 0) return null;
  return messages.time.minutesLeft(Math.ceil(minutesLeft));
}

type SessionTiming = Pick<
  CheckinSessionHeader,
  "status" | "durationMinutes" | "startedAt" | "endsAt"
>;

/** Drafts promise a duration, never a scheduled first-game time. */
export function formatCheckinSessionWhen(
  session: SessionTiming,
  messages: Messages,
  locale: Locale,
): string {
  if (session.status === "draft")
    return session.durationMinutes === null
      ? messages.time.durationUnavailable
      : messages.time.sessionMinutes(session.durationMinutes);
  if (session.startedAt === null) return messages.time.startTimeUnavailable;
  if (session.endsAt === null) {
    // The actual start is recorded but the saved duration is unusable: say
    // when it started and nothing about when it ends.
    return messages.time.startedEndUnavailable(
      formatLocalClockTime(new Date(session.startedAt)),
    );
  }
  return formatSessionWhen(
    new Date(session.startedAt),
    new Date(session.endsAt),
    locale,
  );
}

export function formatCheckinHeaderWhen(
  session: SessionTiming,
  now: string,
  messages: Messages,
  locale: Locale,
): string {
  const when = formatCheckinSessionWhen(session, messages, locale);
  if (session.status === "draft" || session.endsAt === null) return when;
  const timeLeft = formatTimeLeft(session.endsAt, now, messages);
  return `${when} · ${timeLeft ?? messages.time.sessionTimeIsUp}`;
}
