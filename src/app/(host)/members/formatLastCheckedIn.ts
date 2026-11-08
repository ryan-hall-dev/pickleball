const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RELATIVE_DAYS_LIMIT = 7;

// No club time zone is configured yet, so older dates are shown in UTC; at
// worst a check-in near midnight shows the neighbouring day.
const DATE_WITH_YEAR_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
// The year is left out for this year's dates, so card captions fit one line.
const DATE_THIS_YEAR_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/**
 * Short enough for one line on a member card: "Never checked in", "Checked in
 * 5m ago", "… 3h ago", "… 4d ago", then a date after a week ("… 2 Mar", or
 * "… 2 Mar 2025" for an earlier year).
 */
export function formatLastCheckedIn(
  lastCheckedInAt: string | null,
  now: Date,
): string {
  if (!lastCheckedInAt) return "Never checked in";
  const checkedInAt = new Date(lastCheckedInAt);
  const elapsedMs = now.getTime() - checkedInAt.getTime();
  if (Number.isNaN(elapsedMs)) return "Never checked in";

  if (elapsedMs < MINUTE_MS) return "Checked in just now";
  if (elapsedMs < HOUR_MS) {
    return `Checked in ${Math.floor(elapsedMs / MINUTE_MS)}m ago`;
  }
  if (elapsedMs < DAY_MS) {
    return `Checked in ${Math.floor(elapsedMs / HOUR_MS)}h ago`;
  }
  const elapsedDays = Math.floor(elapsedMs / DAY_MS);
  if (elapsedDays < RELATIVE_DAYS_LIMIT) {
    return `Checked in ${elapsedDays}d ago`;
  }
  const dateFormat =
    checkedInAt.getUTCFullYear() === now.getUTCFullYear()
      ? DATE_THIS_YEAR_FORMAT
      : DATE_WITH_YEAR_FORMAT;
  return `Checked in ${dateFormat.format(checkedInAt)}`;
}
