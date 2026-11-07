// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createInitialSessionState, matchRecords } from "../session";
import { simulateSession } from "../schedule/simulation/simulateSession";
import { buildFairnessReport, jainIndex, summarise } from "./fairnessReport";

describe("statistics helpers", () => {
  it("summarises min, mean, max and population standard deviation", () => {
    expect(summarise([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({
      min: 2,
      mean: 5,
      max: 9,
      standardDeviation: 2,
    });
    expect(summarise([])).toBeNull();
  });

  it("gives Jain's index 100 for equal shares and 100/n when one player has everything", () => {
    expect(jainIndex([3, 3, 3, 3])).toBeCloseTo(100);
    expect(jainIndex([5, 0, 0, 0])).toBeCloseTo(25);
    expect(jainIndex([0, 0])).toBe(100);
  });
});

describe("buildFairnessReport", () => {
  it("is empty before the session starts", () => {
    const report = buildFairnessReport(createInitialSessionState(), 0);
    expect(report).toMatchObject({
      playerCount: 0,
      games: null,
      courtUtilisation: null,
      jainGamesIndex: null,
      jainPlayTimeIndex: null,
    });
  });

  it("shows the index as empty before any completed game or with fewer than 2 players", () => {
    const lonePlayer = simulateSession({
      seed: 1,
      courtFormats: ["doubles"],
      initialPlayerCount: 1,
    });
    const report = buildFairnessReport(
      lonePlayer.state,
      lonePlayer.state.endedAt!,
    );
    expect(report.playerCount).toBe(1);
    expect(report.jainGamesIndex).toBeNull();
    expect(report.courtUtilisation).toBe(0);
  });

  it("reconciles with the match records", () => {
    const { state } = simulateSession({
      seed: 3,
      courtFormats: ["doubles", "doubles", "singles"],
      initialPlayerCount: 15,
      lateArrivalCount: 3,
      departureCount: 2,
      pauseCount: 1,
    });
    const end = state.endedAt!;
    const report = buildFairnessReport(state, end);
    const records = matchRecords(state, end);
    for (const player of report.players) {
      const credited = records.filter(
        (record) =>
          record.status === "completed" &&
          record.creditedParticipantIds.includes(player.participantId),
      ).length;
      expect(player.gamesCompleted).toBe(credited);
      const playMs = records
        .flatMap((record) => record.segments)
        .filter((segment) => segment.participantId === player.participantId)
        .reduce((total, segment) => total + segment.playMs, 0);
      expect(player.playMs).toBe(playMs);
    }
    const totalFairShare = report.players.reduce(
      (total, player) => total + player.fairShareGames,
      0,
    );
    expect(totalFairShare).toBeCloseTo(
      report.players.reduce(
        (total, player) => total + player.gamesCompleted,
        0,
      ),
    );
    expect(report.games!.spread).toBe(report.games!.max - report.games!.min);
    expect(report.jainGamesIndex).toBeGreaterThan(100 / report.playerCount);
    expect(report.jainGamesIndex).toBeLessThanOrEqual(100);
    expect(report.courtUtilisation).toBeGreaterThan(0);
    expect(report.courtUtilisation).toBeLessThanOrEqual(1);
  });
});
