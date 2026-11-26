import { z } from "zod";

// How a roster entry is named on screen (pure; host and player pages).
// Same-name players are numbered, "Minh Nguyen (1)"; a guest is "Guest of
// <player>", numbered when one player brings several.

export const rosterLabelRpcShape = {
  display_name: z.string().nullable(),
  guest_of_name: z.string().nullable(),
  twin_number: z.number().int().positive(),
  twin_count: z.number().int().positive(),
  guest_number: z.number().int().positive().nullable(),
  guest_count: z.number().int().positive().nullable(),
};

export interface RosterLabel {
  /** Null for a guest. */
  displayName: string | null;
  /** The player who brought this guest. */
  guestOfName: string | null;
  /** Of the player (or the guest's player) among same-name entries. */
  twinNumber: number;
  twinCount: number;
  guestNumber: number | null;
  guestCount: number | null;
}

export function rosterLabelFromRpc(row: {
  display_name: string | null;
  guest_of_name: string | null;
  twin_number: number;
  twin_count: number;
  guest_number: number | null;
  guest_count: number | null;
}): RosterLabel {
  return {
    displayName: row.display_name,
    guestOfName: row.guest_of_name,
    twinNumber: row.twin_number,
    twinCount: row.twin_count,
    guestNumber: row.guest_number,
    guestCount: row.guest_count,
  };
}

/** "Minh Nguyen (2)", "Guest of Duy Ha", "Guest of Duy Ha (2)". */
export function rosterLabelText(
  label: RosterLabel,
  guestOf: (playerName: string) => string,
): string {
  const playerName = (name: string) =>
    label.twinCount > 1 ? `${name} (${label.twinNumber})` : name;
  if (label.displayName !== null) return playerName(label.displayName);
  const guest = guestOf(playerName(label.guestOfName ?? ""));
  return (label.guestCount ?? 1) > 1
    ? `${guest} (${label.guestNumber})`
    : guest;
}
