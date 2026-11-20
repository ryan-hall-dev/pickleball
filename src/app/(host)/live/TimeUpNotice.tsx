"use client";

import { PRIMARY_BUTTON_CLASS_NAME } from "@/components/controlStyles";
import { useMessages } from "@/i18n/LocaleProvider";

/**
 * Shown from the planned end until a host confirms End. The deadline never
 * ends a session by itself: waiting times keep counting until a host does, so
 * the notice says so, and says what is blocking End when games are on court.
 */
export function TimeUpNotice({
  activeCourtNames,
  disabled,
  onEnd,
}: {
  activeCourtNames: string[];
  disabled: boolean;
  onEnd: () => void;
}) {
  const messages = useMessages();
  const text = messages.host.live.timeUp;
  const blocked = activeCourtNames.length > 0;
  return (
    <section
      aria-labelledby="time-up-heading"
      className="rounded-3xl border border-orange-edge bg-orange-surface p-5"
    >
      <h2 id="time-up-heading" className="text-xl font-extrabold">
        <span
          aria-hidden="true"
          className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-orange text-sm text-on-orange"
        >
          !
        </span>
        {text.title}
      </h2>
      <p className="mt-2 text-sm text-orange-text">{text.text}</p>
      {blocked && (
        <p id="time-up-active-games" className="mt-2 text-sm text-orange-text">
          {text.stillOnCourt(activeCourtNames.join(", "))}
        </p>
      )}
      <button
        type="button"
        className={`${PRIMARY_BUTTON_CLASS_NAME} mt-4`}
        disabled={disabled || blocked}
        aria-describedby={blocked ? "time-up-active-games" : undefined}
        onClick={onEnd}
      >
        {messages.host.live.endSession}
      </button>
    </section>
  );
}
