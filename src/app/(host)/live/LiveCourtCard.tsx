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
import { courtName } from "@/i18n/courtName";
import { useMessages } from "@/i18n/LocaleProvider";
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
  const text = useMessages().host.live.court;
  const name = (id: string | null) =>
    id === null
      ? text.replacementNeeded
      : (players.find((player) => player.participantId === id)?.name ??
        text.playerUnavailable);
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
      <span className="text-xs text-muted">{text.versus}</span>
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
  const messages = useMessages();
  const text = messages.host.live.court;
  const shownCourtName = courtName(court.name, messages);
  const [editing, setEditing] = useState(false);
  const group = court.called ?? court.suggestion;
  const vacancy =
    court.called &&
    [...court.called.teamA, ...court.called.teamB].some((id) => id === null);
  return (
    <article className={CARD_CLASS_NAME} aria-label={shownCourtName}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold">{shownCourtName}</h3>
        <span
          className={`text-sm font-semibold ${court.activeMatch ? "text-lime-soft" : "text-muted"}`}
        >
          {court.activeMatch
            ? text.playingMinutes(
                Math.max(
                  0,
                  Math.floor((now - court.activeMatch.startedAt) / 60_000),
                ),
              )
            : court.called
              ? text.groupPrepared
              : text.courtFree}
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
            {text.gameFinished}
          </button>
        </>
      ) : court.called ? null : (
        <p className="mt-2 text-xs text-muted">{text.noGame}</p>
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
        aria-label={text.upNextFor(shownCourtName)}
        className="mt-5 rounded-[20px] border border-blue-edge bg-blue-surface p-4"
      >
        <h4 className="font-bold text-blue-soft">
          {court.called && !court.activeMatch ? text.readyToStart : text.upNext}
          {court.called && court.activeMatch ? text.prepared : ""}
        </h4>
        {timeIsUp ? (
          <p className="mt-2 text-xs text-muted">{text.timeIsUp}</p>
        ) : group ? (
          <>
            <Teams teams={group} players={players} />
            <p className="mt-2 text-xs text-blue-soft">
              {court.called ? text.fixed : text.longestWaitsFirst}
            </p>
            {vacancy && (
              <div className="mt-2">
                <AttentionMessage>
                  {text.calledPlayerUnavailable}
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
                  {text.startGame}
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
                  {text.callTheseFour}
                </button>
              )}
              <button
                type="button"
                className={OUTLINE_BUTTON_CLASS_NAME}
                disabled={disabled}
                aria-expanded={editing}
                onClick={() => setEditing((value) => !value)}
              >
                {text.changePlayers}
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
                  {text.releaseGroup}
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
                  ? text.notEnoughPlayers
                  : text.chooseToPrepare
                : text.waitingForFour}
            </p>
            <button
              type="button"
              className={`${SECONDARY_BUTTON_CLASS_NAME} mt-3`}
              disabled={disabled}
              onClick={onPrepare}
            >
              {selected ? text.refreshNextFour : text.prepareNextFour}
            </button>
          </>
        )}
      </section>
    </article>
  );
}

const PICKER_VISIBLE_WHEN_FOLDED = 5;
type Gender = NonNullable<LivePlayer["gender"]>;

/** Can the four seats still become a valid doubles group? `null` = not chosen yet. */
export function seatsCanBeValid(seats: ReadonlyArray<Gender | null>): boolean {
  const open = seats.flatMap((gender, seat) => (gender ? [] : [seat]));
  for (let mask = 0; mask < 1 << open.length; mask += 1) {
    const filled = [...seats];
    open.forEach((seat, bit) => {
      filled[seat] = mask & (1 << bit) ? "male" : "female";
    });
    const men = filled.filter((gender) => gender === "male").length;
    if (
      men === 0 ||
      men === 4 ||
      (men === 2 && filled[0] !== filled[1] && filled[2] !== filled[3])
    )
      return true;
  }
  return false;
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
  const messages = useMessages();
  const text = messages.host.live.picker;
  const [ids, setIds] = useState(
    [...teams.teamA, ...teams.teamB].map((id) => id ?? ""),
  );
  const [seat, setSeat] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const byId = (id: string) =>
    players.find((player) => player.participantId === id);
  const distinct = ids.every(Boolean) && new Set(ids).size === 4;
  const seatGenders = (replacing: number) =>
    ids.map((id, position) =>
      position === replacing || !id ? null : (byId(id)?.gender ?? null),
    );
  const choices =
    seat === null
      ? []
      : players
          .filter(
            (player) =>
              player.status === "waiting" &&
              (!player.calledCourtId ||
                player.calledCourtId === court.courtId) &&
              player.gender !== null &&
              !ids.includes(player.participantId) &&
              seatsCanBeValid(
                seatGenders(seat).map((gender, position) =>
                  position === seat ? player.gender : gender,
                ),
              ),
          )
          .sort(
            (left, right) =>
              (right.currentWaitMs ?? 0) - (left.currentWaitMs ?? 0),
          );
  const query = search.trim().toLowerCase();
  const matching = query
    ? choices.filter((player) => player.name.toLowerCase().includes(query))
    : choices;
  const shown =
    showAll || query ? matching : matching.slice(0, PICKER_VISIBLE_WHEN_FOLDED);
  return (
    <div className="mt-4 border-t border-blue-edge pt-3">
      <p className="text-sm text-blue-soft">{text.hint}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {ids.map((id, index) => (
          <button
            key={index}
            type="button"
            disabled={disabled}
            aria-pressed={seat === index}
            aria-label={text.seatLabel(
              index < 2 ? "A" : "B",
              (index % 2) + 1,
              (id && byId(id)?.name) || text.choosePlayerLower,
            )}
            className={`${OUTLINE_BUTTON_CLASS_NAME} h-auto min-h-11 flex-col items-start py-2 text-left ${seat === index ? "border-2 border-link" : ""}`}
            onClick={() => {
              setSeat(seat === index ? null : index);
              setSearch("");
              setShowAll(false);
            }}
          >
            <span className="text-xs font-normal text-muted">
              {text.seat(index < 2 ? "A" : "B", (index % 2) + 1)}
            </span>
            <span className="break-words">
              {(id && byId(id)?.name) || text.choosePlayer}
            </span>
          </button>
        ))}
      </div>
      {seat !== null && (
        <div className="mt-3 rounded-2xl border border-inner-border bg-inner p-3">
          <label className="text-sm text-muted">
            {text.searchPlayers}
            <input
              type="search"
              className={`${TEXT_INPUT_CLASS_NAME} mt-1`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={text.typeAName}
            />
          </label>
          {matching.length ? (
            <ul className="mt-3 flex flex-col gap-2">
              {shown.map((player) => (
                <li key={player.participantId}>
                  <button
                    type="button"
                    disabled={disabled}
                    className={`${OUTLINE_BUTTON_CLASS_NAME} h-auto min-h-11 w-full flex-col items-start py-2 text-left`}
                    onClick={() => {
                      setIds((current) =>
                        current.map((value, position) =>
                          position === seat ? player.participantId : value,
                        ),
                      );
                      setSeat(null);
                      setSearch("");
                    }}
                  >
                    <span className="break-words">{player.name}</span>
                    <span className="text-xs font-normal text-muted">
                      {text.waitMinutes(
                        Math.floor((player.currentWaitMs ?? 0) / 60_000),
                      )}{" "}
                      · {messages.genders[player.gender!]} ·{" "}
                      {player.skill
                        ? messages.levels[player.skill]
                        : text.levelMissing}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted">
              {query ? text.noMatchingName : text.noneAvailable}
            </p>
          )}
          {!query && matching.length > PICKER_VISIBLE_WHEN_FOLDED && (
            <button
              type="button"
              className={`${OUTLINE_BUTTON_CLASS_NAME} mt-3 w-full`}
              aria-expanded={showAll}
              onClick={() => setShowAll((open) => !open)}
            >
              {showAll ? text.showFewer : text.showAll(matching.length)}
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className={`${SECONDARY_BUTTON_CLASS_NAME} mt-3`}
        disabled={disabled || !distinct}
        onClick={() => onSave(ids.slice(0, 2), ids.slice(2))}
      >
        {court.called ? text.confirmChanged : text.callChosen}
      </button>
    </div>
  );
}
