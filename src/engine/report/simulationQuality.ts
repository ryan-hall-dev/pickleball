// Quality measurements for simulated sessions (plan §6 quality targets), used
// by the simulation tests and calibration. Test support only: it lives in
// `report/` because it combines the scheduler's simulator with the report,
// and the scheduler must never import the report.
import { matchRecords, type SessionState } from "../session";
import {
  simulateSession,
  type SessionSimulationOptions,
  type SessionSimulationResult,
} from "../schedule/simulation/simulateSession";
import { buildFairnessReport, type FairnessReport } from "./fairnessReport";

const MINUTE_MS = 60_000;

export interface SessionQuality {
  /** Report on the final (ended) state. */
  finalReport: FairnessReport;
  gameSpread: number;
  jainGamesIndex: number | null;
  /** Court utilisation up to the planned end (0-1). */
  utilisationToPlannedEnd: number | null;
  /** Longest single wait, in slots. */
  maxWaitSlots: number;
  /** Share of partner pairings in completed matches that had already partnered earlier in the session. */
  repeatPartnerRate: number;
  /** Share of match starts by a player who came off court less than a minute earlier (no sit-out). */
  backToBackRate: number;
  completedMatchCount: number;
}

/** Fraction of partner pairs (in completed matches, in start order) that repeat an earlier pairing. */
export function repeatPartnerRate(state: SessionState): number {
  const seenPairs = new Set<string>();
  let pairCount = 0;
  let repeatCount = 0;
  const end = state.endedAt ?? state.lastAt ?? 0;
  for (const record of matchRecords(state, end)) {
    if (record.status !== "completed") continue;
    for (const team of [record.teamA, record.teamB]) {
      if (team.length < 2) continue;
      const pairKey = [...team].sort().join("|");
      pairCount += 1;
      if (seenPairs.has(pairKey)) repeatCount += 1;
      seenPairs.add(pairKey);
    }
  }
  return pairCount === 0 ? 0 : repeatCount / pairCount;
}

const BACK_TO_BACK_GAP_MS = MINUTE_MS;

/** Share of match starts (per player) within a minute of that player's previous match ending. */
export function backToBackRate(state: SessionState): number {
  const end = state.endedAt ?? state.lastAt ?? 0;
  const lastEndByPlayer = new Map<string, number>();
  let starts = 0;
  let backToBack = 0;
  for (const record of matchRecords(state, end)) {
    if (record.status !== "completed" || record.endedAt === null) continue;
    for (const participantId of [...record.teamA, ...record.teamB]) {
      starts += 1;
      const lastEnd = lastEndByPlayer.get(participantId);
      if (
        lastEnd !== undefined &&
        record.startedAt - lastEnd < BACK_TO_BACK_GAP_MS
      ) {
        backToBack += 1;
      }
      lastEndByPlayer.set(participantId, record.endedAt);
    }
  }
  return starts === 0 ? 0 : backToBack / starts;
}

export function measureSessionQuality(
  result: SessionSimulationResult,
  options: Pick<
    SessionSimulationOptions,
    "targetMatchMinutes" | "changeoverMinutes"
  >,
): SessionQuality {
  const slotMs =
    ((options.targetMatchMinutes ?? 15) + (options.changeoverMinutes ?? 2)) *
    MINUTE_MS;
  const finalReport = buildFairnessReport(
    result.state,
    result.state.endedAt ?? result.plannedEndAt,
  );
  const plannedEndReport = buildFairnessReport(
    result.stateAtPlannedEnd,
    result.plannedEndAt,
  );
  return {
    finalReport,
    gameSpread: finalReport.games?.spread ?? 0,
    jainGamesIndex: finalReport.jainGamesIndex,
    utilisationToPlannedEnd: plannedEndReport.courtUtilisation,
    maxWaitSlots: result.maxObservedWaitMs / slotMs,
    repeatPartnerRate: repeatPartnerRate(result.state),
    backToBackRate: backToBackRate(result.state),
    completedMatchCount: Object.values(result.state.matches).filter(
      (match) => match.status === "completed",
    ).length,
  };
}

/** Runs one simulation and measures it. */
export function simulateAndMeasure(
  options: SessionSimulationOptions,
): SessionQuality & { result: SessionSimulationResult } {
  const result = simulateSession(options);
  return { ...measureSessionQuality(result, options), result };
}
