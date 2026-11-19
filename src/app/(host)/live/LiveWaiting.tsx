"use client";

import { useState } from "react";
import {
  CARD_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { SkillChip } from "@/components/SkillChip";
import type { LiveCommand, LivePlayer } from "@/server/live/liveTypes";

const VISIBLE_WHEN_FOLDED = 3;

function FoldButton({
  expanded,
  hiddenCount,
  label,
  onToggle,
}: {
  expanded: boolean;
  hiddenCount: number;
  label: string;
  onToggle: () => void;
}) {
  if (hiddenCount <= 0 && !expanded) return null;
  return (
    <button
      type="button"
      className={`${OUTLINE_BUTTON_CLASS_NAME} mt-3 w-full`}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded
        ? `Show fewer ${label}`
        : `Show all ${hiddenCount + VISIBLE_WHEN_FOLDED} ${label}`}
    </button>
  );
}

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
  // Kept in state so the 5 s refresh never folds a list the host opened.
  const [waitingExpanded, setWaitingExpanded] = useState(false);
  const [restingExpanded, setRestingExpanded] = useState(false);
  const shownWaiting = waitingExpanded
    ? waiting
    : waiting.slice(0, VISIBLE_WHEN_FOLDED);
  const shownResting = restingExpanded
    ? resting
    : resting.slice(0, VISIBLE_WHEN_FOLDED);
  return (
    <section
      id="waiting"
      aria-labelledby="waiting-heading"
      className={CARD_CLASS_NAME}
    >
      <h2 id="waiting-heading" className="text-xl font-bold">
        Waiting <span className="text-muted">({waiting.length})</span>
      </h2>
      <p className="mt-1 text-xs text-muted">Longest wait first.</p>
      {waiting.length ? (
        <ul className="mt-4 flex flex-col gap-2">
          {shownWaiting.map((player, index) => (
            <li
              className="rounded-[18px] border border-inner-border bg-inner p-3"
              key={player.participantId}
            >
              {/* The name always gets its own full line; the wait time sits
                  beside it and never squeezes it. */}
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 flex-1 font-semibold break-words">
                  {index + 1}. {player.name}
                </p>
                <p className="shrink-0 font-bold whitespace-nowrap tabular-nums">
                  {Math.floor((player.currentWaitMs ?? 0) / 60_000)} min
                </p>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <SkillChip skillLevel={player.skill} />
                <span>
                  {player.calledCourtName
                    ? `Called · ${player.calledCourtName}`
                    : "Waiting"}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 sm:max-w-xs">
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
      <FoldButton
        expanded={waitingExpanded}
        hiddenCount={waiting.length - VISIBLE_WHEN_FOLDED}
        label="waiting"
        onToggle={() => setWaitingExpanded((open) => !open)}
      />
      <h3 className="mt-5 text-lg font-bold">
        Resting <span className="text-muted">({resting.length})</span>
      </h3>
      <p className="mt-1 text-xs text-muted">
        Wait time is kept. Back automatically after 10 min.
      </p>
      {resting.length ? (
        <ul className="mt-3 flex flex-col gap-2">
          {shownResting.map((player) => (
            <li
              key={player.participantId}
              className="rounded-[18px] border border-inner-border bg-inner p-3"
            >
              <p className="font-semibold break-words">{player.name}</p>
              <p className="mt-1 text-xs text-muted tabular-nums">
                {player.returnsAt
                  ? `Returns in ${Math.max(0, Math.ceil((player.returnsAt - now) / 60_000))} min`
                  : "Resting"}{" "}
                · {Math.floor((player.currentWaitMs ?? 0) / 60_000)} min wait
                kept
              </p>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 sm:max-w-xs">
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
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-muted">Nobody resting.</p>
      )}
      <FoldButton
        expanded={restingExpanded}
        hiddenCount={resting.length - VISIBLE_WHEN_FOLDED}
        label="resting"
        onToggle={() => setRestingExpanded((open) => !open)}
      />
    </section>
  );
}
