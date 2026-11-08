// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatLastCheckedIn } from "./formatLastCheckedIn";

const NOW = new Date("2026-11-09T18:00:00Z");

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("formatLastCheckedIn", () => {
  it.each([
    [null, "Never checked in"],
    ["not a date", "Never checked in"],
    [minutesBefore(0), "Checked in just now"],
    // A clock slightly ahead of the server's still reads as "just now".
    [minutesBefore(-2), "Checked in just now"],
    [minutesBefore(5), "Checked in 5m ago"],
    [minutesBefore(59), "Checked in 59m ago"],
    [minutesBefore(60), "Checked in 1h ago"],
    [minutesBefore(23 * 60 + 59), "Checked in 23h ago"],
    [minutesBefore(24 * 60), "Checked in 1d ago"],
    [minutesBefore(6 * 24 * 60), "Checked in 6d ago"],
    [minutesBefore(7 * 24 * 60), "Checked in 2 Nov"],
    ["2026-01-01T00:00:00Z", "Checked in 1 Jan"],
    ["2025-12-31T23:59:00Z", "Checked in 31 Dec 2025"],
    ["2025-03-02T10:00:00Z", "Checked in 2 Mar 2025"],
  ])("%j → %j", (lastCheckedInAt, expected) => {
    expect(formatLastCheckedIn(lastCheckedInAt, NOW)).toBe(expected);
  });
});
