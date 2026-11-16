import { simpleRecommend } from "@/engine/schedule/simpleRecommend";
import {
  currentLineup,
  compensate,
  type EventMeta,
  participantName,
  playerMetrics,
  simpleSessionDeadline,
  simpleSessionTimeIsUp,
  type SessionState,
} from "@/engine/session";
import type { LiveSessionView, LiveUndoOption } from "./liveTypes";

function recentUndoOptions(
  state: SessionState,
  probe: EventMeta,
): LiveUndoOption[] {
  if (state.phase !== "live") return [];
  const seenCourts = new Set<string>();
  const options: LiveUndoOption[] = [];
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
    undoOptions: recentUndoOptions(state, probe),
  };
}
