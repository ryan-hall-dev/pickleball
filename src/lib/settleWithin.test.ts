// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleWithin } from "./settleWithin";

describe("settleWithin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the call's result when it answers in time", async () => {
    const settled = settleWithin(Promise.resolve("answer"), 15_000, "fallback");
    await expect(settled).resolves.toBe("answer");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the fallback when the call fails", async () => {
    const settled = settleWithin(
      Promise.reject(new Error("offline")),
      15_000,
      "fallback",
    );
    await expect(settled).resolves.toBe("fallback");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the fallback once the time is up, and ignores a late answer", async () => {
    let answer: (value: string) => void = () => {};
    const call = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const settled = settleWithin(call, 15_000, "fallback");
    let settledValue: string | null = null;
    void settled.then((value) => {
      settledValue = value;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settledValue).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settledValue).toBe("fallback");

    answer("late answer");
    await vi.runAllTimersAsync();
    expect(settledValue).toBe("fallback");
  });
});
