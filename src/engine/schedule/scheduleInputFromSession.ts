// Builds the scheduler's plain snapshot from a replayed session, so the live
// screen can call `recommend(scheduleInputFromSession(state, now))`.
import {
  courtMetrics,
  measureMs,
  playerMetrics,
  type EpochMs,
  type SessionState,
} from "../session";
import { createSeededRandom } from "./seededRandom";
import type { ScheduleCourt, ScheduleInput, SchedulePlayer } from "./types";

const MINUTE_MS = 60_000;

/** Same rule as the session metrics: never before the last event, never after the end. */
function measurementTime(state: SessionState, now: EpochMs): EpochMs {
  if (state.endedAt !== null) return state.endedAt;
  return Math.max(now, state.lastAt ?? now);
}

/**
 * The suggestion seed mixed with the completed-match count, so tie-breaks
 * rotate as the session goes on instead of favouring the same players all
 * evening; "Shuffle" still changes it immediately.
 */
function rotatingSeed(state: SessionState): number {
  let completedMatchCount = 0;
  for (const match of Object.values(state.matches)) {
    if (match.status === "completed") completedMatchCount += 1;
  }
  return (
    (createSeededRandom(
      (state.suggestionSeed ^ Math.imul(completedMatchCount, 0x9e3779b1)) >>> 0,
    )() *
      4_294_967_296) >>>
    0
  );
}

/** The session's own average match length once it has completed matches, else the target. */
function expectedMatchMs(state: SessionState): number {
  const targetMs = (state.config?.targetMatchMinutes ?? 0) * MINUTE_MS;
  let completedCount = 0;
  let totalMs = 0;
  for (const match of Object.values(state.matches)) {
    if (match.status !== "completed" || match.endedAt === null) continue;
    completedCount += 1;
    totalMs += measureMs(
      [{ from: match.startedAt, to: match.endedAt }],
      match.endedAt,
      state.pauses,
    );
  }
  return completedCount === 0 ? targetMs : totalMs / completedCount || targetMs;
}

/**
 * The scheduling snapshot at `now` (server epoch ms). Players who have left
 * and closed courts are left out. Throws if the session has not started.
 */
export function scheduleInputFromSession(
  state: SessionState,
  now: EpochMs,
): ScheduleInput {
  const config = state.config;
  if (config === null) {
    throw new Error("Cannot recommend before the session has started.");
  }
  const until = measurementTime(state, now);
  const activeMsSince = (from: EpochMs) =>
    measureMs([{ from, to: null }], until, state.pauses);

  const players: SchedulePlayer[] = [];
  for (const metrics of playerMetrics(state, now)) {
    if (metrics.status === "away") continue;
    players.push({
      participantId: metrics.participantId,
      skill: metrics.participant.skill,
      status: metrics.status,
      gamesCompleted: metrics.gamesCompleted,
      pendingGameCredit: metrics.committedGames - metrics.gamesCompleted,
      presentMs: metrics.presentMs,
      playMs: metrics.playMs,
      currentWaitMs: metrics.currentWaitMs ?? 0,
      restMs:
        metrics.lastMatchEndAt === null
          ? null
          : activeMsSince(metrics.lastMatchEndAt),
      completedGameAgesMs: metrics.completedGameEndTimes.map(activeMsSince),
      partnerCounts: metrics.partnerCounts,
      opponentCounts: metrics.opponentCounts,
      isLocked: metrics.isLocked,
      lockedCourtId: metrics.lockedCourtId,
      manualQueueRank: metrics.manualQueueRank,
      currentCourtId: metrics.currentCourtId,
    });
  }

  const courts: ScheduleCourt[] = courtMetrics(state, now)
    .filter((metrics) => metrics.status !== "closed")
    .map((metrics) => ({
      courtId: metrics.courtId,
      name: metrics.court.name,
      format: metrics.court.format,
      currentMatchElapsedMs: metrics.currentMatchElapsedMs,
    }));

  return {
    slotMs: (config.targetMatchMinutes + config.changeoverMinutes) * MINUTE_MS,
    expectedMatchMs: expectedMatchMs(state),
    preferences: config.rotation,
    seed: rotatingSeed(state),
    players,
    courts,
  };
}
