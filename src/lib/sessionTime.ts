// Pure session time formatting shared by the host screens and the public
// check-in page. Times are shown in the browser's own time zone (there is no
// club time zone setting yet), so callers render them in the browser only.

import { INTL_LOCALES, type Locale } from "@/i18n/locales";

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** "18:00" in the browser's time zone (also the value of <input type="time">). */
export function formatLocalClockTime(date: Date): string {
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/** "Sat 7 Nov · 18:00 – 20:00" ("Th 7, 7 thg 11 · …" in Vietnamese) in the browser's time zone. */
export function formatSessionWhen(
  plannedStart: Date,
  plannedEnd: Date,
  locale: Locale = "en",
): string {
  const day = plannedStart.toLocaleDateString(INTL_LOCALES[locale], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${day} · ${formatLocalClockTime(plannedStart)} – ${formatLocalClockTime(plannedEnd)}`;
}
