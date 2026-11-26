import { z } from "zod";
import {
  rosterLabelFromRpc,
  rosterLabelRpcShape,
  type RosterLabel,
} from "./rosterLabels";
import type { ExistingRosterEntry } from "./rosterText";

// The host's view of the roster (list_roster_for_open_session), parsed at the
// boundary. Pure, so the page and tests can use it.

const hostRosterRpcSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("no_open_session") }),
  z.object({
    status: z.literal("open"),
    session_id: z.uuid(),
    session_status: z.enum(["draft", "live"]),
    last_seq: z.number().int().nonnegative(),
    walk_ins_open: z.boolean(),
    entries: z.array(
      z.object({
        id: z.uuid(),
        guest_of_entry_id: z.uuid().nullable(),
        host_note: z.string().nullable(),
        claimed_at: z.string().nullable(),
        has_phone: z.boolean(),
        participant: z
          .object({
            id: z.uuid(),
            first_name: z.string(),
            last_name: z.string(),
          })
          .nullable(),
        ...rosterLabelRpcShape,
      }),
    ),
    transfer_requests: z.array(
      z.object({
        id: z.uuid(),
        roster_entry_id: z.uuid(),
        created_at: z.string(),
      }),
    ),
  }),
]);

export interface HostRosterEntry {
  rosterEntryId: string;
  label: RosterLabel;
  guestOfEntryId: string | null;
  hostNote: string | null;
  /** When they checked in (by phone or by a host); null until then. */
  claimedAt: string | null;
  /** False for someone a host checked in in person. */
  hasPhone: boolean;
  participant: {
    participantId: string;
    firstName: string;
    lastName: string;
  } | null;
}

export interface HostRosterTransferRequest {
  transferRequestId: string;
  rosterEntryId: string;
  createdAt: string;
}

export interface HostRoster {
  sessionId: string;
  sessionStatus: "draft" | "live";
  lastSeq: number;
  walkInsOpen: boolean;
  entries: HostRosterEntry[];
  transferRequests: HostRosterTransferRequest[];
}

/** Null when the social has no open session. Throws on anything unexpected. */
export function hostRosterFromRpc(rpcResult: unknown): HostRoster | null {
  const parsed = hostRosterRpcSchema.parse(rpcResult);
  if (parsed.status === "no_open_session") return null;
  return {
    sessionId: parsed.session_id,
    sessionStatus: parsed.session_status,
    lastSeq: parsed.last_seq,
    walkInsOpen: parsed.walk_ins_open,
    entries: parsed.entries.map((entry) => ({
      rosterEntryId: entry.id,
      label: rosterLabelFromRpc(entry),
      guestOfEntryId: entry.guest_of_entry_id,
      hostNote: entry.host_note,
      claimedAt: entry.claimed_at,
      hasPhone: entry.has_phone,
      participant: entry.participant && {
        participantId: entry.participant.id,
        firstName: entry.participant.first_name,
        lastName: entry.participant.last_name,
      },
    })),
    transferRequests: parsed.transfer_requests.map((request) => ({
      transferRequestId: request.id,
      rosterEntryId: request.roster_entry_id,
      createdAt: request.created_at,
    })),
  };
}

/** The roster as the paste comparison sees it. */
export function existingRosterEntries(
  roster: HostRoster,
): ExistingRosterEntry[] {
  return roster.entries.map((entry) => ({
    entryId: entry.rosterEntryId,
    name: entry.label.displayName,
    guestOfEntryId: entry.guestOfEntryId,
    isClaimed: entry.participant !== null,
  }));
}
