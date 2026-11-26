"use client";

import { useId, useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import { courtName } from "@/i18n/courtName";
import { useMessages } from "@/i18n/LocaleProvider";
import { submitScore } from "@/server/checkin/playerActions";
import type { PlayerLastGame } from "@/server/checkin/playerProjection";

// p16-p17: after the host finishes a game, any of its four can add the
// score. Optional (Skip); the first score stands and only a host corrects it.

const SCORE_PATTERN = /^\d{1,2}$/;

export function ScoreCard({
  checkinTag,
  sessionId,
  game,
  onSaved,
  onDismiss,
}: {
  checkinTag: string;
  sessionId: string;
  game: PlayerLastGame;
  onSaved: () => void;
  onDismiss: () => void;
}) {
  const messages = useMessages();
  const text = messages.checkin.live.score;
  const ids = { yours: useId(), theirs: useId(), error: useId() };
  const [yours, setYours] = useState("");
  const [theirs, setTheirs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const shownCourt = courtName(game.courtName, messages);

  if (game.score) {
    return (
      <div
        role="status"
        className="flex flex-col gap-2 rounded-card border border-card-border bg-card p-[18px]"
      >
        <strong>{text.recordedTitle}</strong>
        <span className="text-[27px] font-extrabold tabular-nums">
          {game.score.yours}–{game.score.theirs}
        </span>
        <p className="text-sm">
          {game.score.enteredByName
            ? text.recordedBy(game.score.enteredByName)
            : text.recordedByHost}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className={OUTLINE_BUTTON_CLASS_NAME}
        >
          {text.close}
        </button>
      </div>
    );
  }

  const yourNames = text.yourTeam(game.partners.join(" + "));
  const theirNames = game.otherTeam.join(" + ");
  return (
    <form
      noValidate
      className="flex flex-col gap-3 rounded-card border border-card-border bg-card p-[18px]"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !SCORE_PATTERN.test(yours) ||
          !SCORE_PATTERN.test(theirs) ||
          yours === theirs ||
          Number(yours) === Number(theirs)
        ) {
          setError(text.invalid);
          return;
        }
        setIsBusy(true);
        setError(null);
        void submitScore(checkinTag, {
          sessionId,
          matchId: game.matchId,
          yourScore: Number(yours),
          theirScore: Number(theirs),
        }).then((result) => {
          setIsBusy(false);
          if (result.ok || result.failure === "already_recorded") onSaved();
          else
            setError(
              result.failure === "invalid"
                ? text.invalid
                : messages.checkin.live.failed,
            );
        });
      }}
    >
      <strong>{text.addTitle}</strong>
      <span className="text-sm text-muted">
        {text.teams(shownCourt, yourNames, theirNames)}
      </span>
      <div className="grid grid-cols-2 gap-2">
        <label htmlFor={ids.yours} className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL_CLASS_NAME}>{yourNames}</span>
          <input
            id={ids.yours}
            inputMode="numeric"
            maxLength={2}
            value={yours}
            onChange={(event) => setYours(event.target.value.trim())}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? ids.error : undefined}
            className={`${TEXT_INPUT_CLASS_NAME} text-center tabular-nums`}
          />
        </label>
        <label htmlFor={ids.theirs} className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL_CLASS_NAME}>{theirNames}</span>
          <input
            id={ids.theirs}
            inputMode="numeric"
            maxLength={2}
            value={theirs}
            onChange={(event) => setTheirs(event.target.value.trim())}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? ids.error : undefined}
            className={`${TEXT_INPUT_CLASS_NAME} text-center tabular-nums`}
          />
        </label>
      </div>
      {error && <AttentionMessage id={ids.error}>{error}</AttentionMessage>}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="submit"
          disabled={isBusy}
          aria-busy={isBusy}
          className={SECONDARY_BUTTON_CLASS_NAME}
        >
          {text.save}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className={OUTLINE_BUTTON_CLASS_NAME}
        >
          {text.skip}
        </button>
      </div>
    </form>
  );
}
