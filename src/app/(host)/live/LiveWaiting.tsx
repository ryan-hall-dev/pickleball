"use client";

import { useState } from "react";
import {
  CARD_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { SkillChip } from "@/components/SkillChip";
import { courtName } from "@/i18n/courtName";
import { useMessages } from "@/i18n/LocaleProvider";
import type { LiveCommand, LivePlayer } from "@/server/live/liveTypes";

const VISIBLE_WHEN_FOLDED = 3;

function FoldButton({
  expanded,
  hiddenCount,
  showAll,
  showFewer,
  onToggle,
}: {
  expanded: boolean;
  hiddenCount: number;
  showAll: (count: number) => string;
  showFewer: string;
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
      {expanded ? showFewer : showAll(hiddenCount + VISIBLE_WHEN_FOLDED)}
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
  const messages = useMessages();
  const text = messages.host.live.waitingList;
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
        {text.heading} <span className="text-muted">({waiting.length})</span>
      </h2>
      <p className="mt-1 text-xs text-muted">{text.longestFirst}</p>
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
                  {text.minutes(
                    Math.floor((player.currentWaitMs ?? 0) / 60_000),
                  )}
                </p>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <SkillChip skillLevel={player.skill} />
                <span>
                  {player.calledCourtName
                    ? text.calledTo(courtName(player.calledCourtName, messages))
                    : text.waiting}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 sm:max-w-xs">
                <button
                  type="button"
                  className={OUTLINE_BUTTON_CLASS_NAME}
                  disabled={disabled}
                  aria-label={text.restName(player.name)}
                  onClick={() =>
                    onAction({
                      kind: "rest",
                      participantId: player.participantId,
                    })
                  }
                >
                  {text.rest}
                </button>
                <button
                  type="button"
                  className={OUTLINE_BUTTON_CLASS_NAME}
                  disabled={disabled}
                  aria-label={text.leftName(player.name)}
                  onClick={() =>
                    onAction({
                      kind: "leave",
                      participantId: player.participantId,
                    })
                  }
                >
                  {text.left}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-muted">{text.noneWaiting}</p>
      )}
      <FoldButton
        expanded={waitingExpanded}
        hiddenCount={waiting.length - VISIBLE_WHEN_FOLDED}
        showAll={text.showAllWaiting}
        showFewer={text.showFewerWaiting}
        onToggle={() => setWaitingExpanded((open) => !open)}
      />
      <h3 className="mt-5 text-lg font-bold">
        {text.resting} <span className="text-muted">({resting.length})</span>
      </h3>
      <p className="mt-1 text-xs text-muted">{text.restingHint}</p>
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
                  ? text.returnsIn(
                      Math.max(0, Math.ceil((player.returnsAt - now) / 60_000)),
                    )
                  : text.resting}{" "}
                ·{" "}
                {text.waitKept(
                  Math.floor((player.currentWaitMs ?? 0) / 60_000),
                )}
              </p>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 sm:max-w-xs">
                <button
                  type="button"
                  className={OUTLINE_BUTTON_CLASS_NAME}
                  disabled={disabled || player.skipSeq === null}
                  aria-label={text.readyNowName(player.name)}
                  onClick={() =>
                    onAction({
                      kind: "ready",
                      participantId: player.participantId,
                      targetSeq: player.skipSeq!,
                    })
                  }
                >
                  {text.readyNow}
                </button>
                <button
                  type="button"
                  className={OUTLINE_BUTTON_CLASS_NAME}
                  disabled={disabled}
                  aria-label={text.leftName(player.name)}
                  onClick={() =>
                    onAction({
                      kind: "leave",
                      participantId: player.participantId,
                    })
                  }
                >
                  {text.left}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-muted">{text.nobodyResting}</p>
      )}
      <FoldButton
        expanded={restingExpanded}
        hiddenCount={resting.length - VISIBLE_WHEN_FOLDED}
        showAll={text.showAllResting}
        showFewer={text.showFewerResting}
        onToggle={() => setRestingExpanded((open) => !open)}
      />
    </section>
  );
}
