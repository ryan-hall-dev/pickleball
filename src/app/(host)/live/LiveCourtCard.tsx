"use client";

import { useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  CARD_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import { SKILL_LEVEL_LABELS } from "@/server/skillLevels";
import { GENDER_LABELS } from "@/server/participantRules";
import type {
  LiveCommand,
  LiveCourt,
  LivePlayer,
  LiveSessionView,
  LiveTeams,
} from "@/server/live/liveTypes";
import { CourtRecovery } from "./CourtRecovery";

function Teams({
  teams,
  players,
}: {
  teams: LiveTeams;
  players: LivePlayer[];
}) {
  const name = (id: string | null) =>
    id === null
      ? "Replacement needed"
      : (players.find((player) => player.participantId === id)?.name ??
        "Player unavailable");
  return (
    <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
      <div>
        {teams.teamA.map((id, index) => (
          <p
            className="py-1 font-semibold break-words"
            key={id ?? `vacant-${index}`}
          >
            {name(id)}
          </p>
        ))}
      </div>
      <span className="text-xs text-muted">vs</span>
      <div>
        {teams.teamB.map((id, index) => (
          <p
            className="py-1 font-semibold break-words"
            key={id ?? `vacant-${index}`}
          >
            {name(id)}
          </p>
        ))}
      </div>
    </div>
  );
}

export function LiveCourtCard({
  court,
  players,
  now,
  timeIsUp,
  disabled,
  selected,
  onPrepare,
  onAction,
  undoOptions,
}: {
  court: LiveCourt;
  players: LivePlayer[];
  now: number;
  timeIsUp: boolean;
  disabled: boolean;
  selected: boolean;
  onPrepare: () => void;
  onAction: (command: LiveCommand) => void;
  undoOptions: LiveSessionView["undoOptions"];
}) {
  const [editing, setEditing] = useState(false);
  const group = court.called ?? court.suggestion;
  const vacancy =
    court.called &&
    [...court.called.teamA, ...court.called.teamB].some((id) => id === null);
  return (
    <article className={CARD_CLASS_NAME} aria-label={court.name}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold">{court.name}</h3>
        <span
          className={`text-sm font-semibold ${court.activeMatch ? "text-lime-soft" : "text-muted"}`}
        >
          {court.activeMatch
            ? `Playing · ${Math.max(0, Math.floor((now - court.activeMatch.startedAt) / 60_000))} min`
            : court.called
              ? "Group prepared"
              : "Court free"}
        </span>
      </header>
      {court.activeMatch ? (
        <>
          <Teams teams={court.activeMatch} players={players} />
          <button
            className={`${PRIMARY_BUTTON_CLASS_NAME} mt-4`}
            type="button"
            disabled={disabled}
            onClick={() =>
              onAction({ kind: "finish", matchId: court.activeMatch!.matchId })
            }
          >
            Game finished
          </button>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted">
          {court.called
            ? "Press Start game when all four are on court. Nobody is playing yet."
            : "No game on this court."}
        </p>
      )}
      <CourtRecovery
        key={court.activeMatch?.matchId ?? "idle"}
        court={court}
        players={players}
        undoOptions={undoOptions}
        disabled={disabled}
        onAction={onAction}
      />
      <section
        aria-label={`Up next for ${court.name}`}
        className="mt-5 rounded-[20px] border border-blue-edge bg-blue-surface p-4"
      >
        <h4 className="font-bold text-blue-soft">
          {court.called && !court.activeMatch ? "Ready to start" : "Up next"}
          {court.called && court.activeMatch ? " · Prepared" : ""}
        </h4>
        {timeIsUp ? (
          <p className="mt-2 text-sm text-muted">
            Session time is up, so no new groups can be called and no game can
            start. Finish active games, then end the session.
          </p>
        ) : group ? (
          <>
            <Teams teams={group} players={players} />
            <p className="mt-2 text-sm text-blue-soft">
              {court.called
                ? "Fixed for co-hosts. Waiting continues until the game starts."
                : "Longest eligible waits. Call to fix this group."}
            </p>
            {vacancy && (
              <div className="mt-2">
                <AttentionMessage>
                  A called player is unavailable. Choose a valid replacement
                  before starting.
                </AttentionMessage>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {court.called ? (
                <button
                  type="button"
                  className={SECONDARY_BUTTON_CLASS_NAME}
                  disabled={disabled || !!court.activeMatch || !!vacancy}
                  onClick={() =>
                    onAction({
                      kind: "start",
                      courtId: court.courtId,
                      calledEventId: court.called!.calledEventId,
                      matchId: crypto.randomUUID(),
                    })
                  }
                >
                  Start game
                </button>
              ) : (
                <button
                  type="button"
                  className={SECONDARY_BUTTON_CLASS_NAME}
                  disabled={disabled}
                  onClick={() =>
                    onAction({
                      kind: "call",
                      courtId: court.courtId,
                      teamA: group.teamA as string[],
                      teamB: group.teamB as string[],
                    })
                  }
                >
                  Call these four
                </button>
              )}
              <button
                type="button"
                className={OUTLINE_BUTTON_CLASS_NAME}
                disabled={disabled}
                aria-expanded={editing}
                onClick={() => setEditing((value) => !value)}
              >
                Change players
              </button>
              {court.called && (
                <button
                  type="button"
                  className={OUTLINE_BUTTON_CLASS_NAME}
                  disabled={disabled}
                  onClick={() =>
                    onAction({
                      kind: "release",
                      calledEventId: court.called!.calledEventId,
                    })
                  }
                >
                  Release group
                </button>
              )}
            </div>
            {editing && (
              <GroupEditor
                key={`${court.called?.calledEventId ?? "suggested"}:${[...group.teamA, ...group.teamB].join()}`}
                court={court}
                players={players}
                teams={group}
                disabled={disabled}
                onSave={(teamA, teamB) => {
                  onAction(
                    court.called
                      ? {
                          kind: "change",
                          calledEventId: court.called.calledEventId,
                          teamA,
                          teamB,
                        }
                      : { kind: "call", courtId: court.courtId, teamA, teamB },
                  );
                  setEditing(false);
                }}
              />
            )}
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted">
              {court.activeMatch
                ? selected
                  ? "Not enough available players for four men, four women, or valid mixed teams. Playing and resting players are unavailable."
                  : "Choose this court to prepare its next group. Court numbers do not set player priority."
                : "Waiting for four available players (four men, four women, or mixed teams). Players who are playing, resting or prepared on another court don't count. A group is prepared here automatically; use Prepare next four only after a host released this court's group."}
            </p>
            <button
              type="button"
              className={`${SECONDARY_BUTTON_CLASS_NAME} mt-3`}
              disabled={disabled}
              onClick={onPrepare}
            >
              {selected ? "Refresh next four" : "Prepare next four"}
            </button>
          </>
        )}
      </section>
    </article>
  );
}

function GroupEditor({
  court,
  players,
  teams,
  disabled,
  onSave,
}: {
  court: LiveCourt;
  players: LivePlayer[];
  teams: LiveTeams;
  disabled: boolean;
  onSave: (teamA: string[], teamB: string[]) => void;
}) {
  const [ids, setIds] = useState(
    [...teams.teamA, ...teams.teamB].map((id) => id ?? ""),
  );
  const options = players.filter(
    (player) =>
      player.status === "waiting" &&
      (!player.calledCourtId || player.calledCourtId === court.courtId),
  );
  const distinct = ids.every(Boolean) && new Set(ids).size === 4;
  return (
    <div className="mt-4 border-t border-blue-edge pt-3">
      <p className="text-sm text-blue-soft">
        Choose two per team. Mixed teams need one man and one woman on each
        team.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {ids.map((id, index) => (
          <label key={index} className="text-sm text-muted">
            Team {index < 2 ? "A" : "B"} · Player {(index % 2) + 1}
            <select
              className={`${TEXT_INPUT_CLASS_NAME} mt-1`}
              value={id}
              disabled={disabled}
              onChange={(event) =>
                setIds((current) =>
                  current.map((value, position) =>
                    position === index ? event.target.value : value,
                  ),
                )
              }
            >
              <option value="">Choose player</option>
              {options.map((player) => (
                <option value={player.participantId} key={player.participantId}>
                  {player.name} ·{" "}
                  {player.gender
                    ? GENDER_LABELS[player.gender]
                    : "Gender missing"}{" "}
                  ·{" "}
                  {player.skill
                    ? SKILL_LEVEL_LABELS[player.skill]
                    : "Level missing"}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <button
        type="button"
        className={`${SECONDARY_BUTTON_CLASS_NAME} mt-3`}
        disabled={disabled || !distinct}
        onClick={() => onSave(ids.slice(0, 2), ids.slice(2))}
      >
        {court.called ? "Confirm changed group" : "Call chosen four"}
      </button>
    </div>
  );
}
