// @vitest-environment node
// Whole-session and replay benchmarks (plan §6). Targets: a full simulated
// 2-hour session at 500 attendees / 50 courts < 1 s; replaying a 1,000-action
// log < 5 ms. The simulator acts only on Ready now groups, so it skips the Up
// next forecasts (measured separately below).
import { describe, test } from "vitest";
import { replay, type CourtFormat } from "../../session";
import { simulateSession } from "./simulateSession";

const FULL_SESSION_TARGET_MS = 1_000;
const REPLAY_TARGET_MS = 5;
const REPLAY_ACTION_COUNT = 1_000;

const largeSession = (
  seed: number,
  { durationMinutes = 120, includeUpNext = false } = {},
) =>
  simulateSession({
    seed,
    courtFormats: Array<CourtFormat>(50).fill("doubles"),
    initialPlayerCount: 500,
    durationMinutes,
    includeUpNext,
  });

describe("simulated sessions", () => {
  test("full 2-hour session, 500 attendees / 50 courts", async ({
    bench,
    expect,
  }) => {
    let seed = 0;
    const result = await bench("simulate 2 h 500/50", () => {
      seed += 1;
      largeSession(seed);
    }).run({ iterations: 8, warmupIterations: 1, time: 0 });
    expect(result.latency.mean).toBeLessThan(FULL_SESSION_TARGET_MS);
  });

  // For transparency: the same session also computing every Up next forecast
  // (which the simulator never reads). Not a plan target.
  test("full 2-hour session, 500 / 50, with Up next forecasts", async ({
    bench,
  }) => {
    let seed = 0;
    await bench("simulate 2 h 500/50 + Up next", () => {
      seed += 1;
      largeSession(seed, { includeUpNext: true });
    }).run({ iterations: 4, warmupIterations: 1, time: 0 });
  });

  test("full 2-hour session, 30 attendees / 4 courts", async ({ bench }) => {
    let seed = 0;
    await bench("simulate 2 h 30/4", () => {
      seed += 1;
      simulateSession({
        seed,
        courtFormats: Array<CourtFormat>(4).fill("doubles"),
        initialPlayerCount: 30,
        lateArrivalCount: 6,
        departureCount: 4,
        pauseCount: 1,
      });
    }).run();
  });
});

describe("replay", () => {
  test("replay a 1,000-action log", async ({ bench, expect }) => {
    // A 4-hour 500/50 session produces well over 1,000 actions; any prefix of a valid log is valid.
    const events = largeSession(1, { durationMinutes: 240 }).events.slice(
      0,
      REPLAY_ACTION_COUNT,
    );
    expect(events).toHaveLength(REPLAY_ACTION_COUNT);
    const result = await bench("replay 1,000 actions", () => {
      if (!replay(events).ok) throw new Error("replay failed");
    }).run();
    expect(result.latency.p99).toBeLessThan(REPLAY_TARGET_MS);
  });
});
