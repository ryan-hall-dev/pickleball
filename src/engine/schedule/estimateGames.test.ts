// @vitest-environment node
import { describe, expect, it } from "vitest";
import { estimateGames, fillableSeats } from "./estimateGames";

const base = {
  durationMinutes: 120,
  targetMatchMinutes: 15,
  changeoverMinutes: 2,
};

describe("estimateGames", () => {
  it("estimates rounds × seats / players as a range (7 rounds in 120 min; 9 rounds in 153 min gives 4-5 games each)", () => {
    const estimate = estimateGames({
      ...base,
      courtFormats: ["doubles", "doubles"],
      playerCount: 15,
    });
    expect(estimate).toEqual({
      kind: "estimate",
      rounds: 7,
      seats: 8,
      gamesPerPlayer: (7 * 8) / 15,
      lowGamesPerPlayer: 3,
      highGamesPerPlayer: 4,
    });
    const designExample = estimateGames({
      ...base,
      durationMinutes: 153,
      courtFormats: ["doubles", "doubles"],
      playerCount: 15,
    });
    expect(designExample).toMatchObject({
      rounds: 9,
      lowGamesPerPlayer: 4,
      highGamesPerPlayer: 5,
    });
  });

  it("computes rounds from the actual session length, match length and changeover", () => {
    // Default timings: 120 min of 15-min matches + 2-min changeovers = 7 rounds.
    expect(
      estimateGames({ ...base, courtFormats: ["doubles"], playerCount: 8 }),
    ).toMatchObject({ rounds: 7 });
    // Other timings: 90 min of 12 + 3 = 6 rounds; 100 min of 20 + 0 = 5 rounds.
    expect(
      estimateGames({
        durationMinutes: 90,
        targetMatchMinutes: 12,
        changeoverMinutes: 3,
        courtFormats: ["doubles"],
        playerCount: 8,
      }),
    ).toMatchObject({ rounds: 6, gamesPerPlayer: 3 });
    expect(
      estimateGames({
        durationMinutes: 100,
        targetMatchMinutes: 20,
        changeoverMinutes: 0,
        courtFormats: ["doubles"],
        playerCount: 8,
      }),
    ).toMatchObject({ rounds: 5 });
  });

  it("only counts courts that can be filled, largest first", () => {
    expect(fillableSeats(["doubles", "doubles"], 7)).toBe(4);
    expect(fillableSeats(["singles", "doubles", "doubles"], 7)).toBe(6);
    expect(fillableSeats(["doubles"], 20)).toBe(4);
  });

  it("reports an exact estimate as a single number", () => {
    expect(
      estimateGames({ ...base, courtFormats: ["doubles"], playerCount: 4 }),
    ).toMatchObject({
      gamesPerPlayer: 7,
      lowGamesPerPlayer: 7,
      highGamesPerPlayer: 7,
    });
  });

  it("handles the edge cases", () => {
    expect(
      estimateGames({ ...base, courtFormats: [], playerCount: 8 }),
    ).toEqual({
      kind: "noCourts",
    });
    expect(
      estimateGames({
        ...base,
        courtFormats: ["doubles", "singles"],
        playerCount: 1,
      }),
    ).toEqual({ kind: "notEnoughPlayers", playersNeeded: 2 });
    expect(
      estimateGames({
        ...base,
        durationMinutes: 16,
        courtFormats: ["doubles"],
        playerCount: 8,
      }),
    ).toEqual({ kind: "fewerThanOneRound" });
    expect(() =>
      estimateGames({
        durationMinutes: 60,
        targetMatchMinutes: 0,
        changeoverMinutes: 0,
        courtFormats: ["doubles"],
        playerCount: 8,
      }),
    ).toThrow(/positive slot/);
  });
});
