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
/** DESIGN.md: a wait of 15 min or more is shown in orange. */
const LONG_WAIT_MS = 15 * 60_000;

const PHONE_LIST_CLASS_NAME = "max-sm:mt-2 max-sm:gap-0";
const ROW_CLASS_NAME =
  "rounded-[18px] border border-inner-border bg-inner p-3 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-center max-sm:gap-x-2 max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:border-card-border max-sm:bg-transparent max-sm:py-2 max-sm:pr-2 max-sm:pl-3";
const BUTTONS_CLASS_NAME =
  "mt-3 grid grid-cols-[1fr_auto] gap-2 sm:max-w-xs max-sm:col-start-2 max-sm:row-span-2 max-sm:row-start-1 max-sm:mt-0 max-sm:flex max-sm:gap-1.5";

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
      className={`${OUTLINE_BUTTON_CLASS_NAME} mt-3 w-full max-sm:mx-3 max-sm:mb-3 max-sm:w-[calc(100%-24px)]`}
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
      className={`${CARD_CLASS_NAME} scroll-mt-16 max-sm:px-0 max-sm:pt-2.5 max-sm:pb-0`}
    >
      {/* Phones (Design A): heading and hint on one line, then rows divided
          by thin lines with their buttons on the right. */}
      <div className="max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:justify-between max-sm:gap-x-2 max-sm:px-3">
        <h2 id="waiting-heading" className="text-xl font-bold max-sm:text-base">
          {text.heading} <span className="text-muted">({waiting.length})</span>
        </h2>
        <p className="mt-1 text-xs text-muted max-sm:mt-0">
          {text.longestFirst}
        </p>
      </div>
      {waiting.length ? (
        <ul className={`mt-4 flex flex-col gap-2 ${PHONE_LIST_CLASS_NAME}`}>
          {shownWaiting.map((player, index) => (
            <li className={ROW_CLASS_NAME} key={player.participantId}>
              {/* The name always gets its own full line; the wait time sits
                  beside it and never squeezes it. */}
              <div className="flex items-start justify-between gap-3 max-sm:col-start-1 max-sm:flex-wrap max-sm:justify-start max-sm:gap-x-1.5 max-sm:gap-y-0">
                <p className="min-w-0 flex-1 font-semibold break-words max-sm:flex-initial">
                  {index + 1}. {player.name}
                </p>
                <p
                  className={`shrink-0 font-bold whitespace-nowrap tabular-nums ${
                    (player.currentWaitMs ?? 0) >= LONG_WAIT_MS
                      ? "max-sm:text-orange-soft"
                      : ""
                  }`}
                >
                  {text.minutes(
                    Math.floor((player.currentWaitMs ?? 0) / 60_000),
                  )}
                </p>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted max-sm:col-start-1 max-sm:mt-0.5">
                <SkillChip skillLevel={player.skill} />
                <span>
                  {player.calledCourtName
                    ? text.calledTo(courtName(player.calledCourtName, messages))
                    : text.waiting}
                </span>
              </div>
              <div className={BUTTONS_CLASS_NAME}>
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
        <p className="mt-4 text-muted max-sm:mt-2 max-sm:px-3 max-sm:pb-3">
          {text.noneWaiting}
        </p>
      )}
      <FoldButton
        expanded={waitingExpanded}
        hiddenCount={waiting.length - VISIBLE_WHEN_FOLDED}
        showAll={text.showAllWaiting}
        showFewer={text.showFewerWaiting}
        onToggle={() => setWaitingExpanded((open) => !open)}
      />
      <h3 className="mt-5 text-lg font-bold max-sm:mt-3 max-sm:px-3 max-sm:text-[15px]">
        {text.resting} <span className="text-muted">({resting.length})</span>
      </h3>
      <p className="mt-1 text-xs text-muted max-sm:mt-0 max-sm:px-3">
        {text.restingHint}
      </p>
      {resting.length ? (
        <ul className={`mt-3 flex flex-col gap-2 ${PHONE_LIST_CLASS_NAME}`}>
          {shownResting.map((player) => (
            <li key={player.participantId} className={ROW_CLASS_NAME}>
              <p className="font-semibold break-words max-sm:col-start-1">
                {player.name}
              </p>
              <p className="mt-1 text-xs text-muted tabular-nums max-sm:col-start-1 max-sm:mt-0.5">
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
              <div className={BUTTONS_CLASS_NAME}>
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
        <p className="mt-3 text-muted max-sm:mt-1 max-sm:px-3 max-sm:pb-3">
          {text.nobodyResting}
        </p>
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
