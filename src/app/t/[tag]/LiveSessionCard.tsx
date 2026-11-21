"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import type { OpenCheckinPage } from "@/server/checkin/checkinResults";
import { formatCheckinHeaderWhen } from "./checkinHeaderFormatting";

/** Public session details follow the recorded lifecycle, never draft forecasts. */
export function LiveSessionCard({ page }: { page: OpenCheckinPage }) {
  const { locale, messages } = useLocale();
  const copy = messages.checkin.sessionCard;
  const { session, now } = page;
  const stats = [
    { value: String(session.courtsCount), label: copy.courts },
    { value: String(session.checkedInCount), label: copy.checkedIn },
    {
      value:
        session.durationMinutes === null
          ? copy.unavailable
          : messages.time.minutes(session.durationMinutes),
      label: copy.duration,
    },
  ];
  return (
    <section
      aria-labelledby="checkin-session-name"
      className="rounded-card border border-card-border bg-card p-[18px]"
    >
      <p className="flex items-center gap-2 text-xs font-bold tracking-[0.12em] text-lime-ink uppercase">
        <span aria-hidden="true" className="size-[7px] rounded-full bg-lime" />
        {session.status === "draft" ? copy.notStarted : copy.liveNow}
      </p>
      <h1
        id="checkin-session-name"
        className="mt-2 mb-0.5 text-[26px] leading-[1.12] font-extrabold tracking-[-0.01em] break-words"
      >
        {session.name}
      </h1>
      <p className="text-sm text-muted tabular-nums">
        {formatCheckinHeaderWhen(session, now, messages, locale)}
      </p>
      <dl className="mt-3.5 grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          // The value is drawn above its label, but read after it.
          <div
            key={stat.label}
            className="flex min-w-0 flex-col-reverse rounded-[14px] bg-inner px-3 py-2.5"
          >
            <dt className="text-xs text-muted">{stat.label}</dt>
            <dd className="text-xl font-bold break-words tabular-nums">
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
