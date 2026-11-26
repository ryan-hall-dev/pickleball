import {
  calledSeats,
  friendPairOf,
  isCourtClosed,
  isPresent,
  replay,
  type SessionEvent,
  type SessionState,
} from "@/engine/session";
import { PLAYER_ACTOR_PREFIX, SYSTEM_ACTOR_ID } from "@/server/actorIds";
import type { LiveCommand } from "./liveTypes";

// Players confirm and the app prepares courts all the time, so a host's
// screen is often one or two events behind when they tap. The tap still
// applies when everything since was a player's or the app's own action and
// the thing the host tapped looks the same. Another host's action is still a
// conflict: they should see it first.

/**
 * False when another host (or an unknown actor) acted after `seenSeq`, or
 * the screen claims a seq the log doesn't have.
 */
export function onlyNonHostsActedSince(
  events: readonly SessionEvent[],
  seenSeq: number,
): boolean {
  if (seenSeq > (events.at(-1)?.seq ?? 0)) return false;
  return events
    .filter((event) => event.seq > seenSeq)
    .every(
      (event) =>
        event.actorId === SYSTEM_ACTOR_ID ||
        event.actorId.startsWith(PLAYER_ACTOR_PREFIX),
    );
}

function participantLook(state: SessionState, participantId: string) {
  const participant = state.participants[participantId];
  if (!participant) return null;
  const court = Object.values(state.courts).find(
    (candidate) =>
      candidate.nextGroup &&
      calledSeats(candidate.nextGroup).includes(participantId),
  );
  const skip = participant.skips.at(-1);
  return [
    isPresent(participant),
    participant.activeMatchId,
    skip && skip.to === null ? skip.skippedBySeq : null,
    court?.court.courtId ?? null,
    court?.nextGroup?.confirmedIds?.includes(participantId) ?? false,
  ];
}

/** The group's court and lineup. Confirmations don't change who plays. */
function groupLook(state: SessionState, calledEventId: string) {
  const court = Object.values(state.courts).find(
    (candidate) => candidate.nextGroup?.calledEventId === calledEventId,
  );
  return court
    ? [court.court.courtId, court.nextGroup!.teamA, court.nextGroup!.teamB]
    : null;
}

function courtLook(state: SessionState, courtId: string) {
  const court = state.courts[courtId];
  return court
    ? [court.activeMatchId, isCourtClosed(court), !!court.closeScheduledBySeq]
    : null;
}

/** What the host was looking at when they tapped; null: never carried over. */
function targetLook(
  state: SessionState,
  command: LiveCommand,
): unknown[] | null {
  switch (command.kind) {
    case "undo":
      return null;
    case "end":
      return [];
    case "finish":
    case "interrupt":
      return [state.matches[command.matchId]?.status];
    case "replace":
      return [
        state.matches[command.matchId]?.status,
        participantLook(state, command.outId),
        participantLook(state, command.inId),
      ];
    case "confirm":
      return [
        groupLook(state, command.calledEventId)?.[0],
        participantLook(state, command.participantId),
      ];
    case "rest":
    case "ready":
    case "leave":
    case "pauseNoReply":
      return [participantLook(state, command.participantId)];
    case "start":
    case "release":
    case "change":
      return [groupLook(state, command.calledEventId)];
    case "move":
      return [
        groupLook(state, command.calledEventId),
        courtLook(state, command.toCourtId),
        state.courts[command.toCourtId]?.nextGroup?.calledEventId ?? null,
      ];
    case "call":
      return [
        courtLook(state, command.courtId),
        state.courts[command.courtId]?.nextGroup?.calledEventId ?? null,
        ...[...command.teamA, ...command.teamB].map((id) =>
          participantLook(state, id),
        ),
      ];
    case "closeAfterGame":
    case "closeNow":
    case "stopAndClose":
      return [courtLook(state, command.courtId)];
    case "endPair": {
      const pair = state.friendPairs?.[command.requestSeq];
      return [
        pair?.status,
        pair ? friendPairOf(state, pair.participantId)?.requestSeq : null,
      ];
    }
  }
}

export function hostTapStillApplies(
  events: readonly SessionEvent[],
  current: SessionState,
  command: LiveCommand,
  seenSeq: number,
): boolean {
  if (seenSeq === current.lastSeq) return true;
  if (seenSeq > current.lastSeq || !onlyNonHostsActedSince(events, seenSeq))
    return false;
  const seen = replay(events.filter((event) => event.seq <= seenSeq));
  if (!seen.ok) return false;
  const before = targetLook(seen.state, command);
  return (
    before !== null &&
    JSON.stringify(before) === JSON.stringify(targetLook(current, command))
  );
}
