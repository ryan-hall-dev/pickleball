// Estimated games per player for the setup summary (plan §5.8). Always an
// estimate: the UI labels it "about" / "≈".
import { PLAYERS_PER_MATCH, type CourtFormat } from "../session";

export interface EstimateGamesInput {
  durationMinutes: number;
  targetMatchMinutes: number;
  changeoverMinutes: number;
  courtFormats: CourtFormat[];
  playerCount: number;
}

export type GamesEstimate =
  | { kind: "noCourts" }
  | {
      kind: "notEnoughPlayers";
      /** Players the smallest court needs. */
      playersNeeded: number;
    }
  | { kind: "fewerThanOneRound" }
  | {
      kind: "estimate";
      /** Full slots (match + changeover) that fit in the session. */
      rounds: number;
      /** Seats on the courts that can actually be filled. */
      seats: number;
      /** rounds × seats / players. */
      gamesPerPlayer: number;
      /** floor and ceil of `gamesPerPlayer`, for "expect 4–5 games each". */
      lowGamesPerPlayer: number;
      highGamesPerPlayer: number;
    };

/** Seats on the courts that can be filled, largest courts first, until players run out. */
export function fillableSeats(
  courtFormats: readonly CourtFormat[],
  playerCount: number,
): number {
  const courtSizes = courtFormats
    .map((format) => PLAYERS_PER_MATCH[format])
    .sort((left, right) => right - left);
  let seats = 0;
  for (const courtSize of courtSizes) {
    if (playerCount - seats >= courtSize) seats += courtSize;
  }
  return seats;
}

export function estimateGames(input: EstimateGamesInput): GamesEstimate {
  const slotMinutes = input.targetMatchMinutes + input.changeoverMinutes;
  if (!(slotMinutes > 0) || !(input.durationMinutes >= 0)) {
    throw new Error(
      `estimateGames needs a positive slot and a non-negative duration (got slot ${slotMinutes}, duration ${input.durationMinutes}).`,
    );
  }
  if (input.courtFormats.length === 0) return { kind: "noCourts" };
  const smallestCourtSize = Math.min(
    ...input.courtFormats.map((format) => PLAYERS_PER_MATCH[format]),
  );
  if (input.playerCount < smallestCourtSize) {
    return { kind: "notEnoughPlayers", playersNeeded: smallestCourtSize };
  }
  const rounds = Math.floor(input.durationMinutes / slotMinutes);
  if (rounds === 0) return { kind: "fewerThanOneRound" };
  const seats = fillableSeats(input.courtFormats, input.playerCount);
  const gamesPerPlayer = (rounds * seats) / input.playerCount;
  return {
    kind: "estimate",
    rounds,
    seats,
    gamesPerPlayer,
    lowGamesPerPlayer: Math.floor(gamesPerPlayer),
    highGamesPerPlayer: Math.ceil(gamesPerPlayer),
  };
}
