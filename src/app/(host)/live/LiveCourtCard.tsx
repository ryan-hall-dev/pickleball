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
import { CourtOptionsV2, UpNextConfirmations } from "./LiveCourtV2";

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
    <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3 compact:mt-0 compact:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] compact:gap-2">
      <div>
        {teams.teamA.map((id, index) => (
          <p
            className="py-1 font-semibold break-words compact:py-0"
            key={id ?? `vacant-${index}`}
          >
            {name(id)}
          </p>
        ))}
      </div>
      <span className="text-xs text-muted compact:text-[11px] compact:font-bold compact:text-link compact:uppercase">
        {text.versus}
      </span>
      <div className="compact:text-right">
        {teams.teamB.map((id, index) => (
          <p
            className="py-1 font-semibold break-words compact:py-0"
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
  courts = [],
  isV2 = false,
  pendingCommand = null,
}: {
  /** The host's tap being saved. */
  pendingCommand?: LiveCommand | null;
  /** Every court, for Move (simple-social-v2). */
  courts?: LiveCourt[];
  isV2?: boolean;
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
  const compactLayout = compactCourtLayout(court, group, timeIsUp);
  if (isV2 && court.isClosed) {
    return (
      <article
        className={`${CARD_CLASS_NAME} opacity-80`}
        aria-label={shownCourtName}
      >
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-bold compact:text-base">
            {shownCourtName}
          </h3>
          <span className="rounded-full bg-inner-border px-2 py-0.5 text-xs font-bold text-text-soft">
            {messages.host.live.v2.closed}
          </span>
        </header>
        <CourtOptionsV2
          court={court}
          courts={courts}
          disabled={disabled}
          onAction={onAction}
          undoOptions={undoOptions}
        />
      </article>
    );
  }
  return (
    <article
      className={`${CARD_CLASS_NAME} ${COMPACT_ARTICLE_CLASS_NAMES[compactLayout]}`}
      aria-label={shownCourtName}
    >
      <header
        className={`flex flex-wrap items-center justify-between gap-2 ${
          compactLayout === "playing" || compactLayout === "playingNothingNext"
            ? ""
            : `compact:col-span-1! compact:col-start-1 compact:row-start-1 compact:justify-start ${compactLayout === "group" ? "compact:mb-2" : ""}`
        }`}
      >
        <h3 className="text-lg font-bold compact:text-base">
          {shownCourtName}
        </h3>
        <span
          className={`text-sm font-semibold compact:rounded-full compact:px-2 compact:py-0.5 compact:text-xs ${
            court.activeMatch
              ? "text-lime-soft compact:border compact:border-lime-edge compact:bg-lime-surface compact:font-bold"
              : "text-muted compact:bg-inner-border compact:text-text-soft"
          } ${compactLayout === "group" ? "compact:hidden" : ""}`}
        >
          {isV2 && court.closesAfterGame
            ? messages.host.live.v2.closesAfterGame
            : court.activeMatch
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
            className={`${PRIMARY_BUTTON_CLASS_NAME} mt-4 compact:mt-3`}
            type="button"
            disabled={disabled}
            onClick={() =>
              onAction({ kind: "finish", matchId: court.activeMatch!.matchId })
            }
          >
            {pendingCommand?.kind === "finish" &&
            pendingCommand.matchId === court.activeMatch.matchId
              ? text.finishing
              : text.gameFinished}
          </button>
        </>
      ) : court.called ? null : (
        <p className="mt-2 text-xs text-muted compact:hidden">{text.noGame}</p>
      )}
      <CourtRecovery
        key={court.activeMatch?.matchId ?? "idle"}
        court={court}
        players={players}
        undoOptions={undoOptions.filter(
          (option) => option.kind === "start" || option.kind === "finish",
        )}
        disabled={disabled}
        onAction={onAction}
      />
      <section
        aria-label={text.upNextFor(shownCourtName)}
        className={`mt-5 rounded-[20px] border border-blue-edge bg-blue-surface p-4 ${COMPACT_UP_NEXT_BOX_CLASS_NAMES[compactLayout]}`}
      >
        <h4
          className={`font-bold text-blue-soft ${COMPACT_UP_NEXT_HEADING_CLASS_NAMES[compactLayout]}`}
        >
          {court.called && !court.activeMatch ? text.readyToStart : text.upNext}
          {court.called && court.activeMatch ? text.prepared : ""}
        </h4>
        {timeIsUp ? (
          <p
            className={`mt-2 text-xs text-muted ${compactLayout === "free" ? COMPACT_FREE_CAPTION_CLASS_NAME : ""}`}
          >
            {text.timeIsUp}
          </p>
        ) : group ? (
          <>
            {isV2 && court.called ? (
              <UpNextConfirmations
                court={court}
                players={players}
                now={now}
                disabled={disabled}
                onAction={onAction}
              />
            ) : (
              <>
                <Teams teams={group} players={players} />
                <p className="mt-2 text-xs text-blue-soft compact:mt-1.5">
                  {court.called ? text.fixed : text.longestWaitsFirst}
                </p>
              </>
            )}
            {vacancy && (
              <div className="mt-2">
                <AttentionMessage>
                  {text.calledPlayerUnavailable}
                </AttentionMessage>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2 compact:mt-2.5 compact:gap-1.5">
              {court.called ? (
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON_CLASS_NAME} compact:flex-1`}
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
                  {pendingCommand?.kind === "start" &&
                  pendingCommand.courtId === court.courtId
                    ? text.starting
                    : text.startGame}
                </button>
              ) : (
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON_CLASS_NAME} compact:flex-1`}
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
              {court.called && !isV2 && (
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
                courts={courts}
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
        ) : isV2 ? (
          // The app lines this court up by itself; nothing to press.
          <p
            className={`mt-2 text-sm text-muted compact:mt-0 compact:text-xs ${compactLayout === "free" ? COMPACT_FREE_CAPTION_CLASS_NAME : ""}`}
          >
            {court.activeMatch || court.closesAfterGame
              ? messages.host.live.v2.notLinedUp
              : text.waitingForFour}
          </p>
        ) : (
          <>
            <p
              className={`mt-2 text-sm text-muted ${
                compactLayout === "free"
                  ? COMPACT_FREE_CAPTION_CLASS_NAME
                  : compactLayout === "playingNothingNext" && !selected
                    ? "compact:sr-only"
                    : "compact:mt-0 compact:mb-1.5 compact:text-xs"
              }`}
            >
              {court.activeMatch
                ? selected
                  ? text.notEnoughPlayers
                  : text.chooseToPrepare
                : text.waitingForFour}
            </p>
            <button
              type="button"
              className={`${SECONDARY_BUTTON_CLASS_NAME} mt-3 ${
                compactLayout === "free"
                  ? "compact:col-start-2 compact:row-span-2 compact:row-start-1 compact:mt-0"
                  : compactLayout === "playingNothingNext"
                    ? "compact:mt-0 compact:h-12 compact:w-full compact:border compact:border-blue-edge compact:bg-transparent compact:text-blue-soft"
                    : "compact:mt-2"
              }`}
              disabled={disabled}
              onClick={onPrepare}
            >
              {selected ? text.refreshNextFour : text.prepareNextFour}
            </button>
          </>
        )}
      </section>
      {isV2 && (
        <CourtOptionsV2
          court={court}
          courts={courts}
          disabled={disabled}
          onAction={onAction}
          undoOptions={undoOptions}
        />
      )}
    </article>
  );
}

/**
 * Below 1024px (Design A, docs/plans/mobile-compact-ui.md): a game in progress
 * keeps a slim Up next box, or only a "Prepare next four" button while nothing
 * is prepared; a court with a group waiting to start (or a suggestion) becomes
 * one card whose Up next title is the pill beside the court name; a free court
 * is one row with its button on the right. The Up next box uses
 * `display: contents` there so its parts join the card's grid.
 */
type CompactCourtLayout = "playing" | "playingNothingNext" | "group" | "free";

function compactCourtLayout(
  court: LiveCourt,
  group: LiveTeams | null,
  timeIsUp: boolean,
): CompactCourtLayout {
  if (court.activeMatch)
    return group || timeIsUp ? "playing" : "playingNothingNext";
  return group && !timeIsUp ? "group" : "free";
}

const COMPACT_ARTICLE_CLASS_NAMES: Record<CompactCourtLayout, string> = {
  playing: "",
  // Court options and Prepare next four share a row; open options take it all.
  playingNothingNext:
    "compact:grid compact:grid-cols-2 compact:gap-x-2 compact:[&>*]:col-span-2 compact:[&>details]:col-span-1 compact:[&>details[open]]:col-span-2 compact:[&>section]:col-span-1",
  group:
    "compact:grid compact:grid-cols-[minmax(0,1fr)_auto] compact:items-center compact:gap-x-2 compact:border-blue-edge compact:bg-blue-surface compact:[&>*]:col-span-2 compact:[&>section>*]:col-span-2",
  free: "compact:grid compact:grid-cols-[minmax(0,1fr)_auto] compact:items-center compact:gap-x-2.5 compact:[&>*]:col-span-2",
};

const COMPACT_UP_NEXT_BOX_CLASS_NAMES: Record<CompactCourtLayout, string> = {
  playing: "compact:mt-3 compact:rounded-[14px] compact:p-3",
  playingNothingNext:
    "compact:mt-3 compact:rounded-none compact:border-0 compact:bg-transparent compact:p-0",
  group: "compact:contents",
  free: "compact:contents",
};

const COMPACT_UP_NEXT_HEADING_CLASS_NAMES: Record<CompactCourtLayout, string> =
  {
    playing: "",
    playingNothingNext: "compact:sr-only",
    group:
      "compact:col-span-1! compact:col-start-2 compact:row-start-1 compact:justify-self-end compact:rounded-full compact:bg-blue compact:px-2.5 compact:py-0.5 compact:text-xs compact:text-on-blue",
    free: "compact:sr-only",
  };

const COMPACT_FREE_CAPTION_CLASS_NAME =
  "compact:col-span-1! compact:col-start-1 compact:row-start-2 compact:mt-0.5 compact:text-xs";

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
  courts,
  players,
  teams,
  disabled,
  onSave,
}: {
  court: LiveCourt;
  /** Every court, to say where someone is playing. */
  courts: LiveCourt[];
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
  // Searching for someone who can't take this seat says why, rather than
  // looking as if they don't exist.
  const unavailable =
    seat === null || !query
      ? []
      : players.filter(
          (player) =>
            player.name.toLowerCase().includes(query) &&
            !choices.includes(player),
        );
  function whyNot(player: LivePlayer): string {
    const id = player.participantId;
    if (ids.includes(id)) return text.alreadyInGroup;
    if (player.status === "away") return text.hasLeft;
    if (player.status === "playing") {
      const playingOn = courts.find((other) =>
        [
          ...(other.activeMatch?.teamA ?? []),
          ...(other.activeMatch?.teamB ?? []),
        ].includes(id),
      );
      return text.playingOn(
        playingOn ? courtName(playingOn.name, messages) : "",
      );
    }
    if (player.status === "skipped") return text.onBreak;
    if (player.calledCourtId && player.calledCourtId !== court.courtId)
      return text.upNextOn(courtName(player.calledCourtName ?? "", messages));
    return player.gender === null
      ? text.genderMissing
      : text.wouldNotBeValid(messages.genders[player.gender]);
  }
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
          {unavailable.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {unavailable.map((player) => (
                <li
                  key={player.participantId}
                  className="rounded-xl border border-dashed border-outline px-3 py-2"
                >
                  <span className="block font-semibold break-words text-muted">
                    {player.name}
                  </span>
                  <span className="block text-xs text-muted">
                    {whyNot(player)}
                  </span>
                </li>
              ))}
            </ul>
          )}
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
            unavailable.length === 0 && (
              <p className="mt-3 text-sm text-muted">
                {query ? text.noMatchingName : text.noneAvailable}
              </p>
            )
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
