import { simpleRecommend } from "@/engine/schedule/simpleRecommend";
import {
  calledSeats,
  currentLineup,
  compensate,
  friendPairOf,
  isCourtClosed,
  isSimpleSocialV2,
  type EventMeta,
  participantName,
  playerMetrics,
  simpleSessionDeadline,
  simpleSessionTimeIsUp,
  type SessionState,
} from "@/engine/session";
import type {
  LiveRecentGame,
  LiveSessionView,
  LiveUndoOption,
} from "./liveTypes";

/** When each player now in a called group was put in it (its call, or the change that seated them). */
function askedAtOf(
  state: SessionState,
  calledEventId: string,
  seated: ReadonlyArray<string | null>,
): Record<string, number> {
  const askedAt: Record<string, number> = {};
  let previous = new Set<string>();
  for (const { event } of state.history) {
    let ids: Array<string | null> | null = null;
    if (event.type === "NextGroupCalled" && event.eventId === calledEventId)
      ids = [...event.payload.teamA, ...event.payload.teamB];
    if (
      event.type === "NextGroupChanged" &&
      event.payload.calledEventId === calledEventId
    )
      ids = [...event.payload.teamA, ...event.payload.teamB];
    if (!ids) continue;
    for (const id of ids) if (id && !previous.has(id)) askedAt[id] = event.at;
    previous = new Set(ids.filter((id): id is string => id !== null));
  }
  return Object.fromEntries(
    seated.flatMap((id) =>
      id && askedAt[id] !== undefined ? [[id, askedAt[id]]] : [],
    ),
  );
}

/** A court's latest close (or "close after this game") if it can still be undone. */
function closeUndoOptions(
  state: SessionState,
  probe: EventMeta,
): LiveUndoOption[] {
  const options: LiveUndoOption[] = [];
  for (const court of Object.values(state.courts)) {
    const closure = court.closures.at(-1);
    const targetSeq =
      closure && closure.to === null
        ? closure.closedBySeq
        : (court.closeScheduledBySeq ?? null);
    if (targetSeq === null) continue;
    if (compensate(state, targetSeq, probe).ok)
      options.push({
        courtId: court.court.courtId,
        matchId: "",
        targetSeq,
        kind: closure && closure.to === null ? "close" : "closeAfterGame",
      });
  }
  return options;
}

function recentUndoOptions(
  state: SessionState,
  probe: EventMeta,
): LiveUndoOption[] {
  if (state.phase !== "live") return [];
  const seenCourts = new Set<string>();
  const options: LiveUndoOption[] = closeUndoOptions(state, probe);
  // Stop at each court's latest start, even if undone: never surface an older
  // game merely because the host just recovered from a newer accidental start.
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const entry = state.history[index];
    if (entry.event.type !== "MatchStarted") continue;
    const { courtId, matchId } = entry.event.payload;
    if (seenCourts.has(courtId)) continue;
    seenCourts.add(courtId);
    const match = state.matches[matchId];
    if (
      !match ||
      entry.compensatedBySeq !== null ||
      match.status === "abandoned"
    )
      continue;
    const targetSeq =
      match.status === "active" ? match.startedBySeq : match.endedBySeq;
    if (targetSeq !== null && compensate(state, targetSeq, probe).ok) {
      options.push({
        courtId,
        matchId,
        targetSeq,
        kind: match.status === "active" ? "start" : "finish",
      });
    }
  }
  return options;
}

/** Compact derived phone view; no action log or historical match details cross the boundary. */
export function liveProjection(
  sessionId: string,
  name: string,
  state: SessionState,
  now: number,
  probe: EventMeta,
  prepareCourtId?: string,
  /** simple-social-v2: participants checked in with a phone. */
  phoneParticipantIds: ReadonlySet<string> = new Set(),
  /** simple-social-v2: standing scores by match id. */
  scores: ReadonlyMap<string, LiveRecentGame["score"]> = new Map(),
): LiveSessionView {
  const isV2 = isSimpleSocialV2(state.config);
  const suggestions = simpleRecommend(
    state,
    now,
    prepareCourtId ? [prepareCourtId] : [],
  );
  const courts = Object.values(state.courts).map((courtState) => {
    const { court, activeMatchId, nextGroup } = courtState;
    const match = activeMatchId ? state.matches[activeMatchId] : null;
    const lineup = match ? currentLineup(match) : [];
    return {
      courtId: court.courtId,
      name: court.name,
      activeMatch: match
        ? {
            matchId: match.matchId,
            startedAt: match.startedAt,
            teamA: lineup
              .filter((seat) => seat.team === "A")
              .map((seat) => seat.participantId),
            teamB: lineup
              .filter((seat) => seat.team === "B")
              .map((seat) => seat.participantId),
          }
        : null,
      called: nextGroup
        ? {
            ...nextGroup,
            ...(isV2
              ? {
                  confirmedIds: nextGroup.confirmedIds ?? [],
                  askedAt: askedAtOf(
                    state,
                    nextGroup.calledEventId,
                    calledSeats(nextGroup),
                  ),
                }
              : {}),
          }
        : null,
      isClosed: isCourtClosed(courtState),
      closesAfterGame: !!courtState.closeScheduledBySeq,
      suggestion:
        suggestions.find(
          (suggestion) => suggestion.courtId === court.courtId,
        ) ?? null,
    };
  });
  const pairOf = (participantId: string) => {
    const pair = isV2 ? friendPairOf(state, participantId) : null;
    if (!pair) return null;
    const friendId =
      pair.participantId === participantId ? pair.friendId : pair.participantId;
    const friend = state.participants[friendId];
    return friend
      ? {
          requestSeq: pair.requestSeq,
          friendName: participantName(friend.participant),
          isTeamed: pair.status === "accepted",
        }
      : null;
  };
  const players = playerMetrics(state, now)
    .map((metric) => {
      const skip = state.participants[metric.participantId].skips.at(-1);
      const calledCourt = courts.find(
        (court) =>
          court.called &&
          [...court.called.teamA, ...court.called.teamB].includes(
            metric.participantId,
          ),
      );
      return {
        participantId: metric.participantId,
        name: participantName(metric.participant),
        skill: metric.participant.skill ?? null,
        gender: metric.participant.gender ?? null,
        status: metric.status,
        currentWaitMs: metric.currentWaitMs,
        returnsAt:
          metric.status === "skipped" ? (skip?.returnsAt ?? null) : null,
        skipSeq:
          metric.status === "skipped" ? (skip?.skippedBySeq ?? null) : null,
        calledCourtId: calledCourt?.courtId ?? null,
        calledCourtName: calledCourt?.name ?? null,
        hasPhone: phoneParticipantIds.has(metric.participantId),
        skipReason: metric.status === "skipped" ? (skip?.reason ?? null) : null,
        skipSince: metric.status === "skipped" ? (skip?.from ?? null) : null,
        pair: pairOf(metric.participantId),
      };
    })
    .sort(
      (left, right) =>
        (right.currentWaitMs ?? 0) - (left.currentWaitMs ?? 0) ||
        left.participantId.localeCompare(right.participantId),
    );
  return {
    sessionId,
    name,
    phase: state.phase === "ended" ? "ended" : "live",
    isV2,
    lastSeq: state.lastSeq,
    now,
    startedAt: state.startedAt!,
    endedAt: state.endedAt,
    deadline: simpleSessionDeadline(state)!,
    timeIsUp: simpleSessionTimeIsUp(state, now),
    courts,
    players,
    undoOptions: recentUndoOptions(state, probe),
    ...(isV2 ? { recentGames: recentGames(state, scores) } : {}),
  };
}

/** How many finished games the host's score list shows. */
const RECENT_GAMES_SHOWN = 6;

/** The latest finished games, newest first, with names and any score (h13). */
export function recentGames(
  state: SessionState,
  scores: ReadonlyMap<string, LiveRecentGame["score"]>,
): LiveRecentGame[] {
  return Object.values(state.matches)
    .filter((match) => match.status === "completed" && match.endedAt !== null)
    .sort((left, right) => right.endedAt! - left.endedAt!)
    .slice(0, RECENT_GAMES_SHOWN)
    .map((match) => {
      const lineup = currentLineup(match);
      const names = (team: "A" | "B") =>
        lineup
          .filter((seat) => seat.team === team)
          .map((seat) => {
            const person = state.participants[seat.participantId];
            return person ? participantName(person.participant) : "";
          });
      return {
        matchId: match.matchId,
        courtName: state.courts[match.courtId]?.court.name ?? "",
        endedAt: match.endedAt!,
        teamA: names("A"),
        teamB: names("B"),
        score: scores.get(match.matchId) ?? null,
      };
    });
}
