"use client";

import { useId, useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  CARD_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import { courtName } from "@/i18n/courtName";
import { useLocale } from "@/i18n/LocaleProvider";
import { translateMessage } from "@/i18n/messages";
import type { LiveRecentGame } from "@/server/live/liveTypes";
import { setMatchScore } from "@/server/live/scoreActions";

// h13: the latest finished games. Scores are optional and never hold a
// court; a host adds one, or corrects what a player entered.

export function RecentGames({
  games,
  onSaved,
}: {
  games: LiveRecentGame[];
  onSaved: () => void;
}) {
  const { messages } = useLocale();
  const text = messages.host.live.v2;
  return (
    <section
      aria-labelledby="recent-games-heading"
      className={`${CARD_CLASS_NAME} flex flex-col gap-2`}
    >
      <h2
        id="recent-games-heading"
        className="text-xl font-bold compact:text-base"
      >
        {text.recentGames}
      </h2>
      {games.length === 0 ? (
        <p className="text-sm text-muted">{text.noGamesYet}</p>
      ) : (
        <ul className="flex flex-col">
          {games.map((game) => (
            <GameRow key={game.matchId} game={game} onSaved={onSaved} />
          ))}
        </ul>
      )}
    </section>
  );
}

function GameRow({
  game,
  onSaved,
}: {
  game: LiveRecentGame;
  onSaved: () => void;
}) {
  const { locale, messages } = useLocale();
  const text = messages.host.live.v2;
  const ids = { a: useId(), b: useId() };
  const [isEditing, setIsEditing] = useState(false);
  const [scoreA, setScoreA] = useState(String(game.score?.scoreTeamA ?? ""));
  const [scoreB, setScoreB] = useState(String(game.score?.scoreTeamB ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const time = new Date(game.endedAt).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const teamA = game.teamA.join(" + ");
  const teamB = game.teamB.join(" + ");
  return (
    <li className="flex flex-col gap-2 border-t border-inner-border py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {text.gameAt(courtName(game.courtName, messages), time)}
          </span>
          <span className="block text-[13px] break-words text-muted">
            {teamA} {messages.host.live.court.versus} {teamB}
          </span>
          {game.score?.enteredByName && (
            <span className="block text-xs text-muted">
              {text.scoreBy(game.score.enteredByName)}
            </span>
          )}
        </span>
        {game.score && (
          <strong className="text-lg tabular-nums">
            {game.score.scoreTeamA}–{game.score.scoreTeamB}
          </strong>
        )}
        {!isEditing && (
          <button
            type="button"
            className={OUTLINE_BUTTON_CLASS_NAME}
            onClick={() => setIsEditing(true)}
          >
            {game.score ? text.correct : text.addScore}
          </button>
        )}
      </div>
      {isEditing && (
        <form
          noValidate
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setIsBusy(true);
            setError(null);
            void setMatchScore({
              matchId: game.matchId,
              scoreTeamA: Number(scoreA),
              scoreTeamB: Number(scoreB),
            }).then((result) => {
              setIsBusy(false);
              if (result.ok) {
                setIsEditing(false);
                onSaved();
              } else setError(translateMessage(result.message, messages));
            });
          }}
        >
          {(
            [
              [ids.a, teamA, scoreA, setScoreA],
              [ids.b, teamB, scoreB, setScoreB],
            ] as const
          ).map(([id, names, value, setValue]) => (
            <label key={id} htmlFor={id} className="flex flex-col gap-1">
              <span className="text-xs text-muted">
                {text.teamScore(names)}
              </span>
              <input
                id={id}
                inputMode="numeric"
                maxLength={2}
                value={value}
                onChange={(event) => setValue(event.target.value.trim())}
                aria-invalid={error ? true : undefined}
                className={`${TEXT_INPUT_CLASS_NAME} w-20 text-center tabular-nums`}
              />
            </label>
          ))}
          <button
            type="submit"
            disabled={isBusy}
            className={SECONDARY_BUTTON_CLASS_NAME}
          >
            {text.saveScore}
          </button>
          <button
            type="button"
            className={OUTLINE_BUTTON_CLASS_NAME}
            onClick={() => setIsEditing(false)}
          >
            {messages.host.common.cancel}
          </button>
          {error && (
            <div className="basis-full">
              <AttentionMessage>{error}</AttentionMessage>
            </div>
          )}
        </form>
      )}
    </li>
  );
}
