import { expect, it } from "vitest";
import { rosterLabelText, type RosterLabel } from "./rosterLabels";

const guestOf = (name: string) => `Guest of ${name}`;
const label = (overrides: Partial<RosterLabel>): RosterLabel => ({
  displayName: "Minh Nguyen",
  guestOfName: null,
  twinNumber: 1,
  twinCount: 1,
  guestNumber: null,
  guestCount: null,
  ...overrides,
});

it("names a player, numbering same-name entries", () => {
  expect(rosterLabelText(label({}), guestOf)).toBe("Minh Nguyen");
  expect(rosterLabelText(label({ twinNumber: 2, twinCount: 2 }), guestOf)).toBe(
    "Minh Nguyen (2)",
  );
});

it("names a guest by their player, numbering several guests", () => {
  const guest = label({
    displayName: null,
    guestOfName: "Duy Ha",
    guestNumber: 1,
    guestCount: 1,
  });
  expect(rosterLabelText(guest, guestOf)).toBe("Guest of Duy Ha");
  expect(
    rosterLabelText(
      { ...guest, guestNumber: 2, guestCount: 2, twinCount: 2, twinNumber: 1 },
      guestOf,
    ),
  ).toBe("Guest of Duy Ha (1) (2)");
});
