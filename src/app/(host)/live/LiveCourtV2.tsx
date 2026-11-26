"use client";

import {
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { courtName } from "@/i18n/courtName";
import { useMessages } from "@/i18n/LocaleProvider";
import type {
  LiveCommand,
  LiveCourt,
  LivePlayer,
  LiveSessionView,
} from "@/server/live/liveTypes";

// simple-social-v2 parts of the live screen (docs/designs/reclub-to-court/
// h7-h10): who in an Up next group has confirmed, what to do about someone
// who hasn't, the court's move and close options, and the Call over list.

/** Unconfirmed this long: the host goes and finds them (D1). */
const CALL_OVER_AFTER_MS = 60_000;

/**
 * How long the court has been waiting for this player, or null when it isn't:
 * the host is only prompted once the court is free and the player hasn't
 * confirmed. While a game is on there is nobody to chase.
 */
function waitingFor(court: LiveCourt, id: string, now: number): number | null {
  if (court.activeMatch || court.called?.confirmedIds?.includes(id))
    return null;
  const since = Math.max(
    court.called?.askedAt?.[id] ?? now,
    court.freeSince ?? 0,
  );
  return Math.max(0, now - since);
}

/** A free court's player to chase: no phone at once, others after a minute. */
function isOverdue(
  court: LiveCourt,
  player: LivePlayer | undefined,
  id: string,
  now: number,
): boolean {
  const waited = waitingFor(court, id, now);
  return (
    waited !== null &&
    (player?.hasPhone === false || waited >= CALL_OVER_AFTER_MS)
  );
}

function nameOf(players: LivePlayer[], id: string) {
  return players.find((player) => player.participantId === id)?.name ?? "";
}

/** h7: the Up next group in one line, ✓ or ! per name, and h8 per unconfirmed seat. */
export function UpNextConfirmations({
  court,
  players,
  now,
  disabled,
  onAction,
}: {
  court: LiveCourt;
  players: LivePlayer[];
  now: number;
  disabled: boolean;
  onAction: (command: LiveCommand) => void;
}) {
  const text = useMessages().host.live.v2;
  const called = court.called!;
  const confirmed = new Set(called.confirmedIds ?? []);
  const seats = [...called.teamA, ...called.teamB];
  // Options per seat only when the court is waiting for that player.
  const playerOf = (id: string) =>
    players.find((player) => player.participantId === id);
  const hasNoPhone = (id: string) => playerOf(id)?.hasPhone === false;
  const unconfirmed = seats.filter(
    (id): id is string =>
      id !== null && isOverdue(court, playerOf(id), id, now),
  );
  return (
    <div className="mt-2 flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <span className="rounded-full bg-inner-border px-2 py-0.5 text-xs font-bold text-text-soft tabular-nums">
          {text.confirmedCount(confirmed.size)}
        </span>
        {seats.map((id, index) =>
          id === null ? null : (
            <span
              key={id}
              className={
                unconfirmed.includes(id) ? "font-semibold text-orange-ink" : ""
              }
            >
              {unconfirmed.includes(id) ? "! " : ""}
              {nameOf(players, id)}
              {confirmed.has(id) ? " ✓" : ""}
              {index < seats.length - 1 ? " ·" : ""}
            </span>
          ),
        )}
      </p>
      {unconfirmed.map((id) => (
        <details
          key={id}
          className="rounded-xl border border-orange-edge bg-orange-surface"
        >
          <summary
            aria-label={text.seatActions(nameOf(players, id))}
            className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-3 text-sm"
          >
            <span className="font-semibold">{nameOf(players, id)}</span>
            <span className="text-xs font-bold text-orange-ink">
              {hasNoPhone(id)
                ? text.noPhone
                : text.noReply(
                    Math.floor((waitingFor(court, id, now) ?? 0) / 60_000),
                  )}
            </span>
          </summary>
          <div className="flex flex-col gap-2 px-3 pb-3">
            <button
              type="button"
              disabled={disabled}
              className={SECONDARY_BUTTON_CLASS_NAME}
              onClick={() =>
                onAction({
                  kind: "confirm",
                  calledEventId: called.calledEventId,
                  participantId: id,
                })
              }
            >
              {text.confirmInPerson}
            </button>
            <button
              type="button"
              disabled={disabled}
              className={OUTLINE_BUTTON_CLASS_NAME}
              onClick={() =>
                onAction({ kind: "pauseNoReply", participantId: id })
              }
            >
              {text.replaceNext}
            </button>
            <button
              type="button"
              disabled={disabled}
              className={OUTLINE_BUTTON_CLASS_NAME}
              onClick={() => onAction({ kind: "leave", participantId: id })}
            >
              {text.replaceAndLeft}
            </button>
            <p className="text-xs text-muted">{text.replacedNote}</p>
          </div>
        </details>
      ))}
    </div>
  );
}

/** h9-h10: move the Up next group, close the court (now or after its game), reopen. */
export function CourtOptionsV2({
  court,
  courts,
  disabled,
  onAction,
  undoOptions,
}: {
  court: LiveCourt;
  courts: LiveCourt[];
  disabled: boolean;
  onAction: (command: LiveCommand) => void;
  undoOptions: LiveSessionView["undoOptions"];
}) {
  const messages = useMessages();
  const text = messages.host.live.v2;
  const undoClose = undoOptions.find(
    (option) => option.kind === "close" || option.kind === "closeAfterGame",
  );
  if (court.isClosed) {
    return undoClose ? (
      <button
        type="button"
        disabled={disabled}
        className={`${OUTLINE_BUTTON_CLASS_NAME} mt-3 w-full`}
        onClick={() =>
          onAction({ kind: "undo", targetSeq: undoClose.targetSeq })
        }
      >
        {text.reopen}
      </button>
    ) : null;
  }
  const moveTargets = court.called
    ? courts.filter(
        (other) =>
          other.courtId !== court.courtId &&
          !other.isClosed &&
          !other.closesAfterGame &&
          !other.activeMatch,
      )
    : [];
  return (
    <details className="mt-3 rounded-xl border border-inner-border">
      <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-semibold">
        {text.courtOptions}
      </summary>
      <div className="flex flex-col gap-2 px-3 pb-3">
        {moveTargets.map((target) => (
          <button
            key={target.courtId}
            type="button"
            disabled={disabled}
            className={OUTLINE_BUTTON_CLASS_NAME}
            onClick={() =>
              onAction({
                kind: "move",
                calledEventId: court.called!.calledEventId,
                toCourtId: target.courtId,
              })
            }
          >
            {text.moveTo(courtName(target.name, messages))}
          </button>
        ))}
        {moveTargets.length > 0 && (
          <p className="text-xs text-muted">{text.moveNote}</p>
        )}
        {court.closesAfterGame && undoClose ? (
          <button
            type="button"
            disabled={disabled}
            className={OUTLINE_BUTTON_CLASS_NAME}
            onClick={() =>
              onAction({ kind: "undo", targetSeq: undoClose.targetSeq })
            }
          >
            {text.keepOpen}
          </button>
        ) : court.activeMatch ? (
          <>
            <button
              type="button"
              disabled={disabled}
              className={OUTLINE_BUTTON_CLASS_NAME}
              onClick={() =>
                onAction({ kind: "closeAfterGame", courtId: court.courtId })
              }
            >
              {text.closeAfterGame}
            </button>
            <p className="text-xs text-muted">{text.closeAfterGameNote}</p>
            <button
              type="button"
              disabled={disabled}
              className={OUTLINE_BUTTON_CLASS_NAME}
              onClick={() =>
                onAction({
                  kind: "stopAndClose",
                  courtId: court.courtId,
                  matchId: court.activeMatch!.matchId,
                })
              }
            >
              {text.stopAndClose}
            </button>
            <p className="text-xs text-muted">{text.stopAndCloseNote}</p>
          </>
        ) : (
          <button
            type="button"
            disabled={disabled}
            className={OUTLINE_BUTTON_CLASS_NAME}
            onClick={() =>
              onAction({ kind: "closeNow", courtId: court.courtId })
            }
          >
            {text.closeNow}
          </button>
        )}
      </div>
    </details>
  );
}

/** h7: who to go and find, at the top of the live screen. */
export function CallOverList({
  session,
  now,
}: {
  session: LiveSessionView;
  now: number;
}) {
  const messages = useMessages();
  const text = messages.host.live.v2;
  const rows: string[] = [];
  for (const court of session.courts) {
    const called = court.called;
    if (!called) continue;
    const name = courtName(court.name, messages);
    for (const id of [...called.teamA, ...called.teamB]) {
      if (id === null) continue;
      const player = session.players.find((p) => p.participantId === id);
      if (!player || !isOverdue(court, player, id, now)) continue;
      rows.push(
        player.hasPhone === false
          ? text.callNoPhone(player.name, name)
          : text.callNoReply(
              player.name,
              name,
              Math.floor(waitingFor(court, id, now)! / 60_000),
            ),
      );
    }
  }
  if (rows.length === 0) return null;
  return (
    <section
      aria-labelledby="call-over-heading"
      role="status"
      className="flex flex-col gap-1 rounded-2xl border border-orange-edge bg-orange-surface p-3"
    >
      <h2 id="call-over-heading" className="font-bold">
        {text.callOver(rows.length)}
      </h2>
      {rows.map((row) => (
        <p key={row} className="text-sm">
          {row}
        </p>
      ))}
    </section>
  );
}
