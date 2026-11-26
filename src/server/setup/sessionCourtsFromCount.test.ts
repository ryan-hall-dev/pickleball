import { describe, expect, it, vi } from "vitest";
import type { CourtConfig } from "@/engine/session/types";
import { sessionCourtsFromCount } from "./sessionCourtsFromCount";

function courtId(index: number): string {
  return `c0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function court(index: number): CourtConfig {
  return { courtId: courtId(index), name: "Old name", format: "singles" };
}

describe("sessionCourtsFromCount", () => {
  it.each([1, 4, 50, 1000])("creates %i numbered doubles courts", (count) => {
    let nextId = 0;
    const createId = vi.fn(() => courtId(++nextId));
    const result = sessionCourtsFromCount([], count, createId);
    expect(result).toEqual(
      Array.from({ length: count }, (_, index) => ({
        courtId: courtId(index + 1),
        name: `Court ${index + 1}`,
        format: "doubles",
      })),
    );
    expect(createId).toHaveBeenCalledTimes(count);
  });

  it("retains IDs without calling the factory when the count is unchanged", () => {
    const createId = vi.fn();
    expect(sessionCourtsFromCount([court(1), court(2)], 2, createId)).toEqual([
      { courtId: courtId(1), name: "Court 1", format: "doubles" },
      { courtId: courtId(2), name: "Court 2", format: "doubles" },
    ]);
    expect(createId).not.toHaveBeenCalled();
  });

  it("appends IDs on growth and replaces dropped IDs on regrowth", () => {
    const createId = vi
      .fn()
      .mockReturnValueOnce(courtId(3))
      .mockReturnValueOnce(courtId(4));
    const grown = sessionCourtsFromCount([court(1), court(2)], 3, createId);
    expect(grown.map((entry) => entry.courtId)).toEqual([
      courtId(1),
      courtId(2),
      courtId(3),
    ]);
    const shrunk = sessionCourtsFromCount(grown, 2, createId);
    expect(shrunk).toEqual(grown.slice(0, 2));
    expect(createId).toHaveBeenCalledTimes(1);
    const regrown = sessionCourtsFromCount(shrunk, 3, createId);
    expect(regrown.map((entry) => entry.courtId)).toEqual([
      courtId(1),
      courtId(2),
      courtId(4),
    ]);
    expect(createId).toHaveBeenCalledTimes(2);
  });

  it("does not mutate or share input objects", () => {
    const original = Object.freeze([
      Object.freeze(court(1)),
      Object.freeze(court(2)),
    ]);
    const result = sessionCourtsFromCount(original, 1, vi.fn());
    result[0].name = "Changed";
    expect(original).toEqual([court(1), court(2)]);
    expect(result).not.toBe(original);
  });

  it.each([0, -1, 1.5, 1001, NaN, Infinity, -Infinity])(
    "rejects invalid count %s before generating IDs",
    (count) => {
      const createId = vi.fn();
      expect(() => sessionCourtsFromCount([], count, createId)).toThrow(
        /Court count/,
      );
      expect(createId).not.toHaveBeenCalled();
    },
  );

  it.each(["", "not-a-uuid", "c0000000-0000-4000-8000-00000000000z"])(
    "rejects malformed retained and generated UUID %s",
    (invalidId) => {
      expect(() =>
        sessionCourtsFromCount(
          [{ ...court(1), courtId: invalidId }],
          1,
          vi.fn(),
        ),
      ).toThrow(/valid UUIDs/);
      expect(() => sessionCourtsFromCount([], 1, () => invalidId)).toThrow(
        /valid UUIDs/,
      );
    },
  );

  it("rejects duplicate retained IDs case-insensitively", () => {
    expect(() =>
      sessionCourtsFromCount(
        [court(1), { ...court(1), courtId: courtId(1).toUpperCase() }],
        2,
        vi.fn(),
      ),
    ).toThrow(/unique/);
  });

  it("rejects generated IDs duplicating retained or generated IDs", () => {
    expect(() =>
      sessionCourtsFromCount([court(1)], 2, () => courtId(1).toUpperCase()),
    ).toThrow(/unique/);
    expect(() => sessionCourtsFromCount([], 2, () => courtId(1))).toThrow(
      /unique/,
    );
  });

  it("ignores malformed and duplicate trailing entries when shrinking", () => {
    expect(
      sessionCourtsFromCount(
        [court(1), court(1), { ...court(2), courtId: "invalid" }],
        1,
        vi.fn(),
      ),
    ).toEqual([{ courtId: courtId(1), name: "Court 1", format: "doubles" }]);
  });
});

it("uses the host's court names and numbers the rest", () => {
  let next = 0;
  const createId = () =>
    `00000000-0000-4000-8000-${String((next += 1)).padStart(12, "0")}`;
  expect(
    sessionCourtsFromCount([], 3, createId, ["Court 7", "Show"]).map(
      (court) => court.name,
    ),
  ).toEqual(["Court 7", "Show", "Court 3"]);
});
