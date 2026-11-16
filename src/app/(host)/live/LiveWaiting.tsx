"use client";

import {
  CARD_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { SkillChip } from "@/components/SkillChip";
import type { LiveCommand, LivePlayer } from "@/server/live/liveTypes";

export function LiveWaiting({
  players,
  now,
  disabled,
  onAction,
}: {
  players: LivePlayer[];
  now: number;
  disabled: boolean;
  onAction: (command: LiveCommand) => void;
}) {
  const waiting = players.filter((player) => player.status === "waiting");
  const resting = players.filter((player) => player.status === "skipped");
  return (
    <section
      id="waiting"
      aria-labelledby="waiting-heading"
      className={CARD_CLASS_NAME}
    >
      <h2 id="waiting-heading" className="text-xl font-bold">
        Waiting <span className="text-muted">({waiting.length})</span>
      </h2>
      <p className="mt-1 text-sm text-muted">
        Longest wait first. Called players keep waiting until their game starts.
      </p>
      {waiting.length ? (
        <ul className="mt-4 flex flex-col gap-2">
          {waiting.map((player, index) => (
            <li
              className="flex flex-wrap items-center gap-3 rounded-[18px] border border-inner-border bg-inner p-3"
              key={player.participantId}
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold break-words">
                  {index + 1}. {player.name}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <SkillChip skillLevel={player.skill} />
                  <span>
                    {player.calledCourtName
                      ? `Called · ${player.calledCourtName}`
                      : "Waiting"}
                  </span>
                </div>
              </div>
              <p className="font-bold tabular-nums">
                {Math.floor((player.currentWaitMs ?? 0) / 60_000)} min
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={OUTLINE_BUTTON_CLASS_NAME}
                  disabled={disabled}
                  aria-label={`Rest ${player.name}`}
                  onClick={() =>
                    onAction({
                      kind: "rest",
                      participantId: player.participantId,
                    })
                  }
                >
                  Rest 10 min
                </button>
                <button
                  type="button"
                  className={OUTLINE_BUTTON_CLASS_NAME}
                  disabled={disabled}
                  aria-label={`Mark ${player.name} as left`}
                  onClick={() =>
                    onAction({
                      kind: "leave",
                      participantId: player.participantId,
                    })
                  }
                >
                  Left
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-muted">No players waiting.</p>
      )}
      <h3 className="mt-5 text-lg font-bold">
        Resting <span className="text-muted">({resting.length})</span>
      </h3>
      <p className="mt-1 text-sm text-muted">
        Earned waiting time is frozen during rest. Players return automatically
        after ten minutes.
      </p>
      {resting.length ? (
        <ul className="mt-3 flex flex-col gap-2">
          {resting.map((player) => (
            <li
              key={player.participantId}
              className="flex flex-wrap items-center gap-3 rounded-[18px] border border-inner-border bg-inner p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold break-words">{player.name}</p>
                <p className="text-sm text-muted tabular-nums">
                  {player.returnsAt
                    ? `Returns in ${Math.max(0, Math.ceil((player.returnsAt - now) / 60_000))} min`
                    : "Resting"}{" "}
                  · {Math.floor((player.currentWaitMs ?? 0) / 60_000)} min wait
                  kept
                </p>
              </div>
              <button
                type="button"
                className={OUTLINE_BUTTON_CLASS_NAME}
                disabled={disabled || player.skipSeq === null}
                aria-label={`Ready now ${player.name}`}
                onClick={() =>
                  onAction({
                    kind: "ready",
                    participantId: player.participantId,
                    targetSeq: player.skipSeq!,
                  })
                }
              >
                Ready now
              </button>
              <button
                type="button"
                className={OUTLINE_BUTTON_CLASS_NAME}
                disabled={disabled}
                aria-label={`Mark ${player.name} as left`}
                onClick={() =>
                  onAction({
                    kind: "leave",
                    participantId: player.participantId,
                  })
                }
              >
                Left
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-muted">Nobody resting.</p>
      )}
    </section>
  );
}
