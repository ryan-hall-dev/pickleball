// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatLocalClockTime, formatSessionWhen } from "./sessionTime";

describe("session time formatting", () => {
  it("formats a local clock time with two-digit hours and minutes", () => {
    expect(formatLocalClockTime(new Date(2026, 10, 7, 8, 5))).toBe("08:05");
  });

  it("formats the When line", () => {
    expect(
      formatSessionWhen(
        new Date(2026, 10, 7, 18, 0),
        new Date(2026, 10, 7, 20, 0),
      ),
    ).toBe("Sat 7 Nov · 18:00 – 20:00");
  });
});
