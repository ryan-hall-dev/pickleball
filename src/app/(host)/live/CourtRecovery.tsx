"use client";

import { useState } from "react";
import {
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import { courtName } from "@/i18n/courtName";
import { useMessages } from "@/i18n/LocaleProvider";
import type {
  LiveCommand,
  LiveCourt,
  LivePlayer,
  LiveSessionView,
} from "@/server/live/liveTypes";

export function CourtRecovery({
  court,
  players,
  undoOptions,
  disabled,
  onAction,
}: {
  court: LiveCourt;
  players: LivePlayer[];
  undoOptions: LiveSessionView["undoOptions"];
  disabled: boolean;
  onAction: (command: LiveCommand) => void;
}) {
  const text = useMessages().host.live.recovery;
  const [choice, setChoice] = useState<"replace" | "interrupt" | null>(null);
  const match = court.activeMatch;
  if (!match && undoOptions.length === 0) return null;
  return (
    <details className="mt-3 rounded-[14px] border border-outline p-3 max-sm:rounded-xl max-sm:px-2.5 max-sm:py-0.5">
      <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
        {text.courtOptions}
      </summary>
      <div className="mt-2 flex flex-wrap gap-2 max-sm:mt-0 max-sm:mb-2 max-sm:gap-1.5">
        {match && (
          <>
            <button
              type="button"
              className={OUTLINE_BUTTON_CLASS_NAME}
              disabled={disabled}
              onClick={() => setChoice("replace")}
            >
              {text.replacePlayer}
            </button>
            <button
              type="button"
              className={OUTLINE_BUTTON_CLASS_NAME}
              disabled={disabled}
              onClick={() => setChoice("interrupt")}
            >
              {text.endAsInterrupted}
            </button>
          </>
        )}
        {undoOptions.map((option) => (
          <button
            key={option.targetSeq}
            type="button"
            className={OUTLINE_BUTTON_CLASS_NAME}
            disabled={disabled}
            onClick={() =>
              onAction({ kind: "undo", targetSeq: option.targetSeq })
            }
          >
            {option.kind === "start" ? text.undoStart : text.undoFinish}
          </button>
        ))}
      </div>
      {match && choice === "replace" && (
        <ReplacementForm
          key={`${match.matchId}:${[...match.teamA, ...match.teamB].join()}`}
          court={court}
          players={players}
          disabled={disabled}
          onCancel={() => setChoice(null)}
          onReplace={(outId, inId) => {
            onAction({ kind: "replace", matchId: match.matchId, outId, inId });
            setChoice(null);
          }}
        />
      )}
      {match && choice === "interrupt" && (
        <div
          className="mt-4 rounded-[14px] border border-orange-edge bg-orange-surface p-4"
          role="group"
          aria-label={text.confirmInterruptedLabel}
        >
          <p className="font-semibold text-orange-soft">
            {text.interruptTitle}
          </p>
          <p className="mt-2 text-sm text-muted">{text.interruptText}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={OUTLINE_BUTTON_CLASS_NAME}
              disabled={disabled}
              onClick={() => setChoice(null)}
            >
              {text.keepPlaying}
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS_NAME}
              disabled={disabled}
              onClick={() => {
                onAction({ kind: "interrupt", matchId: match.matchId });
                setChoice(null);
              }}
            >
              {text.confirmInterrupted}
            </button>
          </div>
        </div>
      )}
    </details>
  );
}

function ReplacementForm({
  court,
  players,
  disabled,
  onCancel,
  onReplace,
}: {
  court: LiveCourt;
  players: LivePlayer[];
  disabled: boolean;
  onCancel: () => void;
  onReplace: (outId: string, inId: string) => void;
}) {
  const messages = useMessages();
  const text = messages.host.live.recovery;
  const match = court.activeMatch!;
  const lineupIds = [...match.teamA, ...match.teamB].filter(
    (id): id is string => id !== null,
  );
  const [outId, setOutId] = useState(lineupIds[0] ?? "");
  const [inId, setInId] = useState("");
  const outgoing = players.find((player) => player.participantId === outId);
  // The replacement keeps the same seat: matching gender preserves valid teams.
  const candidates = players.filter(
    (player) =>
      player.status === "waiting" &&
      player.calledCourtId === null &&
      outgoing?.gender !== null &&
      player.gender === outgoing?.gender,
  );
  const valid =
    lineupIds.includes(outId) &&
    candidates.some((player) => player.participantId === inId);
  return (
    <form
      className="mt-4 flex flex-col gap-3"
      aria-label={text.replaceOn(courtName(court.name, messages))}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !disabled) onReplace(outId, inId);
      }}
    >
      <label className="text-sm text-muted">
        {text.leaving}
        <select
          className={`${TEXT_INPUT_CLASS_NAME} mt-1`}
          disabled={disabled}
          value={outId}
          onChange={(event) => {
            setOutId(event.target.value);
            setInId("");
          }}
        >
          {lineupIds.map((id) => (
            <option key={id} value={id}>
              {players.find((player) => player.participantId === id)?.name ??
                messages.host.live.court.playerUnavailable}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm text-muted">
        {text.replacement}
        <select
          className={`${TEXT_INPUT_CLASS_NAME} mt-1`}
          disabled={disabled || candidates.length === 0}
          value={inId}
          onChange={(event) => setInId(event.target.value)}
        >
          <option value="">{text.chooseAvailable}</option>
          {candidates.map((player) => (
            <option key={player.participantId} value={player.participantId}>
              {player.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-muted">{text.sameSeat}</p>
      {candidates.length === 0 && (
        <p role="status" className="text-sm text-orange-soft">
          {text.noReplacement}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={OUTLINE_BUTTON_CLASS_NAME}
          disabled={disabled}
          onClick={onCancel}
        >
          {text.cancelReplacement}
        </button>
        <button
          type="submit"
          className={SECONDARY_BUTTON_CLASS_NAME}
          disabled={disabled || !valid}
        >
          {text.confirmReplacement}
        </button>
      </div>
    </form>
  );
}
