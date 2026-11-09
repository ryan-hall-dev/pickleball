// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  recommendedRotationPreferences,
  ROTATION_OBJECTIVES,
} from "@/server/setup/setupRules";
import {
  isRecommendedRotation,
  moveObjective,
  ROTATION_OBJECTIVE_COPY,
  ROTATION_RULE_COPY,
  topObjectiveSummary,
} from "./rotationOptions";

const order = recommendedRotationPreferences().objectiveOrder;

describe("moveObjective", () => {
  it("moves a priority up or down by one", () => {
    expect(moveObjective(order, 1, 0)).toEqual([
      "shortestWaits",
      "equalGames",
      "playingTime",
      "fullCourts",
      "noBackToBack",
      "mixPartners",
    ]);
    expect(moveObjective(order, 4, 5)).toEqual([
      "equalGames",
      "shortestWaits",
      "playingTime",
      "fullCourts",
      "mixPartners",
      "noBackToBack",
    ]);
  });

  it("moves a dragged priority across several places", () => {
    expect(moveObjective(order, 5, 0)).toEqual([
      "mixPartners",
      "equalGames",
      "shortestWaits",
      "playingTime",
      "fullCourts",
      "noBackToBack",
    ]);
    expect(moveObjective(order, 0, 3)).toEqual([
      "shortestWaits",
      "playingTime",
      "fullCourts",
      "equalGames",
      "noBackToBack",
      "mixPartners",
    ]);
  });

  it("returns a new array and leaves the input alone", () => {
    const before = [...order];
    const moved = moveObjective(order, 0, 1);
    expect(moved).not.toBe(order);
    expect(order).toEqual(before);
    expect(moveObjective(order, 2, 2)).toEqual(order);
  });

  it("refuses moves past either end", () => {
    expect(() => moveObjective(order, 0, -1)).toThrow(RangeError);
    expect(() => moveObjective(order, 5, 6)).toThrow(RangeError);
    expect(() => moveObjective(order, 6, 0)).toThrow(RangeError);
  });
});

describe("rotation copy", () => {
  it("labels every engine objective and every rule", () => {
    expect(Object.keys(ROTATION_OBJECTIVE_COPY).sort()).toEqual(
      [...ROTATION_OBJECTIVES].sort(),
    );
    expect(ROTATION_RULE_COPY.map((rule) => rule.ruleKey).sort()).toEqual(
      Object.keys(recommendedRotationPreferences().rules).sort(),
    );
  });

  it("never gives a rule the same label as a priority", () => {
    const priorityLabels = Object.values(ROTATION_OBJECTIVE_COPY).map(
      (copy) => copy.label,
    );
    for (const rule of ROTATION_RULE_COPY) {
      expect(priorityLabels).not.toContain(rule.label);
    }
  });

  it("summarises the top priority", () => {
    expect(topObjectiveSummary(recommendedRotationPreferences())).toBe(
      "Equal games first",
    );
    expect(
      topObjectiveSummary({
        ...recommendedRotationPreferences(),
        objectiveOrder: moveObjective(order, 4, 0),
      }),
    ).toBe("No back-to-back first");
  });
});

describe("isRecommendedRotation", () => {
  it("is true only for the recommended order with every rule on", () => {
    const recommended = recommendedRotationPreferences();
    expect(isRecommendedRotation(recommended)).toBe(true);
    expect(
      isRecommendedRotation({
        ...recommended,
        objectiveOrder: moveObjective(order, 0, 1),
      }),
    ).toBe(false);
    expect(
      isRecommendedRotation({
        ...recommended,
        rules: { ...recommended.rules, allowManualAssignments: false },
      }),
    ).toBe(false);
  });
});
