import { createHash } from "node:crypto";
import {
  calledSeats,
  isSkipped,
  isUpNextReadyToPlay,
  type SessionState,
} from "@/engine/session";
import type { NewSessionAction } from "@/server/submitSessionAction";

// What a player's tap means in the current log (pure; see playerActions.ts).

export type PlayerIntent =
  /** Up next: "I'm ready". */
  | "confirm"
  /** "Need a rest" / "Take a break": a break until Ready (frees an Up next seat). */
  | "takeBreak"
  /** "I'm ready again". */
  | "readyAgain"
  /** "I'm leaving". */
  | "leave"
  /** "Game started": all four confirmed and on the free court. */
  | "gameStarted";

/** A repeatable id for one group's start: several taps make one game. */
function startId(kind: string, calledEventId: string, lastSeq: number) {
  const bytes = createHash("sha256")
    .update(`player-start|${kind}|${calledEventId}|${lastSeq}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type Planned =
  | { kind: "write"; eventId: string; action: NewSessionAction }
  /** Already so (a repeat tap): nothing to write. */
  | { kind: "nothing" }
  | { kind: "impossible" };

/** What `intent` means for `participantId` in this state. */
export function planPlayerAction(
  state: SessionState,
  participantId: string,
  intent: PlayerIntent,
  eventId: string,
): Planned {
  const participant = state.participants[participantId];
  if (!participant) return { kind: "impossible" };
  const court = Object.values(state.courts).find(
    (candidate) =>
      candidate.nextGroup &&
      calledSeats(candidate.nextGroup).includes(participantId),
  );
  switch (intent) {
    case "confirm": {
      if (!court) return { kind: "impossible" };
      if (court.nextGroup!.confirmedIds?.includes(participantId))
        return { kind: "nothing" };
      return {
        kind: "write",
        eventId,
        action: {
          type: "NextGroupSeatConfirmed",
          payload: {
            calledEventId: court.nextGroup!.calledEventId,
            participantId,
          },
        },
      };
    }
    case "takeBreak":
      if (isSkipped(participant)) return { kind: "nothing" };
      return {
        kind: "write",
        eventId,
        action: {
          type: "PlayerSkipped",
          payload: { participantId, reason: "break" },
        },
      };
    case "readyAgain": {
      const skip = participant.skips.at(-1);
      if (!skip || skip.to !== null) return { kind: "nothing" };
      return {
        kind: "write",
        eventId,
        action: {
          type: "PlayerUnskipped",
          payload: { targetSeq: skip.skippedBySeq },
        },
      };
    }
    case "leave":
      return {
        kind: "write",
        eventId,
        action: { type: "PlayerLeft", payload: { participantId } },
      };
    case "gameStarted": {
      if (participant.activeMatchId !== null) return { kind: "nothing" };
      if (!court || !isUpNextReadyToPlay(state, court.court.courtId))
        return { kind: "impossible" };
      const group = court.nextGroup!;
      return {
        kind: "write",
        // Every tap on this group at this point in the log is the same start.
        eventId: startId("event", group.calledEventId, state.lastSeq),
        action: {
          type: "MatchStarted",
          payload: {
            matchId: startId("match", group.calledEventId, state.lastSeq),
            courtId: court.court.courtId,
            calledEventId: group.calledEventId,
            teamA: group.teamA as string[],
            teamB: group.teamB as string[],
          },
        },
      };
    }
  }
}
