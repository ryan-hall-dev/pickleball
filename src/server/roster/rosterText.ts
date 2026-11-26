// Reading a pasted Reclub list (docs/plans/reclub-to-court-v1.md, Phase 1).
// Pure: used by the host's preview in the browser and again on the server,
// which never trusts the browser's reading.
//
// Reclub's text block has a title, date and venue lines, then
// `Confirmed (10/16)` with numbered `N. Name` lines, then `Waitlist (3)`.
// Only the Confirmed names are read. `(+1)` adds a guest of that player and
// `(Host)` is dropped from the name. A plain list of names also works.

/** Longest roster name: the same limit as a person's name. */
export const ROSTER_NAME_MAX_LENGTH = 50;
/** Most guests one line can bring (`(+3)`). */
export const ROSTER_MAX_GUESTS_PER_LINE = 3;
/** Most names one paste can add. */
export const ROSTER_MAX_ENTRIES = 200;

export type PastedRosterName = {
  /** Whitespace collapsed, numbering and known tags removed. */
  name: string;
  /** Guests this player brings (`(+N)`). */
  guestCount: number;
};

export type PastedRoster = {
  names: PastedRosterName[];
  /** Waitlist lines left out. */
  waitlistCount: number;
  /** Lines that couldn't be a name (too long): shown so the host can see them. */
  skippedLines: string[];
};

const CONFIRMED_HEADING = /^(confirmed|đã xác nhận)\b.*$/i;
const WAITLIST_HEADING =
  /^(waitlist|wait list|waiting list|danh sách chờ)\b.*$/i;
const LINE_NUMBER = /^\s*(?:\d+\s*[.)]|[-•*])\s*/;
const GUEST_TAG = /\(\s*\+\s*(\d+)\s*\)/g;
const HOST_TAG = /\(\s*host\s*\)/gi;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** Collapses spaces; the same rule as person names. */
export function tidyRosterName(name: string): string {
  return name.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

/** How two roster names are compared, the same as the database's
 * normalise_name_for_search: case and accents don't matter (đ stays đ). */
export function rosterNameKey(name: string): string {
  return tidyRosterName(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isCountedHeading(line: string): boolean {
  // "Confirmed (10/16)", "Going (8)": a heading line, never a name.
  return /\(\s*\d+\s*(\/\s*\d+\s*)?\)\s*:?$/.test(line);
}

function readNameLine(line: string): PastedRosterName | "skip" | null {
  let text = line.replace(LINE_NUMBER, "");
  let guestCount = 0;
  text = text.replace(GUEST_TAG, (_match, count: string) => {
    guestCount += Number(count);
    return " ";
  });
  text = tidyRosterName(text.replace(HOST_TAG, " "));
  if (text === "") return null;
  if (text.length > ROSTER_NAME_MAX_LENGTH) return "skip";
  return {
    name: text,
    guestCount: Math.min(guestCount, ROSTER_MAX_GUESTS_PER_LINE),
  };
}

/** Reads the pasted text. Never throws; an empty paste gives no names. */
export function readPastedRoster(text: string): PastedRoster {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const confirmedAt = lines.findIndex((line) => CONFIRMED_HEADING.test(line));
  const names: PastedRosterName[] = [];
  const skippedLines: string[] = [];
  let waitlistCount = 0;
  let isInWaitlist = false;
  // With a Confirmed heading, everything above it (title, date, venue) is
  // left out. Without one, it's a plain list of names.
  for (const line of lines.slice(confirmedAt + 1)) {
    if (line === "") continue;
    if (WAITLIST_HEADING.test(line)) {
      isInWaitlist = true;
      continue;
    }
    if (isInWaitlist) {
      if (LINE_NUMBER.test(line)) waitlistCount += 1;
      continue;
    }
    if (isCountedHeading(line) || CONFIRMED_HEADING.test(line)) continue;
    const name = readNameLine(line);
    if (name === "skip") skippedLines.push(line);
    else if (name) names.push(name);
  }
  return {
    names: names.slice(0, ROSTER_MAX_ENTRIES),
    waitlistCount,
    skippedLines,
  };
}

/** One roster entry as the host's preview and the import compare it. */
export type ExistingRosterEntry = {
  entryId: string;
  /** Null for a guest entry. */
  name: string | null;
  /** The player who brought this guest. */
  guestOfEntryId: string | null;
  isClaimed: boolean;
};

/** A name to add; a guest names the entry (old or new) that brought them. */
export type RosterAddition =
  | { kind: "player"; key: number; name: string }
  | {
      kind: "guest";
      key: number;
      guestOf: { existingEntryId: string } | { newKey: number };
      /** The player's name, for the preview. */
      guestOfName: string;
    };

export type RosterComparison = {
  additions: RosterAddition[];
  /** Entries no longer on the paste (players and guests), oldest first. */
  missingEntryIds: string[];
};

/**
 * Compares a paste with what's already imported. Names are counted, so a
 * name pasted twice is two people: pasting the same list again adds nothing,
 * and a second "Minh Nguyen" adds one. Nobody is ever removed here; entries
 * missing from the paste are only listed (unclaimed ones first chosen).
 */
export function compareRosterPaste(
  existing: readonly ExistingRosterEntry[],
  pasted: readonly PastedRosterName[],
): RosterComparison {
  const existingPlayersByKey = new Map<string, ExistingRosterEntry[]>();
  const guestsByPlayerId = new Map<string, ExistingRosterEntry[]>();
  for (const entry of existing) {
    if (entry.guestOfEntryId !== null) {
      const guests = guestsByPlayerId.get(entry.guestOfEntryId) ?? [];
      guests.push(entry);
      guestsByPlayerId.set(entry.guestOfEntryId, guests);
    } else if (entry.name !== null) {
      const key = rosterNameKey(entry.name);
      const players = existingPlayersByKey.get(key) ?? [];
      players.push(entry);
      existingPlayersByKey.set(key, players);
    }
  }

  const additions: RosterAddition[] = [];
  const matchedEntryIds = new Set<string>();
  let nextKey = 0;
  const pastedByKey = new Map<string, PastedRosterName[]>();
  for (const line of pasted) {
    const key = rosterNameKey(line.name);
    pastedByKey.set(key, [...(pastedByKey.get(key) ?? []), line]);
  }

  for (const [key, lines] of pastedByKey) {
    // Claimed entries are matched first, so a missing one is never someone
    // already here.
    const players = [...(existingPlayersByKey.get(key) ?? [])].sort(
      (left, right) => Number(right.isClaimed) - Number(left.isClaimed),
    );
    // Guests are counted per name: whoever of that name brought them.
    const existingGuests = players
      .flatMap((player) => guestsByPlayerId.get(player.entryId) ?? [])
      .sort((left, right) => Number(right.isClaimed) - Number(left.isClaimed));
    let pastedGuestCount = 0;
    // Who each pasted line is, for linking its guests.
    const guestOfForLine: ({ existingEntryId: string } | { newKey: number })[] =
      [];
    lines.forEach((line, index) => {
      pastedGuestCount += line.guestCount;
      const player = players[index];
      if (player) {
        matchedEntryIds.add(player.entryId);
        guestOfForLine.push({ existingEntryId: player.entryId });
        return;
      }
      const newKey = nextKey++;
      additions.push({ kind: "player", key: newKey, name: line.name });
      guestOfForLine.push({ newKey });
    });
    existingGuests
      .slice(0, pastedGuestCount)
      .forEach((guest) => matchedEntryIds.add(guest.entryId));
    // New guests go with the first line of this name that brought any.
    const guestHostLine = Math.max(
      0,
      lines.findIndex((line) => line.guestCount > 0),
    );
    for (
      let guestIndex = existingGuests.length;
      guestIndex < pastedGuestCount;
      guestIndex++
    ) {
      additions.push({
        kind: "guest",
        key: nextKey++,
        guestOf: guestOfForLine[guestHostLine]!,
        guestOfName: lines[guestHostLine]!.name,
      });
    }
  }

  const missingEntryIds = existing
    .filter((entry) => !matchedEntryIds.has(entry.entryId))
    .map((entry) => entry.entryId);
  return { additions, missingEntryIds };
}
