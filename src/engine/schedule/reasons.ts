// Host-readable reasons for a suggested group (plan §5.6): name the terms
// that contributed most, e.g. "All four on 2 games, 1.2 below fair share".
import type { GroupChoice } from "./groupSearch";
import type { ScoredPlayer } from "./priority";

const MINUTE_MS = 60_000;
const MAXIMUM_REASONS = 3;
const MAXIMUM_SCORED_REASONS = 2;
/** Fair-share gaps smaller than this are not worth mentioning. */
const NOTABLE_FAIR_SHARE_GAP = 0.1;

function groupLabel(size: number): string {
  if (size === 2) return "Both";
  if (size === 4) return "All four";
  return `All ${size}`;
}

/** "4 min" or "4–8 min"; `approximate` marks forecast figures with "~" (they are estimates). */
function rangeText(
  values: number[],
  unit: string,
  approximate = false,
): string {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const prefix = approximate ? "~" : "";
  return low === high
    ? `${prefix}${low} ${unit}`
    : `${prefix}${low}–${high} ${unit}`;
}

function minutes(slots: number, slotMs: number): number {
  return Math.round((slots * slotMs) / MINUTE_MS);
}

function sumOfTerms(
  members: readonly ScoredPlayer[],
  pick: (member: ScoredPlayer) => number,
): number {
  return members.reduce((total, member) => total + pick(member), 0);
}

function gamesReason(
  members: readonly ScoredPlayer[],
  isForecast: boolean,
): string {
  const games = members.map((member) => member.snapshot.gamesCompleted);
  const gamesText =
    Math.min(...games) === Math.max(...games)
      ? `${groupLabel(members.length)} on ${rangeText(games, games[0] === 1 ? "game" : "games", isForecast)}`
      : `On ${rangeText(games, "games", isForecast)}`;
  const meanGap =
    sumOfTerms(members, (member) => member.measurements.gameDeficit) /
    members.length;
  return meanGap >= NOTABLE_FAIR_SHARE_GAP
    ? `${gamesText}, ${isForecast ? "~" : ""}${meanGap.toFixed(1)} below fair share`
    : gamesText;
}

function waitReason(
  members: readonly ScoredPlayer[],
  slotMs: number,
  isForecast: boolean,
): string {
  const waits = members.map((member) =>
    minutes(member.measurements.currentWaitSlots, slotMs),
  );
  return `Waiting ${rangeText(waits, "min", isForecast)}`;
}

function courtTimeReason(
  members: readonly ScoredPlayer[],
  slotMs: number,
  isForecast: boolean,
): string {
  const meanBehindMinutes = minutes(
    sumOfTerms(members, (member) => member.measurements.playDeficit) /
      members.length,
    slotMs,
  );
  const prefix = isForecast ? "~" : "";
  return meanBehindMinutes > 0
    ? `${prefix}${meanBehindMinutes} min less court time than fair share`
    : "Court time at fair share";
}

function restReason(
  members: readonly ScoredPlayer[],
  slotMs: number,
  isForecast: boolean,
): string {
  const backToBackCount = members.filter(
    (member) => member.measurements.justCameOff,
  ).length;
  if (backToBackCount > 0) {
    // Neutral wording: they may be here because they are behind or locked,
    // not only because rested players ran out.
    return `${backToBackCount} playing back-to-back`;
  }
  const rests = members
    .map((member) => member.snapshot.restSlots)
    .filter((rest): rest is number => rest !== null);
  if (rests.length === 0) {
    return `First game for ${groupLabel(members.length).toLowerCase()}`;
  }
  const restText = `Rested ${rangeText(
    rests.map((rest) => minutes(rest, slotMs)),
    "min",
    isForecast,
  )}, no back-to-back`;
  const firstGameCount = members.length - rests.length;
  return firstGameCount === 0
    ? restText
    : `${restText}, ${firstGameCount} first game`;
}

/**
 * Up to three reasons, strongest first. `lockedCount` is how many members
 * the host locked into this group; forecast figures are marked "~".
 */
export function explainGroup(
  choice: GroupChoice,
  lockedCount: number,
  slotMs: number,
  { isForecast }: { isForecast: boolean },
): string[] {
  const { members, split } = choice;
  const hostReasons: string[] = [];
  if (lockedCount > 0) hostReasons.push(`${lockedCount} locked by host`);
  const movedUpCount = members.filter(
    (member) => member.terms.hostOverride > 0,
  ).length;
  if (movedUpCount > 0) hostReasons.push(`${movedUpCount} moved up by host`);

  const scoredReasons = [
    {
      strength: sumOfTerms(
        members,
        (member) => member.terms.fairShare + member.terms.rawGames,
      ),
      text: gamesReason(members, isForecast),
    },
    {
      strength: sumOfTerms(members, (member) => member.terms.currentWait),
      text: waitReason(members, slotMs, isForecast),
    },
    {
      strength: sumOfTerms(members, (member) => member.terms.playingTime),
      text: courtTimeReason(members, slotMs, isForecast),
    },
    {
      strength: sumOfTerms(
        members,
        (member) =>
          member.terms.rest +
          member.terms.recentGames +
          member.terms.consecutive,
      ),
      text: restReason(members, slotMs, isForecast),
    },
  ]
    .sort((left, right) => right.strength - left.strength)
    // The strongest reason always shows; a second only if it also helped.
    .filter((reason, index) => index === 0 || reason.strength > 0)
    .slice(0, MAXIMUM_SCORED_REASONS)
    .map((reason) => reason.text);

  const mixReasons: string[] = [];
  const hasPairHistory = members.some(
    (member) => Object.keys(member.snapshot.player.partnerCounts).length > 0,
  );
  if (hasPairHistory && split.repeatPartners === 0) {
    mixReasons.push("No repeat partners");
  }
  const hasKnownSkill = members.some(
    (member) => member.snapshot.player.skill !== null,
  );
  if (hasKnownSkill && split.skillImbalance === 0) {
    mixReasons.push("Balanced teams");
  }

  return [...hostReasons, ...scoredReasons, ...mixReasons].slice(
    0,
    MAXIMUM_REASONS,
  );
}
