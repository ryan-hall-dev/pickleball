"use client";

import { useState } from "react";
import {
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
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
  const [choice, setChoice] = useState<"replace" | "interrupt" | null>(null);
  const match = court.activeMatch;
  if (!match && undoOptions.length === 0) return null;
  return (
    <details className="mt-3 rounded-[14px] border border-outline p-3">
      <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
        Court options
      </summary>
      <div className="mt-2 flex flex-wrap gap-2">
        {match && (
          <>
            <button
              type="button"
              className={OUTLINE_BUTTON_CLASS_NAME}
              disabled={disabled}
              onClick={() => setChoice("replace")}
            >
              Replace player
            </button>
            <button
              type="button"
              className={OUTLINE_BUTTON_CLASS_NAME}
              disabled={disabled}
              onClick={() => setChoice("interrupt")}
            >
              End as interrupted
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
            Undo game {option.kind === "start" ? "start" : "finish"}
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
          aria-label="Confirm interrupted game"
        >
          <p className="font-semibold text-orange-soft">
            End this game as interrupted?
          </p>
          <p className="mt-2 text-sm text-muted">
            All four return to waiting with fresh waiting clocks. No completed
            game is counted. Rest is a separate action.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={OUTLINE_BUTTON_CLASS_NAME}
              disabled={disabled}
              onClick={() => setChoice(null)}
            >
              Keep playing
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
              Confirm interrupted game
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
      aria-label={`Replace player on ${court.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !disabled) onReplace(outId, inId);
      }}
    >
      <label className="text-sm text-muted">
        Player leaving the game
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
                "Player unavailable"}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm text-muted">
        Replacement player
        <select
          className={`${TEXT_INPUT_CLASS_NAME} mt-1`}
          disabled={disabled || candidates.length === 0}
          value={inId}
          onChange={(event) => setInId(event.target.value)}
        >
          <option value="">Choose an available player</option>
          {candidates.map((player) => (
            <option key={player.participantId} value={player.participantId}>
              {player.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-muted">
        The incoming player takes the same team and seat. Only the four who
        finish receive a completed-game credit.
      </p>
      {candidates.length === 0 && (
        <p role="status" className="text-sm text-orange-soft">
          No valid replacement is available. Choose another outgoing player or
          End as interrupted.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={OUTLINE_BUTTON_CLASS_NAME}
          disabled={disabled}
          onClick={onCancel}
        >
          Cancel replacement
        </button>
        <button
          type="submit"
          className={SECONDARY_BUTTON_CLASS_NAME}
          disabled={disabled || !valid}
        >
          Confirm replacement
        </button>
      </div>
    </form>
  );
}
