// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  formatCheckinHeaderWhen,
  formatFirstGameEstimate,
  formatTimeLeft,
} from "./checkinHeaderFormatting";

// Local times so the date line reads the same in any test time zone.
const PLANNED_START = new Date(2026, 10, 7, 18, 0).toISOString();
const PLANNED_END = new Date(2026, 10, 7, 20, 0).toISOString();

function localIso(hours: number, minutes: number, seconds = 0): string {
  return new Date(2026, 10, 7, hours, minutes, seconds).toISOString();
}

describe("formatTimeLeft", () => {
  it("counts whole minutes to the planned end, rounding up", () => {
    expect(formatTimeLeft(PLANNED_END, localIso(18, 40))).toBe("80 min left");
    expect(formatTimeLeft(PLANNED_END, localIso(18, 40, 30))).toBe(
      "80 min left",
    );
    expect(formatTimeLeft(PLANNED_END, localIso(19, 59, 59))).toBe(
      "1 min left",
    );
  });

  it("counts from before the start too (a draft)", () => {
    expect(formatTimeLeft(PLANNED_END, localIso(17, 0))).toBe("180 min left");
  });

  it("is omitted once the planned end has passed or the times are invalid", () => {
    expect(formatTimeLeft(PLANNED_END, localIso(20, 0))).toBeNull();
    expect(formatTimeLeft(PLANNED_END, localIso(21, 0))).toBeNull();
    expect(formatTimeLeft("not a time", localIso(18, 0))).toBeNull();
  });
});

describe("formatFirstGameEstimate", () => {
  it("estimates minutes to the planned start, rounding up", () => {
    expect(formatFirstGameEstimate(PLANNED_START, localIso(17, 54))).toBe(
      "~6m",
    );
    expect(formatFirstGameEstimate(PLANNED_START, localIso(17, 54, 30))).toBe(
      "~6m",
    );
    expect(formatFirstGameEstimate(PLANNED_START, localIso(17, 59, 59))).toBe(
      "~1m",
    );
    expect(formatFirstGameEstimate(PLANNED_START, localIso(17, 1))).toBe(
      "~59m",
    );
  });

  it("shows whole hours from an hour away, so it fits the tile", () => {
    expect(formatFirstGameEstimate(PLANNED_START, localIso(17, 0))).toBe("~1h");
    expect(formatFirstGameEstimate(PLANNED_START, localIso(15, 30))).toBe(
      "~3h",
    );
  });

  it("says Now once the planned start has passed (or is invalid)", () => {
    expect(formatFirstGameEstimate(PLANNED_START, localIso(18, 0))).toBe("Now");
    expect(formatFirstGameEstimate(PLANNED_START, localIso(18, 30))).toBe(
      "Now",
    );
    expect(formatFirstGameEstimate("not a time", localIso(18, 0))).toBe("Now");
  });
});

describe("formatCheckinHeaderWhen", () => {
  const session = { plannedStart: PLANNED_START, plannedEnd: PLANNED_END };

  it("reads like the design: date, planned times and time left", () => {
    expect(formatCheckinHeaderWhen(session, localIso(18, 40))).toBe(
      "Sat 7 Nov · 18:00 – 20:00 · 80 min left",
    );
  });

  it("drops the time left after the planned end", () => {
    expect(formatCheckinHeaderWhen(session, localIso(20, 5))).toBe(
      "Sat 7 Nov · 18:00 – 20:00",
    );
  });
});
