// Pure session time formatting shared by the host screens and the public
// check-in page. Times are shown in the browser's own time zone (there is no
// club time zone setting yet), so callers render them in the browser only.

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** "18:00" in the browser's time zone (also the value of <input type="time">). */
export function formatLocalClockTime(date: Date): string {
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/** "Sat 7 Nov · 18:00 – 20:00" in the browser's time zone. */
export function formatSessionWhen(
  plannedStart: Date,
  plannedEnd: Date,
): string {
  const day = plannedStart.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${day} · ${formatLocalClockTime(plannedStart)} – ${formatLocalClockTime(plannedEnd)}`;
}
