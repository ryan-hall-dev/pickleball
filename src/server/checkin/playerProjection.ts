import {
  calledSeats,
  currentLineup,
  friendPairOf,
  isCourtClosed,
  isPresent,
  isSkipped,
  isUpNextReadyToPlay,
  participantName,
  playerMetrics,
  type SessionState,
} from "@/engine/session";

// One player's own view of a live simple-social-v2 session (screens p5-p16;
// docs/designs/reclub-to-court/). Pure. It names only the people in the
// player's own group or game, and their friend: never anyone else, and never
// who else has arrived.

export interface PlayerSeat {
  name: string;
  isYou: boolean;
  /** Up next only: said "I'm ready" (or a host confirmed them). */
  isConfirmed: boolean;
  /** An empty seat (someone gave it up; the app is finding a player). */
  isEmpty: boolean;
}

export interface PlayerGroupView {
  courtId: string;
  courtName: string;
  /** Your team first. */
  yourTeam: PlayerSeat[];
  otherTeam: PlayerSeat[];
}

export type PlayerFriendView =
  /** You asked; waiting for them. */
  | { status: "youAsked"; friendName: string }
  /** They asked you (p13). */
  | {
      status: "askedYou";
      friendName: string;
      yourWaitMs: number;
      theirWaitMs: number;
    }
  /** Teamed up for the next game. */
  | { status: "teamed"; friendName: string };

export type PlayerStatus =
  | "notStarted"
  /** p5: waiting for a game. */
  | "ready"
  /** p6: asked to get ready; hasn't confirmed. */
  | "upNext"
  /** p8: confirmed; the court is still busy or someone else hasn't confirmed. */
  | "confirmed"
  /** p9: all four confirmed and the court is free. */
  | "headToCourt"
  | "playing"
  /** p15: on a break (their own) or paused by a host for not replying. */
  | "onBreak"
  | "left"
  | "ended";

export interface PlayerView {
  status: PlayerStatus;
  firstName: string;
  /** Current earned wait (frozen during a break). */
  waitMs: number | null;
  /** On a break: since when, and why. */
  breakStartedAt: number | null;
  breakReason: "break" | "noReply" | null;
  group: PlayerGroupView | null;
  /** Playing: when the game started. */
  gameStartedAt: number | null;
  friend: PlayerFriendView | null;
  now: number;
}

function seat(
  state: SessionState,
  participantId: string | null,
  you: string,
  confirmedIds: readonly string[],
): PlayerSeat {
  const participant =
    participantId === null ? null : state.participants[participantId];
  return {
    name: participant ? participantName(participant.participant) : "",
    isYou: participantId === you,
    isConfirmed: participantId !== null && confirmedIds.includes(participantId),
    isEmpty: participantId === null,
  };
}

function teamsView(
  state: SessionState,
  you: string,
  teamA: ReadonlyArray<string | null>,
  teamB: ReadonlyArray<string | null>,
  confirmedIds: readonly string[],
) {
  const yoursIsA = teamA.includes(you);
  const toSeats = (team: ReadonlyArray<string | null>) =>
    team.map((id) => seat(state, id, you, confirmedIds));
  return {
    yourTeam: toSeats(yoursIsA ? teamA : teamB),
    otherTeam: toSeats(yoursIsA ? teamB : teamA),
  };
}

function friendView(
  state: SessionState,
  participantId: string,
  waits: Map<string, number | null>,
): PlayerFriendView | null {
  const pair = friendPairOf(state, participantId);
  if (!pair) return null;
  const friendId =
    pair.participantId === participantId ? pair.friendId : pair.participantId;
  const friend = state.participants[friendId];
  if (!friend) return null;
  const friendName = participantName(friend.participant);
  if (pair.status === "accepted") return { status: "teamed", friendName };
  return pair.participantId === participantId
    ? { status: "youAsked", friendName }
    : {
        status: "askedYou",
        friendName,
        yourWaitMs: waits.get(participantId) ?? 0,
        theirWaitMs: waits.get(friendId) ?? 0,
      };
}

export function playerProjection(
  state: SessionState,
  participantId: string,
  now: number,
): PlayerView {
  const participant = state.participants[participantId];
  const base: PlayerView = {
    status: "notStarted",
    firstName: participant?.participant.firstName ?? "",
    waitMs: null,
    breakStartedAt: null,
    breakReason: null,
    group: null,
    gameStartedAt: null,
    friend: null,
    now,
  };
  if (state.phase === "notStarted" || !participant) return base;
  if (state.phase === "ended") return { ...base, status: "ended" };
  if (!isPresent(participant)) return { ...base, status: "left" };

  const metrics = playerMetrics(state, now);
  const waits = new Map(
    metrics.map((metric) => [metric.participantId, metric.currentWaitMs]),
  );
  const view: PlayerView = {
    ...base,
    waitMs: waits.get(participantId) ?? null,
    friend: friendView(state, participantId, waits),
  };

  if (participant.activeMatchId) {
    const match = state.matches[participant.activeMatchId];
    const lineup = currentLineup(match);
    const court = state.courts[match.courtId];
    return {
      ...view,
      status: "playing",
      gameStartedAt: match.startedAt,
      group: {
        courtId: match.courtId,
        courtName: court?.court.name ?? "",
        ...teamsView(
          state,
          participantId,
          lineup.filter((s) => s.team === "A").map((s) => s.participantId),
          lineup.filter((s) => s.team === "B").map((s) => s.participantId),
          [],
        ),
      },
    };
  }

  if (isSkipped(participant, now)) {
    const skip = participant.skips.at(-1)!;
    return {
      ...view,
      status: "onBreak",
      breakStartedAt: skip.from,
      breakReason: skip.reason ?? "break",
    };
  }

  const court = Object.values(state.courts).find(
    (candidate) =>
      candidate.nextGroup &&
      !isCourtClosed(candidate) &&
      calledSeats(candidate.nextGroup).includes(participantId),
  );
  if (!court) return { ...view, status: "ready" };
  const group = court.nextGroup!;
  const confirmedIds = group.confirmedIds ?? [];
  return {
    ...view,
    status: isUpNextReadyToPlay(state, court.court.courtId)
      ? "headToCourt"
      : confirmedIds.includes(participantId)
        ? "confirmed"
        : "upNext",
    group: {
      courtId: court.court.courtId,
      courtName: court.court.name,
      ...teamsView(
        state,
        participantId,
        group.teamA,
        group.teamB,
        confirmedIds,
      ),
    },
  };
}

/**
 * "Play with a friend" search (p12): at most 5 Ready players matching what
 * was typed (from 2 letters), names only; never yourself, anyone playing,
 * Up next, on a break or already in a pair.
 */
export function readyFriendMatches(
  state: SessionState,
  participantId: string,
  query: string,
  now: number,
): Array<{ participantId: string; name: string }> {
  const fold = (text: string) =>
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  const wanted = fold(query);
  if (wanted.length < 2) return [];
  const reserved = new Set(
    Object.values(state.courts).flatMap((court) =>
      court.nextGroup ? calledSeats(court.nextGroup) : [],
    ),
  );
  return Object.values(state.participants)
    .filter(
      (candidate) =>
        candidate.participant.participantId !== participantId &&
        isPresent(candidate) &&
        candidate.activeMatchId === null &&
        !isSkipped(candidate, now) &&
        !reserved.has(candidate.participant.participantId) &&
        !friendPairOf(state, candidate.participant.participantId) &&
        ` ${fold(participantName(candidate.participant))}`.includes(
          ` ${wanted}`,
        ),
    )
    .map((candidate) => ({
      participantId: candidate.participant.participantId,
      name: participantName(candidate.participant),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 5);
}
