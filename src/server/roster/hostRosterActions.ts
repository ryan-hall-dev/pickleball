"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { applyEvent, replay } from "@/engine/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import {
  HOST_ACCESS_DENIAL_MESSAGES,
  type SignedInHost,
} from "@/server/auth/hostAccess";
import { checkinDatabaseTimeoutSignal } from "@/server/checkin/checkinPage";
import { genderSchema, personNameSchema } from "@/server/participantRules";
import { loadSessionLog } from "@/server/sessionLog";
import { SKILL_LEVELS } from "@/server/skillLevels";
import { en } from "@/i18n/messages/en";
import {
  existingRosterEntries,
  hostRosterFromRpc,
  type HostRoster,
} from "./hostRosterResults";
import { compareRosterPaste, readPastedRoster } from "./rosterText";

// The host's roster actions (Arrivals page; docs/plans/reclub-to-court-v1.md).
// Each verifies the host with getUser() first, then calls a service_role
// function with p_actor_user_id; the function derives the social from the
// actor (decision 0002), so another social's session is "not found".

const text = en.serverMessages.roster;

export type ReadHostRosterResult =
  { ok: true; roster: HostRoster | null } | { ok: false; message: string };

export type RosterWriteResult =
  | { ok: true; added?: number }
  | { ok: false; message: string; isConflict?: true };

type Authorized = { ok: true; host: SignedInHost } | RosterWriteFailure;
type RosterWriteFailure = { ok: false; message: string; isConflict?: true };

async function authorize(): Promise<Authorized> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  return { ok: true, host: authorization.host };
}

function logRosterFailure(label: string, host: SignedInHost, error: unknown) {
  console.error(label, {
    actorUserId: host.userId,
    cause: error instanceof Error ? error.message : String(error),
  });
}

/** Database refusals the host can act on; anything else is a bug (thrown). */
function refusalFromError(error: { message: string }): RosterWriteFailure {
  switch (error.message) {
    case "ROSTER_CHANGED":
      return { ok: false, message: text.listChanged, isConflict: true };
    case "STALE_EXPECTED_SEQ":
      return { ok: false, message: text.sessionChanged, isConflict: true };
    case "ROSTER_ENTRY_CHECKED_IN":
      return { ok: false, message: text.alreadyCheckedIn, isConflict: true };
    case "PHONE_HAS_OTHER_NAME":
      return { ok: false, message: text.phoneHasOtherName, isConflict: true };
    case "SESSION_CLOSED":
    case "SESSION_NOT_FOUND":
    case "ROSTER_ENTRY_NOT_FOUND":
    case "TRANSFER_REQUEST_NOT_FOUND":
      return { ok: false, message: text.sessionClosed, isConflict: true };
  }
  throw new Error(error.message);
}

async function readRoster(host: SignedInHost): Promise<HostRoster | null> {
  const { data, error } = await createSupabaseAdminClient()
    .rpc("list_roster_for_open_session", { p_actor_user_id: host.userId })
    .abortSignal(checkinDatabaseTimeoutSignal());
  if (error) throw new Error(`list_roster_for_open_session: ${error.message}`);
  return hostRosterFromRpc(data);
}

/** The open session's roster and "That's my name" requests (polled). */
export async function readHostRoster(): Promise<ReadHostRosterResult> {
  const authorized = await authorize();
  if (!authorized.ok) return authorized;
  try {
    return { ok: true, roster: await readRoster(authorized.host) };
  } catch (error) {
    logRosterFailure("Reading the roster failed", authorized.host, error);
    return { ok: false, message: text.couldNotSave };
  }
}

/** Runs one roster write; database refusals become messages. */
async function writeRoster(
  label: string,
  write: (host: SignedInHost) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>,
): Promise<RosterWriteResult> {
  const authorized = await authorize();
  if (!authorized.ok) return authorized;
  try {
    const { error } = await write(authorized.host);
    if (error) return refusalFromError(error);
    return { ok: true };
  } catch (error) {
    logRosterFailure(label, authorized.host, error);
    return { ok: false, message: text.couldNotSave };
  }
}

const importInputSchema = z.object({
  sessionId: z.uuid(),
  pastedText: z.string().max(50_000),
  expectedEntryCount: z.number().int().nonnegative(),
});

/**
 * Adds the paste's new names. The server reads the paste itself and compares
 * it with the stored roster (the browser's preview is only a preview); the
 * expected count stops two hosts adding the same names at once.
 */
export async function importRosterPaste(
  input: unknown,
): Promise<RosterWriteResult> {
  const authorized = await authorize();
  if (!authorized.ok) return authorized;
  const parsed = importInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: text.noNames };
  const { host } = authorized;
  try {
    const roster = await readRoster(host);
    if (!roster || roster.sessionId !== parsed.data.sessionId)
      return { ok: false, message: text.sessionClosed, isConflict: true };
    if (roster.entries.length !== parsed.data.expectedEntryCount)
      return { ok: false, message: text.listChanged, isConflict: true };
    const pasted = readPastedRoster(parsed.data.pastedText);
    if (pasted.names.length === 0) return { ok: false, message: text.noNames };
    const { additions } = compareRosterPaste(
      existingRosterEntries(roster),
      pasted.names,
    );
    if (additions.length === 0)
      return { ok: false, message: text.nothingToAdd };
    const idsByKey = new Map(additions.map((add) => [add.key, randomUUID()]));
    const entries = additions.map((addition) =>
      addition.kind === "player"
        ? { id: idsByKey.get(addition.key), displayName: addition.name }
        : {
            id: idsByKey.get(addition.key),
            guestOfEntryId:
              "existingEntryId" in addition.guestOf
                ? addition.guestOf.existingEntryId
                : idsByKey.get(addition.guestOf.newKey),
          },
    );
    const { error } = await createSupabaseAdminClient()
      .rpc("import_roster_entries", {
        p_actor_user_id: host.userId,
        p_session_id: parsed.data.sessionId,
        p_expected_entry_count: parsed.data.expectedEntryCount,
        p_entries: entries,
      })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) return refusalFromError(error);
    return { ok: true, added: entries.length };
  } catch (error) {
    logRosterFailure("Importing the roster failed", host, error);
    return { ok: false, message: text.couldNotSave };
  }
}

const entryInputSchema = z.object({
  sessionId: z.uuid(),
  rosterEntryId: z.uuid(),
});

/** Takes a name nobody has checked in as off the list. */
export async function removeRosterEntry(
  input: unknown,
): Promise<RosterWriteResult> {
  const parsed = entryInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: text.couldNotSave };
  return writeRoster("Removing a roster name failed", (host) =>
    createSupabaseAdminClient()
      .rpc("remove_roster_entry", {
        p_actor_user_id: host.userId,
        p_session_id: parsed.data.sessionId,
        p_roster_entry_id: parsed.data.rosterEntryId,
      })
      .abortSignal(checkinDatabaseTimeoutSignal()),
  );
}

const noteInputSchema = entryInputSchema.extend({
  hostNote: z
    .string()
    .transform((note) => note.replace(/\s+/g, " ").trim())
    .pipe(z.string().max(40)),
});

/** Sets (or clears, when empty) the note telling same-name people apart. */
export async function setRosterEntryNote(
  input: unknown,
): Promise<RosterWriteResult> {
  const parsed = noteInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: text.couldNotSave };
  return writeRoster("Saving a roster note failed", (host) =>
    createSupabaseAdminClient()
      .rpc("set_roster_entry_note", {
        p_actor_user_id: host.userId,
        p_session_id: parsed.data.sessionId,
        p_roster_entry_id: parsed.data.rosterEntryId,
        p_host_note: parsed.data.hostNote,
      })
      .abortSignal(checkinDatabaseTimeoutSignal()),
  );
}

const walkInsInputSchema = z.object({
  sessionId: z.uuid(),
  walkInsOpen: z.boolean(),
});

export async function setWalkInsOpen(
  input: unknown,
): Promise<RosterWriteResult> {
  const parsed = walkInsInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: text.couldNotSave };
  return writeRoster("Changing walk-ins failed", (host) =>
    createSupabaseAdminClient()
      .rpc("set_walk_ins_open", {
        p_actor_user_id: host.userId,
        p_session_id: parsed.data.sessionId,
        p_walk_ins_open: parsed.data.walkInsOpen,
      })
      .abortSignal(checkinDatabaseTimeoutSignal()),
  );
}

const transferInputSchema = z.object({
  transferRequestId: z.uuid(),
  shouldMove: z.boolean(),
});

/** "That's my name": move the name to the new phone, or keep it. */
export async function decideRosterTransfer(
  input: unknown,
): Promise<RosterWriteResult> {
  const parsed = transferInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: text.couldNotSave };
  return writeRoster("Deciding a name request failed", (host) =>
    createSupabaseAdminClient()
      .rpc("decide_roster_transfer", {
        p_actor_user_id: host.userId,
        p_transfer_request_id: parsed.data.transferRequestId,
        p_should_move: parsed.data.shouldMove,
      })
      .abortSignal(checkinDatabaseTimeoutSignal()),
  );
}

const hostCheckInInputSchema = z.object({
  sessionId: z.uuid(),
  rosterEntryId: z.uuid(),
  participantId: z.uuid(),
  eventId: z.uuid(),
  skillLevel: z.enum(SKILL_LEVELS),
  gender: genderSchema,
  guestName: z
    .object({
      firstName: personNameSchema(en.validation.hostFirstNameRequired),
      lastName: personNameSchema(en.validation.hostLastNameRequired),
    })
    .nullable(),
});

export type HostRosterCheckInInput = z.input<typeof hostCheckInInputSchema>;

/** The name a listed player gets: first word, then the rest (may be empty). */
function nameFromRoster(displayName: string) {
  const [firstName = "", ...rest] = displayName.split(" ");
  return { firstName, lastName: rest.join(" ") };
}

/**
 * A host checks in a listed player in person (no phone). In a live session
 * the PlayerJoined is checked by the engine first, then written with the
 * participant in one transaction.
 */
export async function hostCheckInRosterEntry(
  input: unknown,
): Promise<RosterWriteResult> {
  const authorized = await authorize();
  if (!authorized.ok) return authorized;
  const parsed = hostCheckInInputSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, message: en.validation.checkHighlightedFields };
  const details = parsed.data;
  const { host } = authorized;
  try {
    const roster = await readRoster(host);
    const entry = roster?.entries.find(
      (candidate) => candidate.rosterEntryId === details.rosterEntryId,
    );
    if (!roster || roster.sessionId !== details.sessionId || !entry)
      return { ok: false, message: text.sessionClosed, isConflict: true };
    if (entry.participant) {
      return entry.participant.participantId === details.participantId
        ? { ok: true }
        : { ok: false, message: text.alreadyCheckedIn, isConflict: true };
    }
    const name =
      entry.label.displayName === null
        ? details.guestName
        : nameFromRoster(entry.label.displayName);
    if (!name)
      return { ok: false, message: en.validation.checkHighlightedFields };

    let eventFields = {};
    if (roster.sessionStatus === "live") {
      const log = await loadSessionLog(
        await createSupabaseServerClient(),
        details.sessionId,
      );
      if (!log)
        return { ok: false, message: text.sessionClosed, isConflict: true };
      const replayed = replay(log.events);
      if (!replayed.ok) throw new Error("The session log doesn't replay.");
      const at = Math.max(Date.now(), replayed.state.lastAt ?? 0);
      const checked = applyEvent(replayed.state, {
        type: "PlayerJoined",
        seq: replayed.state.lastSeq + 1,
        eventId: details.eventId as ReturnType<typeof randomUUID>,
        at,
        actorId: host.userId,
        payload: {
          participant: {
            participantId: details.participantId as ReturnType<
              typeof randomUUID
            >,
            firstName: name.firstName,
            lastName: name.lastName,
            skill: details.skillLevel,
            gender: details.gender,
          },
        },
      });
      if (!checked.ok) return { ok: false, message: checked.error.message };
      eventFields = {
        p_event_id: details.eventId,
        p_expected_last_seq: replayed.state.lastSeq,
        p_occurred_at: new Date(at).toISOString(),
      };
    }
    const { error } = await createSupabaseAdminClient()
      .rpc("host_check_in_roster_entry", {
        p_actor_user_id: host.userId,
        p_session_id: details.sessionId,
        p_roster_entry_id: details.rosterEntryId,
        p_session_participant_id: details.participantId,
        p_skill_level: details.skillLevel,
        p_gender: details.gender,
        p_first_name: details.guestName?.firstName,
        p_last_name: details.guestName?.lastName,
        ...eventFields,
      })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) return refusalFromError(error);
    return { ok: true };
  } catch (error) {
    logRosterFailure("Host roster check-in failed", host, error);
    return { ok: false, message: text.couldNotSave };
  }
}
