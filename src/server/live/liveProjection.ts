import { simpleRecommend } from "@/engine/schedule/simpleRecommend";
import {
  currentLineup,
  participantName,
  playerMetrics,
  simpleSessionDeadline,
  simpleSessionTimeIsUp,
  type SessionState,
} from "@/engine/session";
import type { LiveSessionView } from "./liveTypes";

/** Compact derived phone view; no action log or historical match details cross the boundary. */
export function liveProjection(
  sessionId: string,
  name: string,
  state: SessionState,
  now: number,
  prepareCourtId?: string,
): LiveSessionView {
  const suggestions = simpleRecommend(
    state,
    now,
    prepareCourtId ? [prepareCourtId] : [],
  );
  const courts = Object.values(state.courts).map(
    ({ court, activeMatchId, nextGroup }) => {
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
        called: nextGroup ?? null,
        suggestion:
          suggestions.find(
            (suggestion) => suggestion.courtId === court.courtId,
          ) ?? null,
      };
    },
  );
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
    lastSeq: state.lastSeq,
    now,
    startedAt: state.startedAt!,
    endedAt: state.endedAt,
    deadline: simpleSessionDeadline(state)!,
    timeIsUp: simpleSessionTimeIsUp(state, now),
    courts,
    players,
  };
}
