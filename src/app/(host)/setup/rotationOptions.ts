// Copy and pure helpers for the Rotation card (plan §5.3). The host ranks the
// engine's six objectives and switches its rules; rank scales each
// objective's weights, so nothing is ignored. No React here.
import type {
  RotationObjective,
  RotationPreferences,
  RotationRules,
} from "@/engine";
import { recommendedRotationPreferences } from "@/server/setup/setupRules";

interface ObjectiveCopy {
  label: string;
  /** For "<short label> first" in the summary and the reuse banner. */
  shortLabel: string;
  hint: string;
}

/** Plain-language copy: what each priority changes, without the maths (Ryan, 2026-11-09). */
export const ROTATION_OBJECTIVE_COPY: Readonly<
  Record<RotationObjective, ObjectiveCopy>
> = {
  equalGames: {
    label: "Equal games for everyone",
    shortLabel: "Equal games",
    hint: "Everyone gets a similar number of games for the time they've been here",
  },
  shortestWaits: {
    label: "Shortest waits",
    shortLabel: "Shortest waits",
    hint: "Nobody sits out for too long in a row",
  },
  playingTime: {
    label: "Playing time",
    shortLabel: "Playing time",
    hint: "Court minutes stay fair, even when some games run long",
  },
  fullCourts: {
    label: "Full courts",
    shortLabel: "Full courts",
    hint: "Fill every court whenever enough players are free",
  },
  noBackToBack: {
    label: "No back-to-back games",
    shortLabel: "No back-to-back",
    hint: "Players get a rest between games",
  },
  mixPartners: {
    label: "Mix up partners",
    shortLabel: "Mixed partners",
    hint: "Players team up with and face different people",
  },
};

interface RuleCopy {
  ruleKey: keyof RotationRules;
  label: string;
  hint: string;
}

/**
 * The rule switches, in display order. Labels differ from the priorities,
 * and each hint says what switching the rule OFF does (Ryan, 2026-11-09).
 */
export const ROTATION_RULE_COPY: readonly RuleCopy[] = [
  {
    ruleKey: "preventConsecutive",
    label: "Avoid back-to-back games",
    hint: "Off: players can be picked straight after a game",
  },
  {
    ruleKey: "fewerGamesFirst",
    label: "Favour players with fewer games",
    hint: "Off: game counts don't raise priority",
  },
  {
    ruleKey: "longestWaitFirst",
    label: "Favour longer waits",
    hint: "Off: waiting time doesn't raise priority",
  },
  {
    ruleKey: "mixPartners",
    label: "Rotate partners",
    hint: "Off: the same pairs can repeat",
  },
  {
    ruleKey: "minimiseRepeatOpponents",
    label: "Rotate opponents",
    hint: "Off: the same opponents can repeat",
  },
  {
    ruleKey: "allowManualAssignments",
    label: "Allow manual assignments",
    hint: "You can lock or swap players on the live screen. Suggestions stay fair for everyone else.",
  },
];

/** "Equal games first" (summary row, reuse banner). */
export function topObjectiveSummary(rotation: RotationPreferences): string {
  const topObjective = rotation.objectiveOrder[0];
  return `${ROTATION_OBJECTIVE_COPY[topObjective].shortLabel} first`;
}

/** The order with the item at `fromIndex` moved to `toIndex` (a new array). */
export function moveObjective(
  objectiveOrder: readonly RotationObjective[],
  fromIndex: number,
  toIndex: number,
): RotationObjective[] {
  const lastIndex = objectiveOrder.length - 1;
  if (
    fromIndex < 0 ||
    fromIndex > lastIndex ||
    toIndex < 0 ||
    toIndex > lastIndex
  ) {
    throw new RangeError(
      `Can't move rotation priority ${fromIndex} to ${toIndex} in a list of ${objectiveOrder.length}.`,
    );
  }
  const reordered = [...objectiveOrder];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  return reordered;
}

export function isRecommendedRotation(rotation: RotationPreferences): boolean {
  const recommended = recommendedRotationPreferences();
  return (
    rotation.objectiveOrder.every(
      (objective, index) => objective === recommended.objectiveOrder[index],
    ) &&
    ROTATION_RULE_COPY.every(
      ({ ruleKey }) => rotation.rules[ruleKey] === recommended.rules[ruleKey],
    )
  );
}
