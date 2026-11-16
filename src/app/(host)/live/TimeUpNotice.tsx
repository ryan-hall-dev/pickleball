import { PRIMARY_BUTTON_CLASS_NAME } from "@/components/controlStyles";

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
        Session time is up
      </h2>
      <p className="mt-2 text-sm text-orange-text">
        No new groups can be called and no new games can start. Waiting times
        keep counting until you end the session.
      </p>
      {blocked && (
        <p id="time-up-active-games" className="mt-2 text-sm text-orange-text">
          Still on court: {activeCourtNames.join(", ")}. Nothing is ended for
          you. Tap Game finished on each when it ends (or use Court options),
          then End session unlocks.
        </p>
      )}
      <button
        type="button"
        className={`${PRIMARY_BUTTON_CLASS_NAME} mt-4`}
        disabled={disabled || blocked}
        aria-describedby={blocked ? "time-up-active-games" : undefined}
        onClick={onEnd}
      >
        End session
      </button>
    </section>
  );
}
