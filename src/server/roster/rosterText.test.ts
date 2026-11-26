import { describe, expect, it } from "vitest";
import {
  compareRosterPaste,
  readPastedRoster,
  rosterNameKey,
  type ExistingRosterEntry,
} from "./rosterText";

const RECLUB_TEXT = `🏓 Riverside Social
📅 Thu 27 Nov · 18:30
📍 Riverside Courts

Confirmed (6/16)
1. An Vo
2. Duy Ha (+1)
3. Minh Nguyen
4. Minh Nguyen
5. Sunny (Host)
6.   Chi   Lam

Waitlist (2)
1. Oscar Bell
2. Phuc Ngo`;

describe("readPastedRoster", () => {
  it("reads only the Confirmed names, strips numbering and tags, counts the waitlist", () => {
    expect(readPastedRoster(RECLUB_TEXT)).toEqual({
      names: [
        { name: "An Vo", guestCount: 0 },
        { name: "Duy Ha", guestCount: 1 },
        { name: "Minh Nguyen", guestCount: 0 },
        { name: "Minh Nguyen", guestCount: 0 },
        { name: "Sunny", guestCount: 0 },
        { name: "Chi Lam", guestCount: 0 },
      ],
      waitlistCount: 2,
      skippedLines: [],
    });
  });

  it("accepts a plain list of names and ignores blank lines", () => {
    expect(readPastedRoster("An Vo\n\n  Thao \n- Bao Truong").names).toEqual([
      { name: "An Vo", guestCount: 0 },
      { name: "Thao", guestCount: 0 },
      { name: "Bao Truong", guestCount: 0 },
    ]);
  });

  it("limits guests per line and skips over-long lines", () => {
    const roster = readPastedRoster(
      `Confirmed (2/16)\n1. Lan Dinh (+5)\n2. ${"x".repeat(51)}`,
    );
    expect(roster.names).toEqual([{ name: "Lan Dinh", guestCount: 3 }]);
    expect(roster.skippedLines).toHaveLength(1);
  });

  it("gives nothing for an empty paste", () => {
    expect(readPastedRoster("  \n")).toEqual({
      names: [],
      waitlistCount: 0,
      skippedLines: [],
    });
  });
});

describe("rosterNameKey", () => {
  it("ignores case, spacing and Vietnamese accents", () => {
    expect(rosterNameKey("  Nguyễn  Văn ")).toBe(rosterNameKey("nguyen van"));
  });
});

function player(
  entryId: string,
  name: string,
  isClaimed = false,
): ExistingRosterEntry {
  return { entryId, name, guestOfEntryId: null, isClaimed };
}

describe("compareRosterPaste", () => {
  it("adds everyone the first time, linking guests to their player", () => {
    const comparison = compareRosterPaste(
      [],
      readPastedRoster(RECLUB_TEXT).names,
    );
    expect(comparison.missingEntryIds).toEqual([]);
    expect(comparison.additions).toHaveLength(7);
    const duy = comparison.additions.find(
      (addition) => addition.kind === "player" && addition.name === "Duy Ha",
    )!;
    expect(comparison.additions).toContainEqual({
      kind: "guest",
      key: expect.any(Number),
      guestOf: { newKey: duy.key },
      guestOfName: "Duy Ha",
    });
  });

  it("adds nothing when the same list is pasted again", () => {
    const existing: ExistingRosterEntry[] = [
      player("an", "An Vo", true),
      player("duy", "Duy Ha"),
      {
        entryId: "duy-guest",
        name: null,
        guestOfEntryId: "duy",
        isClaimed: false,
      },
      player("minh-1", "Minh Nguyen"),
      player("minh-2", "Minh Nguyen"),
      player("sunny", "Sunny"),
      player("chi", "Chi Lam"),
    ];
    expect(
      compareRosterPaste(existing, readPastedRoster(RECLUB_TEXT).names),
    ).toEqual({ additions: [], missingEntryIds: [] });
  });

  it("adds a second person of the same name and a new guest for an existing player", () => {
    const comparison = compareRosterPaste(
      [player("an", "An Vo"), player("lan", "Lan Dinh")],
      readPastedRoster("An Vo (+1)\nAn Vo\nLan Dinh").names,
    );
    expect(comparison.additions).toEqual([
      { kind: "player", key: 0, name: "An Vo" },
      {
        kind: "guest",
        key: 1,
        guestOf: { existingEntryId: "an" },
        guestOfName: "An Vo",
      },
    ]);
  });

  it("lists names missing from the new paste, keeping a claimed twin over an unclaimed one", () => {
    const comparison = compareRosterPaste(
      [
        player("minh-1", "Minh Nguyen"),
        player("minh-2", "Minh Nguyen", true),
        player("oscar", "Oscar Bell"),
      ],
      readPastedRoster("Minh Nguyen").names,
    );
    expect(comparison).toEqual({
      additions: [],
      missingEntryIds: ["minh-1", "oscar"],
    });
  });
});
