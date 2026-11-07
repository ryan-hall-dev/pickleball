// @vitest-environment node
// `recommend()` latency on realistic mid-session inputs (plan §6 benchmarks).
// Target: p95 < 5 ms at 500 attendees / 50 courts (asserted on p99, which is stricter).
import { describe, test } from "vitest";
import type { CourtFormat } from "../session";
import { recommend } from "./recommend";
import { simulateSession } from "./simulation/simulateSession";
import type { ScheduleInput } from "./types";

const SIZES: Array<{ players: number; courts: number }> = [
  { players: 8, courts: 2 },
  { players: 30, courts: 4 },
  { players: 120, courts: 12 },
  { players: 500, courts: 50 },
];
const P95_TARGET_MS = 5;

/** Every input the engine saw during one simulated 2-hour session. */
function recordedInputs(players: number, courts: number): ScheduleInput[] {
  const inputs: ScheduleInput[] = [];
  simulateSession({
    seed: 42,
    courtFormats: Array<CourtFormat>(courts).fill("doubles"),
    initialPlayerCount: players,
    onRecommendation: ({ input }) => inputs.push(input),
  });
  return inputs;
}

describe("recommend()", () => {
  for (const { players, courts } of SIZES) {
    test(`${players} players / ${courts} courts`, async ({ bench, expect }) => {
      const inputs = recordedInputs(players, courts);
      let next = 0;
      const result = await bench(`recommend ${players}/${courts}`, () => {
        recommend(inputs[next]);
        next = (next + 1) % inputs.length;
      }).run();
      if (players === 500) {
        expect(result.latency.p99).toBeLessThan(P95_TARGET_MS);
      }
    });
  }
});
