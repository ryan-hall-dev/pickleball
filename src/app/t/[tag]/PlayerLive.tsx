"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  FIELD_LABEL_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
} from "@/components/controlStyles";
import { courtName } from "@/i18n/courtName";
import { useMessages } from "@/i18n/LocaleProvider";
import { settleWithin } from "@/lib/settleWithin";
import type { PlayerIntent } from "@/server/checkin/playerActionPlan";
import {
  readPlayerSession,
  searchReadyFriends,
  submitPlayerAction,
  type ReadPlayerSessionResult,
} from "@/server/checkin/playerActions";
import type { PlayerSeat, PlayerView } from "@/server/checkin/playerProjection";
import { BrandLine } from "./CheckinParts";
import { ScoreCard } from "./ScoreCard";
import {
  BOTTOM_ACTION_BAR_CLASS_NAME,
  FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME,
} from "./checkinStyles";

// A checked-in player's live page (docs/designs/reclub-to-court/ p5-p16):
// Ready, Up next, confirmed, Head to court, playing, break. The page is the
// only way a phone hears about its game in v1 (D1, no push): it polls every
// 5 s while visible and once more when shown again.

const POLL_INTERVAL_MS = 5_000;
const CALL_TIMEOUT_MS = 15_000;
/** p15: a gentle reminder once a break passes this long. */
const BREAK_REMINDER_MS = 10 * 60_000;

const minutesOf = (ms: number | null) => Math.floor((ms ?? 0) / 60_000);

const CARD = "flex flex-col gap-3 rounded-card border p-[18px]";
const CARD_TONES = {
  plain: "border-card-border bg-card",
  blue: "border-blue-edge bg-blue-surface",
  lime: "border-lime-edge bg-lime-surface",
  orange: "border-orange-edge bg-orange-surface",
} as const;
const PILL_TONES = {
  plain: "border-inner-border bg-inner text-text-soft",
  blue: "border-blue-edge bg-blue text-on-blue",
  lime: "border-lime-edge bg-lime text-on-lime",
  orange: "border-orange-edge bg-orange-surface text-orange-ink",
} as const;

function Pill({
  tone,
  children,
}: {
  tone: keyof typeof PILL_TONES;
  children: string;
}) {
  return (
    <span
      className={`self-start rounded-full border px-2.5 py-1 text-xs font-bold ${PILL_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

function Big({ children }: { children: string }) {
  return (
    <h1 className="text-[27px] leading-[1.15] font-extrabold break-words">
      {children}
    </h1>
  );
}

function useNames() {
  const copy = useMessages().checkin.live;
  return (seats: readonly PlayerSeat[]) =>
    seats
      .filter((seat) => !seat.isYou)
      .map((seat) => (seat.isEmpty ? copy.emptySpot : seat.name))
      .join(` ${copy.and} `);
}

/** "With Lan Dinh against Khoa Mai and Emma Reid." */
function TeamsLine({ view }: { view: PlayerView }) {
  const copy = useMessages().checkin.live;
  const names = useNames();
  if (!view.group) return null;
  return (
    <p className="text-base">
      {copy.withAgainst(
        names(view.group.yourTeam),
        names(view.group.otherTeam),
      )}
    </p>
  );
}

/** Who has confirmed in the Up next group (p8). */
function ConfirmationList({ view }: { view: PlayerView }) {
  const copy = useMessages().checkin.live;
  if (!view.group) return null;
  const seats = [...view.group.yourTeam, ...view.group.otherTeam].filter(
    (seat) => !seat.isYou,
  );
  return (
    <ul className="flex flex-col">
      {seats.map((seat, index) => (
        <li
          key={`${seat.name}-${index}`}
          className="flex items-center gap-2 border-t border-blue-edge/40 py-2 first:border-t-0"
        >
          <span className="min-w-0 flex-1 break-words">
            {seat.isEmpty ? copy.emptySpot : seat.name}
          </span>
          <Pill tone={seat.isConfirmed ? "lime" : "orange"}>
            {seat.isConfirmed ? copy.confirmedLabel : copy.waitingLabel}
          </Pill>
        </li>
      ))}
    </ul>
  );
}

/** Asks first: giving up a spot (p7) or leaving for the day. */
function ConfirmSheet({
  title,
  text,
  confirmLabel,
  keepLabel,
  isBusy,
  onConfirm,
  onKeep,
}: {
  title: string;
  text: string;
  confirmLabel: string;
  keepLabel: string;
  isBusy: boolean;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  const titleId = useId();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-20 flex items-end bg-bg-backdrop/60"
    >
      <div className="flex w-full flex-col gap-3 rounded-t-[22px] border-t border-card-border bg-card p-5 pb-[max(24px,env(safe-area-inset-bottom))]">
        <h2 id={titleId} className="text-xl font-bold">
          {title}
        </h2>
        <p className="text-text-soft">{text}</p>
        <button
          type="button"
          autoFocus
          onClick={onKeep}
          className={PRIMARY_BUTTON_CLASS_NAME}
        >
          {keepLabel}
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={onConfirm}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

export function PlayerLive({
  checkinTag,
  sessionId,
  socialName,
}: {
  checkinTag: string;
  sessionId: string;
  socialName: string;
}) {
  const messages = useMessages();
  const copy = messages.checkin.live;
  const [read, setRead] = useState<ReadPlayerSessionResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"rest" | "leave" | null>(null);
  const [isFindingFriend, setIsFindingFriend] = useState(false);
  const previous = useRef<PlayerView | null>(null);
  const [courtChange, setCourtChange] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const [droppedFriend, setDroppedFriend] = useState<string | null>(null);
  const [dismissedScoreMatchId, setDismissedScoreMatchId] = useState<
    string | null
  >(null);

  const refresh = useCallback(async () => {
    const result = await settleWithin(
      readPlayerSession(checkinTag, { sessionId }),
      CALL_TIMEOUT_MS,
      { ok: false, failure: "unavailable" } as const,
    );
    if (result.ok) {
      const before = previous.current;
      const after = result.view;
      // p11: the host moved my group; p14: my friend dropped out.
      if (
        before?.group &&
        after.group &&
        before.status !== "playing" &&
        after.status !== "playing" &&
        before.group.courtId !== after.group.courtId
      )
        setCourtChange({
          from: before.group.courtName,
          to: after.group.courtName,
        });
      if (
        before?.friend?.status === "teamed" &&
        !after.friend &&
        after.status !== "playing"
      )
        setDroppedFriend(before.friend.friendName);
      if (after.status === "playing" || after.status === "ready")
        setCourtChange(null);
      previous.current = after;
    }
    setRead((current) => (result.ok || !current?.ok ? result : current));
  }, [checkinTag, sessionId]);

  useEffect(() => {
    void refresh();
    const poll = () => {
      if (!document.hidden) void refresh();
    };
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);

  const act = useCallback(
    async (intent: PlayerIntent, friendId: string | null = null) => {
      setIsBusy(true);
      setNotice(null);
      const result = await settleWithin(
        submitPlayerAction(checkinTag, {
          sessionId,
          eventId: crypto.randomUUID(),
          intent,
          friendId,
        }),
        CALL_TIMEOUT_MS,
        { ok: false, failure: "unavailable" } as const,
      );
      if (!result.ok)
        setNotice(
          result.failure === "no_longer_possible"
            ? copy.changedMeanwhile
            : copy.failed,
        );
      setSheet(null);
      await refresh();
      setIsBusy(false);
      return result.ok;
    },
    [checkinTag, sessionId, refresh, copy],
  );

  if (!read) {
    return (
      <>
        <BrandLine name={socialName} />
        <p className="text-muted" role="status">
          {messages.loading.checkin}
        </p>
      </>
    );
  }
  if (!read.ok) {
    return (
      <>
        <BrandLine name={socialName} />
        <AttentionMessage>{copy.failed}</AttentionMessage>
        <button
          type="button"
          onClick={() => void refresh()}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          {messages.checkin.tryAgain}
        </button>
      </>
    );
  }
  const view = read.view;
  if (isFindingFriend && view.status === "ready" && !view.friend) {
    return (
      <FriendSearch
        checkinTag={checkinTag}
        sessionId={sessionId}
        socialName={socialName}
        isBusy={isBusy}
        onAsk={async (friendId) => {
          if (await act("askFriend", friendId)) setIsFindingFriend(false);
        }}
        onBack={() => setIsFindingFriend(false)}
      />
    );
  }

  const restButton = (
    <button
      type="button"
      disabled={isBusy}
      onClick={() => setSheet("rest")}
      className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
    >
      {copy.needRest}
    </button>
  );
  const groupHasGap =
    view.group &&
    [...view.group.yourTeam, ...view.group.otherTeam].some(
      (seat) => seat.isEmpty,
    );

  return (
    <>
      <BrandLine name={socialName} />
      {notice && (
        <div role="alert">
          <AttentionMessage>{notice}</AttentionMessage>
        </div>
      )}
      {droppedFriend && view.status !== "playing" && (
        <div className={`${CARD} ${CARD_TONES.blue}`} role="status">
          <p>{copy.friend.droppedOut(droppedFriend)}</p>
        </div>
      )}

      {view.status === "ready" && (
        <div className={`${CARD} ${CARD_TONES.plain}`}>
          <Pill tone="lime">{copy.readyPill}</Pill>
          <span className="text-muted">{copy.readyFor}</span>
          <Big>{copy.minutes(minutesOf(view.waitMs))}</Big>
          <p>{copy.readyText}</p>
        </div>
      )}

      {view.status === "upNext" && view.group && (
        <div
          className={`${CARD} ${groupHasGap ? CARD_TONES.orange : CARD_TONES.blue}`}
        >
          <Pill tone={courtChange ? "orange" : "blue"}>
            {courtChange ? copy.courtChangedPill : copy.upNextPill}
          </Pill>
          <Big>
            {copy.upNextTitle(courtName(view.group.courtName, messages))}
          </Big>
          <TeamsLine view={view} />
          <p className="text-sm text-text-soft">{copy.mayChange}</p>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void act("confirm")}
            className={`${PRIMARY_BUTTON_CLASS_NAME} h-14`}
          >
            {copy.imReady}
          </button>
          {restButton}
        </div>
      )}

      {view.status === "confirmed" && view.group && (
        <div
          className={`${CARD} ${groupHasGap ? CARD_TONES.orange : CARD_TONES.blue}`}
        >
          {groupHasGap ? (
            <>
              <Pill tone="orange">{copy.changePill}</Pill>
              <Big>{copy.pleaseWait}</Big>
              <p>
                {copy.changeText(courtName(view.group.courtName, messages))}
              </p>
            </>
          ) : (
            <>
              <Pill tone="lime">{copy.confirmedPill}</Pill>
              <Big>
                {copy.waitFor(courtName(view.group.courtName, messages))}
              </Big>
              <p>{copy.gameStillOn}</p>
            </>
          )}
          <ConfirmationList view={view} />
          {restButton}
        </div>
      )}

      {view.status === "headToCourt" && view.group && (
        <div className={`${CARD} ${CARD_TONES.lime}`}>
          <Pill tone={courtChange ? "orange" : "lime"}>
            {courtChange ? copy.courtChangedPill : copy.goPill}
          </Pill>
          <Big>
            {courtChange
              ? copy.nowCourt(courtName(view.group.courtName, messages))
              : copy.headTo(courtName(view.group.courtName, messages))}
          </Big>
          {courtChange && (
            <p>
              {copy.movedText(
                courtName(courtChange.from, messages),
                courtName(courtChange.to, messages),
              )}
            </p>
          )}
          <TeamsLine view={view} />
          <p>{copy.startWhenAll}</p>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void act("gameStarted")}
            className={`${PRIMARY_BUTTON_CLASS_NAME} h-14`}
          >
            {copy.gameStarted}
          </button>
          {restButton}
        </div>
      )}

      {view.status === "playing" && view.group && (
        <div className={`${CARD} ${CARD_TONES.lime}`}>
          <Pill tone="lime">
            {copy.playingPill(
              minutesOf(view.now - (view.gameStartedAt ?? view.now)),
            )}
          </Pill>
          <Big>{courtName(view.group.courtName, messages)}</Big>
          <TeamsLine view={view} />
          <p className="text-sm">{copy.tellHost}</p>
        </div>
      )}

      {view.status === "onBreak" && (
        <div className={`${CARD} ${CARD_TONES.plain}`}>
          <Pill tone="plain">{copy.breakPill}</Pill>
          <Big>
            {view.breakReason === "noReply"
              ? copy.pausedTitle(
                  minutesOf(view.now - (view.breakStartedAt ?? view.now)),
                )
              : copy.onBreakTitle(
                  minutesOf(view.now - (view.breakStartedAt ?? view.now)),
                )}
          </Big>
          {view.breakReason === "noReply" && <p>{copy.pausedText}</p>}
          <p>{copy.waitSaved(minutesOf(view.waitMs))}</p>
          {view.now - (view.breakStartedAt ?? view.now) >=
            BREAK_REMINDER_MS && (
            <div className={`${CARD} ${CARD_TONES.orange} p-3`}>
              <p>! {copy.stillResting}</p>
            </div>
          )}
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void act("readyAgain")}
            className={`${PRIMARY_BUTTON_CLASS_NAME} h-14`}
          >
            {copy.readyAgain}
          </button>
        </div>
      )}

      {view.status === "left" && (
        <div className={`${CARD} ${CARD_TONES.plain}`}>
          <Big>{copy.leftTitle}</Big>
          <p>{copy.leftText}</p>
        </div>
      )}
      {view.status === "ended" && (
        <div className={`${CARD} ${CARD_TONES.plain}`}>
          <Big>{copy.endedTitle}</Big>
          <p>{copy.endedText}</p>
        </div>
      )}

      {view.lastGame &&
        view.lastGame.matchId !== dismissedScoreMatchId &&
        view.status !== "playing" &&
        view.status !== "left" &&
        view.status !== "ended" && (
          <ScoreCard
            key={view.lastGame.matchId}
            checkinTag={checkinTag}
            sessionId={sessionId}
            game={view.lastGame}
            onSaved={() => void refresh()}
            onDismiss={() => setDismissedScoreMatchId(view.lastGame!.matchId)}
          />
        )}

      {view.friend && view.status !== "playing" && (
        <FriendCard view={view} isBusy={isBusy} act={act} />
      )}

      {(view.status === "ready" || view.status === "onBreak") && (
        <div className={BOTTOM_ACTION_BAR_CLASS_NAME}>
          {view.status === "ready" && !view.friend && (
            <button
              type="button"
              onClick={() => setIsFindingFriend(true)}
              className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
            >
              {copy.playWithFriend}
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            {view.status === "ready" && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void act("takeBreak")}
                className={OUTLINE_BUTTON_CLASS_NAME}
              >
                {copy.takeBreak}
              </button>
            )}
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setSheet("leave")}
              className={`${OUTLINE_BUTTON_CLASS_NAME} ${view.status === "onBreak" ? "col-span-2" : ""}`}
            >
              {copy.leaving}
            </button>
          </div>
        </div>
      )}
      <p className="text-center text-[13px] text-muted" aria-live="off">
        {copy.updatesItself}
      </p>

      {sheet === "rest" && (
        <ConfirmSheet
          title={copy.giveUpTitle}
          text={copy.giveUpText}
          keepLabel={copy.keepSpot}
          confirmLabel={copy.yesRest}
          isBusy={isBusy}
          onKeep={() => setSheet(null)}
          onConfirm={() => void act("takeBreak")}
        />
      )}
      {sheet === "leave" && (
        <ConfirmSheet
          title={copy.leaveTitle}
          text={copy.leaveText}
          keepLabel={copy.stay}
          confirmLabel={copy.yesLeave}
          isBusy={isBusy}
          onKeep={() => setSheet(null)}
          onConfirm={() => void act("leave")}
        />
      )}
    </>
  );
}

/** p13 and the pair's own state: asked, asked you, teamed. */
function FriendCard({
  view,
  isBusy,
  act,
}: {
  view: PlayerView;
  isBusy: boolean;
  act: (intent: PlayerIntent) => Promise<boolean>;
}) {
  const copy = useMessages().checkin.live.friend;
  const friend = view.friend!;
  if (friend.status === "askedYou") {
    const yours = minutesOf(friend.yourWaitMs);
    const theirs = minutesOf(friend.theirWaitMs);
    return (
      <div className={`${CARD} ${CARD_TONES.blue}`}>
        <Big>{copy.askedTitle(friend.friendName)}</Big>
        <p>{copy.askedText}</p>
        <p className="text-sm">
          {copy.askedWaits(
            yours,
            friend.friendName,
            theirs,
            Math.min(yours, theirs),
          )}
        </p>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void act("acceptFriend")}
          className={`${SECONDARY_BUTTON_CLASS_NAME} h-14 w-full`}
        >
          {copy.teamUp}
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void act("endFriend")}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          {copy.noThanks}
        </button>
      </div>
    );
  }
  return (
    <div className={`${CARD} ${CARD_TONES.blue}`}>
      <p className="font-semibold">
        {friend.status === "teamed"
          ? copy.teamed(friend.friendName)
          : copy.youAsked(friend.friendName)}
      </p>
      <button
        type="button"
        disabled={isBusy}
        onClick={() => void act("endFriend")}
        className={OUTLINE_BUTTON_CLASS_NAME}
      >
        {copy.cancel}
      </button>
    </div>
  );
}

/** p12: find a Ready friend by name and ask. */
function FriendSearch({
  checkinTag,
  sessionId,
  socialName,
  isBusy,
  onAsk,
  onBack,
}: {
  checkinTag: string;
  sessionId: string;
  socialName: string;
  isBusy: boolean;
  onAsk: (friendId: string) => void;
  onBack: () => void;
}) {
  const copy = useMessages().checkin.live.friend;
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<{
    query: string;
    friends: Array<{ participantId: string; name: string }>;
  } | null>(null);
  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed.length < 2) return;
    let isCurrent = true;
    const timeout = setTimeout(() => {
      void searchReadyFriends(checkinTag, { sessionId, query: trimmed }).then(
        (result) => {
          if (isCurrent && result.ok)
            setAnswer({ query: trimmed, friends: result.friends });
        },
      );
    }, 300);
    return () => {
      isCurrent = false;
      clearTimeout(timeout);
    };
  }, [checkinTag, sessionId, trimmed]);
  const friends = answer?.query === trimmed ? answer.friends : [];
  return (
    <>
      <BrandLine name={socialName} />
      <Big>{copy.title}</Big>
      <p className="text-muted">{copy.explain}</p>
      <label htmlFor={inputId} className={FIELD_LABEL_CLASS_NAME}>
        {copy.searchLabel}
      </label>
      <input
        id={inputId}
        type="search"
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className={TEXT_INPUT_CLASS_NAME}
      />
      {answer?.query === trimmed && friends.length === 0 && (
        <p className="text-sm text-muted" role="status">
          {copy.noMatches}
        </p>
      )}
      {friends.length > 0 && (
        <ul className="flex flex-col rounded-2xl border border-card-border bg-card">
          {friends.map((friend) => (
            <li
              key={friend.participantId}
              className="flex items-center gap-2 border-t border-inner-border px-4 py-2 first:border-t-0"
            >
              <span className="min-w-0 flex-1 font-semibold break-words">
                {friend.name}
              </span>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => onAsk(friend.participantId)}
                className={SECONDARY_BUTTON_CLASS_NAME}
              >
                {copy.ask}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] text-muted">{copy.genderNote}</p>
      <div className={BOTTOM_ACTION_BAR_CLASS_NAME}>
        <button
          type="button"
          onClick={onBack}
          className={FULL_WIDTH_OUTLINE_BUTTON_CLASS_NAME}
        >
          {copy.back}
        </button>
      </div>
    </>
  );
}
