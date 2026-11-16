// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  formatCheckinHeaderWhen,
  formatCheckinSessionWhen,
  formatTimeLeft,
} from "./checkinHeaderFormatting";

function localIso(hours: number, minutes: number, seconds = 0): string {
  return new Date(2026, 10, 7, hours, minutes, seconds).toISOString();
}
const live = {
  status: "live" as const,
  durationMinutes: 120,
  startedAt: localIso(18, 0),
  endsAt: localIso(20, 0),
};

describe("check-in session timing", () => {
  it("counts whole minutes from the database clock, rounding up", () => {
    expect(formatTimeLeft(live.endsAt, localIso(18, 40))).toBe("80 min left");
    expect(formatTimeLeft(live.endsAt, localIso(19, 59, 59))).toBe(
      "1 min left",
    );
    expect(formatTimeLeft(live.endsAt, localIso(20, 0))).toBeNull();
    expect(formatTimeLeft("invalid", localIso(18, 0))).toBeNull();
  });
  it("shows only the chosen duration before actual Start", () => {
    const draft = {
      status: "draft" as const,
      durationMinutes: 75,
      startedAt: null,
      endsAt: null,
    };
    expect(formatCheckinHeaderWhen(draft, localIso(22, 0))).toBe(
      "75 min session",
    );
    expect(formatCheckinSessionWhen(draft)).toBe("75 min session");
  });
  it("shows actual live times and remaining duration", () => {
    expect(formatCheckinHeaderWhen(live, localIso(18, 40))).toBe(
      "Sat 7 Nov · 18:00 – 20:00 · 80 min left",
    );
  });
  it("says time is up while games may still be finishing", () => {
    expect(formatCheckinHeaderWhen(live, localIso(20, 5))).toBe(
      "Sat 7 Nov · 18:00 – 20:00 · Session time is up",
    );
  });
  it("says a draft's duration is unavailable instead of inventing one", () => {
    const draft = {
      status: "draft" as const,
      durationMinutes: null,
      startedAt: null,
      endsAt: null,
    };
    expect(formatCheckinSessionWhen(draft)).toBe("Duration unavailable");
    expect(formatCheckinHeaderWhen(draft, localIso(22, 0))).toBe(
      "Duration unavailable",
    );
  });
  it("keeps the actual start but no end when a live duration is unusable", () => {
    const unusable = { ...live, durationMinutes: null, endsAt: null };
    expect(formatCheckinSessionWhen(unusable)).toBe(
      "Started 18:00 · end time unavailable",
    );
    // No "min left" or "time is up" can be derived without an end.
    expect(formatCheckinHeaderWhen(unusable, localIso(18, 40))).toBe(
      "Started 18:00 · end time unavailable",
    );
  });
  it("does not invent an actual start for an old live row without one", () => {
    expect(
      formatCheckinHeaderWhen(
        { ...live, startedAt: null, endsAt: null },
        localIso(18, 40),
      ),
    ).toBe("Start time unavailable");
  });
});
