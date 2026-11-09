"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { CourtConfig, CourtFormat } from "@/engine/session";
import type { Json } from "@/lib/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import {
  HOST_ACCESS_DENIAL_MESSAGES,
  type SignedInHost,
} from "@/server/auth/hostAccess";
import type { SkillLevel } from "@/server/members/memberSearch";
import {
  listDraftParticipants,
  listSavedSetups,
  readHostOpenSession,
  type ClubCourt,
  type DraftParticipant,
  type SavedSetupSummary,
  type SessionDraft,
} from "./setupDraft";
import {
  addClubCourtInputSchema,
  addDraftGuestInputSchema,
  DEFAULT_SESSION_DRAFT_CONFIG,
  removeDraftGuestInputSchema,
  saveSessionDraftInputSchema,
  setDraftMemberAttendanceInputSchema,
  startSessionDraftInputSchema,
  type AddClubCourtInput,
  type AddDraftGuestInput,
  type RemoveDraftGuestInput,
  type SaveSessionDraftInput,
  type SessionDraftConfig,
  type SetDraftMemberAttendanceInput,
  type ApplySavedSetupInput,
  type SaveSetupInput,
  applySavedSetupInputSchema,
  courtsLeftOutNotice,
  parseSavedSetupConfig,
  safeParseSavedSetupConfig,
  saveSetupInputSchema,
  type SavedSetupConfig,
  type StartSessionDraftInput,
} from "./setupRules";

// Setup screen writes (plan §7 M4). Every action verifies the caller as a host
// with getUser() first, then writes with the service-role client
// (docs/decisions/0002-server-only-writes.md). A host only ever touches their
// OWN draft: every session read and write is filtered by host_id = caller.

export type SetupActionResult = { ok: true } | { ok: false; message: string };

/**
 * A draft settings write. On success, the draft's new settings revision (the
 * next write must name it). `isConflict`: another tab or device changed the
 * settings since this editor's revision; nothing was written.
 */
export type SaveSessionDraftResult =
  | { ok: true; draftRevision: number }
  | { ok: false; message: string; isConflict?: true };

/** After a saved-setup write: the host's saved setups as the database now has them. */
export type SaveSetupResult =
  | { ok: true; message: string; savedSetups: SavedSetupSummary[] }
  | { ok: false; message: string };

/**
 * After applying a saved setup: the draft as the database now has it (the
 * editor takes these values), an optional note (e.g. a court left out), and
 * the host's saved setups.
 */
export type ApplySavedSetupResult =
  | {
      ok: true;
      draft: SessionDraft;
      notice: string | null;
      savedSetups: SavedSetupSummary[];
    }
  | {
      ok: false;
      message: string;
      /** The setup WAS applied but couldn't be read back: the screen is stale. */
      requiresReload?: true;
      /** The draft's settings changed elsewhere: nothing was applied. */
      isConflict?: true;
    };

export type AddClubCourtResult =
  { ok: true; court: ClubCourt } | { ok: false; message: string };

/**
 * After an attendance write: the draft's whole attendee list as the database
 * now has it, so the screen also picks up changes made in another tab. When
 * the write landed but reading the list back failed, `participants` is null
 * and `message` says so (the change must not be offered for retry).
 */
export type DraftAttendanceResult =
  | { ok: true; participants: DraftParticipant[] }
  | { ok: true; participants: null; message: string }
  | { ok: false; message: string };

const SETUP_PATH = "/setup";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const POSTGRES_CHECK_VIOLATION = "23514";
const SOMETHING_WENT_WRONG = "Something went wrong. Try again in a moment.";
const DRAFT_NOT_OPEN =
  "This draft is no longer open (it was discarded or started). Reload the page.";
/** Raised by the draft write functions when the session isn't the caller's open draft. */
const DRAFT_NOT_OPEN_ERROR = "DRAFT_NOT_OPEN";
const SAVED_BUT_LIST_NOT_REFRESHED =
  "Saved, but the list couldn't refresh. Reload the page.";
const SAVED_SETUP_NOT_FOUND =
  "That saved setup isn't available any more. Reload the page.";
/** Raised by apply_saved_setup when the setup isn't the caller's. */
const SAVED_SETUP_NOT_FOUND_ERROR = "SAVED_SETUP_NOT_FOUND";
const MS_PER_MINUTE = 60_000;
/** Raised by the draft settings writes when the expected revision is stale. */
const DRAFT_CHANGED_ELSEWHERE_ERROR = "DRAFT_CHANGED_ELSEWHERE";
const DRAFT_CHANGED_ELSEWHERE =
  "Setup was changed in another tab or by another device. Reload to see the latest \u2014 your unsaved changes here will be lost.";
const draftRevisionSchema = z.number().int().min(0);

/** The new revision a draft settings write returns ({ draftRevision }). */
function draftRevisionFrom(data: unknown): number {
  const parsed = z
    .object({ draftRevision: draftRevisionSchema })
    .safeParse(data);
  if (!parsed.success) {
    throw new Error("A draft settings write returned no revision.");
  }
  return parsed.data.draftRevision;
}
const ONLY_ADMINS_ADD_COURTS = "Only admins can add courts to the club.";
const LIVE_SESSION_EXISTS =
  "You already have a live session. End it before setting up a new one.";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** What the details autosave writes: every draft config key but the applied setup. */
type SessionDraftConfigPatch = Omit<SessionDraftConfig, "appliedSavedSetupId">;

function logWriteFailure(label: string, host: SignedInHost, error: unknown) {
  // Ids only: no names or other personal data in logs.
  console.error(label, {
    actorUserId: host.userId,
    cause: error instanceof Error ? error.message : String(error),
  });
}

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the highlighted fields.";
}

/** The caller's own draft, or null when it isn't theirs or isn't a draft any more. */
async function readOwnDraft(
  adminClient: AdminClient,
  host: SignedInHost,
  sessionId: string,
) {
  const { data, error } = await adminClient
    .from("sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("host_id", host.userId)
    .eq("status", "draft")
    .maybeSingle();
  if (error) throw new Error(`Reading the draft failed: ${error.message}`);
  return data;
}

/**
 * Court snapshots for a draft or saved setup: names come from the database
 * (never trusted from the browser), in club order. Courts that were removed,
 * deactivated or don't support the format are listed as unavailable.
 */
async function snapshotCourts(
  adminClient: AdminClient,
  courtIds: readonly string[],
  matchFormat: CourtFormat,
): Promise<{ courts: CourtConfig[]; unavailableCourtIds: string[] }> {
  if (courtIds.length === 0) return { courts: [], unavailableCourtIds: [] };
  const { data: courtRows, error } = await adminClient
    .from("courts")
    .select("id, name, supported_formats, is_active, sort_order")
    .in("id", [...courtIds])
    .order("sort_order")
    .order("name");
  if (error) throw new Error(`Reading the courts failed: ${error.message}`);
  const courts = courtRows
    .filter(
      (court) =>
        court.is_active && court.supported_formats.includes(matchFormat),
    )
    .map((court) => ({
      courtId: court.id,
      name: court.name,
      format: matchFormat,
    }));
  const usableCourtIds = new Set(courts.map((court) => court.courtId));
  return {
    courts,
    unavailableCourtIds: courtIds.filter(
      (courtId) => !usableCourtIds.has(courtId),
    ),
  };
}

/** Creates the host's draft. Does nothing if they already have one open. */
export async function startSessionDraft(
  input: StartSessionDraftInput,
): Promise<SetupActionResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsed = startSessionDraftInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }

  try {
    const adminClient = createSupabaseAdminClient();
    const { error } = await adminClient.from("sessions").insert({
      host_id: host.userId,
      name: parsed.data.name,
      host_name: host.displayName,
      planned_start: parsed.data.plannedStart,
      planned_end: parsed.data.plannedEnd,
      status: "draft",
      config_snapshot: DEFAULT_SESSION_DRAFT_CONFIG as unknown as Json,
    });
    if (error?.code === POSTGRES_UNIQUE_VIOLATION) {
      // One open session per host: report a live one, reuse a draft.
      const { data: openSession, error: readError } = await adminClient
        .from("sessions")
        .select("status")
        .eq("host_id", host.userId)
        .in("status", ["draft", "live"])
        .maybeSingle();
      if (readError) {
        throw new Error(
          `Reading the open session failed: ${readError.message}`,
        );
      }
      if (openSession?.status === "live") {
        return { ok: false, message: LIVE_SESSION_EXISTS };
      }
    } else if (error) {
      throw new Error(`Creating the draft failed: ${error.message}`);
    }
  } catch (error) {
    logWriteFailure("Starting a session draft failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }

  revalidatePath(SETUP_PATH);
  return { ok: true };
}

/**
 * Saves the Session details, Courts and Rotation cards into the host's own draft.
 * Court names are read from the database (never trusted from the browser) and
 * snapshotted with the chosen format.
 */
export async function saveSessionDraft(
  input: SaveSessionDraftInput,
  expectedDraftRevision: number,
): Promise<SaveSessionDraftResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsed = saveSessionDraftInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }
  const parsedRevision = draftRevisionSchema.safeParse(expectedDraftRevision);
  if (!parsedRevision.success) {
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
  const draftInput = parsed.data;

  try {
    const adminClient = createSupabaseAdminClient();
    const { courts, unavailableCourtIds } = await snapshotCourts(
      adminClient,
      draftInput.courtIds,
      draftInput.matchFormat,
    );
    if (unavailableCourtIds.length > 0) {
      return {
        ok: false,
        message: `A chosen court was removed or doesn't support ${draftInput.matchFormat}. Reload the page.`,
      };
    }

    const draftConfig: SessionDraftConfigPatch = {
      courts,
      matchFormat: draftInput.matchFormat,
      targetMatchMinutes: draftInput.targetMatchMinutes,
      changeoverMinutes: draftInput.changeoverMinutes,
      rotation: draftInput.rotation,
    };
    // One statement, under the session's row lock: writes the details and
    // merges this step's config keys, keeping keys other setup steps own. It
    // only touches the caller's own draft (DRAFT_NOT_OPEN otherwise), and
    // only if nothing changed it since the revision this edit started from.
    const { data, error } = await adminClient.rpc("save_session_draft", {
      p_actor_user_id: host.userId,
      p_session_id: draftInput.sessionId,
      p_expected_draft_revision: parsedRevision.data,
      p_name: draftInput.name,
      // The function stores an empty location as none.
      p_location: draftInput.location ?? "",
      p_host_name: draftInput.hostName,
      p_planned_start: draftInput.plannedStart,
      p_planned_end: draftInput.plannedEnd,
      p_config_patch: draftConfig as unknown as Json,
    });
    if (error?.message === DRAFT_NOT_OPEN_ERROR) {
      return { ok: false, message: DRAFT_NOT_OPEN };
    }
    if (error?.message === DRAFT_CHANGED_ELSEWHERE_ERROR) {
      return { ok: false, message: DRAFT_CHANGED_ELSEWHERE, isConflict: true };
    }
    if (error?.code === POSTGRES_CHECK_VIOLATION) {
      return { ok: false, message: "Check the session details and try again." };
    }
    if (error) throw new Error(`Saving the draft failed: ${error.message}`);
    return { ok: true, draftRevision: draftRevisionFrom(data) };
  } catch (error) {
    logWriteFailure("Saving a session draft failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
}

/** Discards the host's own draft (cancel_draft_session; it never had a log). */
export async function discardSessionDraft(
  sessionId: string,
): Promise<SetupActionResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsedSessionId = z.uuid().safeParse(sessionId);
  if (!parsedSessionId.success) return { ok: false, message: DRAFT_NOT_OPEN };

  try {
    const adminClient = createSupabaseAdminClient();
    // cancel_draft_session checks the actor is a host, not that the draft is
    // theirs, so ownership is checked here first.
    const ownDraft = await readOwnDraft(
      adminClient,
      host,
      parsedSessionId.data,
    );
    if (!ownDraft) return { ok: false, message: DRAFT_NOT_OPEN };
    const { error } = await adminClient.rpc("cancel_draft_session", {
      p_actor_user_id: host.userId,
      p_session_id: parsedSessionId.data,
    });
    if (error) throw new Error(`Discarding the draft failed: ${error.message}`);
  } catch (error) {
    logWriteFailure("Discarding a session draft failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }

  revalidatePath(SETUP_PATH);
  return { ok: true };
}

/**
 * Adds a court to the club. Admins only (Ryan, 2026-11-09): courts are shared
 * by every session, so other hosts only choose from the existing ones.
 */
export async function addClubCourt(
  input: AddClubCourtInput,
): Promise<AddClubCourtResult> {
  const authorization = await authorizeCurrentHost("admin");
  if (!authorization.ok) {
    return {
      ok: false,
      message:
        authorization.reason === "NOT_AN_ADMIN"
          ? ONLY_ADMINS_ADD_COURTS
          : HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsed = addClubCourtInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }
  const { name, supportedFormats } = parsed.data;

  try {
    const adminClient = createSupabaseAdminClient();
    const { data: lastCourt, error: readError } = await adminClient
      .from("courts")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (readError) {
      throw new Error(`Reading the courts failed: ${readError.message}`);
    }
    const { data: createdCourt, error } = await adminClient
      .from("courts")
      .insert({
        name,
        supported_formats: supportedFormats,
        sort_order: (lastCourt?.sort_order ?? 0) + 1,
      })
      .select("id, name, supported_formats")
      .single();
    if (error?.code === POSTGRES_UNIQUE_VIOLATION) {
      return {
        ok: false,
        message: `A court called ${name} already exists. Choose another name.`,
      };
    }
    if (error) throw new Error(`Adding the court failed: ${error.message}`);
    return {
      ok: true,
      court: {
        id: createdCourt.id,
        name: createdCourt.name,
        supportedFormats: createdCourt.supported_formats,
      },
    };
  } catch (error) {
    logWriteFailure("Adding a club court failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
}

/**
 * Runs one attendance function on the caller's own draft, then reads the
 * attendee list back. Each function checks in the database, in its own
 * transaction, that the draft is the caller's and still open, so there is no
 * separate ownership read here (it would only add a race).
 */
async function writeDraftAttendance(
  host: SignedInHost,
  sessionId: string,
  failureLabel: string,
  callAttendanceFunction: (
    adminClient: AdminClient,
  ) => PromiseLike<{ error: { message: string } | null }>,
): Promise<DraftAttendanceResult> {
  let adminClient: AdminClient;
  try {
    adminClient = createSupabaseAdminClient();
    const { error } = await callAttendanceFunction(adminClient);
    if (error?.message === DRAFT_NOT_OPEN_ERROR) {
      return { ok: false, message: DRAFT_NOT_OPEN };
    }
    if (error) throw new Error(`${failureLabel}: ${error.message}`);
  } catch (error) {
    logWriteFailure(failureLabel, host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
  try {
    return {
      ok: true,
      participants: await listDraftParticipants(adminClient, sessionId),
    };
  } catch (error) {
    logWriteFailure(
      "Reading the draft's players after a write failed",
      host,
      error,
    );
    return {
      ok: true,
      participants: null,
      message: SAVED_BUT_LIST_NOT_REFRESHED,
    };
  }
}

/**
 * Marks members as attending the host's draft, or not. Set semantics: members
 * already in that state are left alone, so repeats and other tabs are safe.
 * Only active members can be added; "not attending" never removes guests.
 */
export async function setDraftMemberAttendance(
  input: SetDraftMemberAttendanceInput,
): Promise<DraftAttendanceResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsed = setDraftMemberAttendanceInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }
  const { sessionId, memberIds, attending } = parsed.data;
  return writeDraftAttendance(
    host,
    sessionId,
    "Changing draft attendance failed",
    (adminClient) =>
      adminClient.rpc("set_draft_member_attendance", {
        p_actor_user_id: host.userId,
        p_session_id: sessionId,
        p_member_ids: memberIds,
        p_attending: attending,
      }),
  );
}

/**
 * Adds a guest (plays this session only; not added to the members directory).
 * Repeating the same participant id is a no-op, so a retry is safe.
 */
export async function addDraftGuest(
  input: AddDraftGuestInput,
): Promise<DraftAttendanceResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsed = addDraftGuestInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }
  const { sessionId, participantId, firstName, lastName, skillLevel } =
    parsed.data;
  return writeDraftAttendance(
    host,
    sessionId,
    "Adding a draft guest failed",
    (adminClient) =>
      adminClient.rpc("add_draft_guest", {
        p_actor_user_id: host.userId,
        p_session_id: sessionId,
        p_session_participant_id: participantId,
        p_first_name: firstName,
        p_last_name: lastName,
        // Generated types can't mark an argument nullable; null = no level.
        p_skill_level: skillLevel as SkillLevel,
      }),
  );
}

/** Removes a guest from the host's draft (already gone counts as done). */
export async function removeDraftGuest(
  input: RemoveDraftGuestInput,
): Promise<DraftAttendanceResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsed = removeDraftGuestInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }
  const { sessionId, participantId } = parsed.data;
  return writeDraftAttendance(
    host,
    sessionId,
    "Removing a draft guest failed",
    (adminClient) =>
      adminClient.rpc("remove_draft_guest", {
        p_actor_user_id: host.userId,
        p_session_id: sessionId,
        p_session_participant_id: participantId,
      }),
  );
}

function sameSetupName(first: string, second: string): boolean {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}

/**
 * Saves the editor's current values as one of the host's setups (location,
 * duration, courts, format, timings, rotation; never attendance). Saving
 * under a name the host already uses (ignoring case) replaces that setup.
 */
export async function saveSetup(
  input: SaveSetupInput,
): Promise<SaveSetupResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsed = saveSetupInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }
  const { setupName, draft } = parsed.data;

  try {
    const adminClient = createSupabaseAdminClient();
    const { courts, unavailableCourtIds } = await snapshotCourts(
      adminClient,
      draft.courtIds,
      draft.matchFormat,
    );
    if (unavailableCourtIds.length > 0) {
      return {
        ok: false,
        message: `A chosen court was removed or doesn't support ${draft.matchFormat}. Reload the page.`,
      };
    }
    const config: SavedSetupConfig = {
      location: draft.location,
      durationMinutes: Math.round(
        (Date.parse(draft.plannedEnd) - Date.parse(draft.plannedStart)) /
          MS_PER_MINUTE,
      ),
      courts,
      matchFormat: draft.matchFormat,
      targetMatchMinutes: draft.targetMatchMinutes,
      changeoverMinutes: draft.changeoverMinutes,
      rotation: draft.rotation,
    };
    // Never write a row listSavedSetups / applySavedSetup couldn't read.
    const checkedConfig = safeParseSavedSetupConfig(config);
    if (!checkedConfig.success) {
      return {
        ok: false,
        message: `This setup can't be saved: ${firstIssueMessage(checkedConfig.error)}`,
      };
    }
    // Only for the wording ("Replaced" vs "Saved"); the upsert itself is atomic.
    const { data: existingSetups, error: readError } = await adminClient
      .from("saved_setups")
      .select("name")
      .eq("host_id", host.userId);
    if (readError) {
      throw new Error(`Reading the saved setups failed: ${readError.message}`);
    }
    const isReplacing = existingSetups.some((existing) =>
      sameSetupName(existing.name, setupName),
    );
    const { error } = await adminClient.rpc("save_setup", {
      p_actor_user_id: host.userId,
      p_name: setupName,
      p_config: checkedConfig.data as unknown as Json,
    });
    if (error) throw new Error(`Saving the setup failed: ${error.message}`);
    return {
      ok: true,
      message: `${isReplacing ? "Replaced" : "Saved"} \u201c${setupName}\u201d.`,
      savedSetups: await listSavedSetups(adminClient, host.userId),
    };
  } catch (error) {
    logWriteFailure("Saving a setup failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
}

/**
 * Copies one of the host's saved setups into their own draft: location,
 * courts, format, timings, rotation, and end = the draft's start + the
 * setup's duration. The session name, start and attendance stay as they are.
 * Courts that are gone or can't host the format are left out (and named).
 */
export async function applySavedSetup(
  input: ApplySavedSetupInput,
): Promise<ApplySavedSetupResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsed = applySavedSetupInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }
  const { sessionId, setupId, expectedDraftRevision } = parsed.data;

  let notice: string | null;
  try {
    const adminClient = createSupabaseAdminClient();
    const { data: setupRow, error: setupError } = await adminClient
      .from("saved_setups")
      .select("config")
      .eq("id", setupId)
      .eq("host_id", host.userId)
      .maybeSingle();
    if (setupError) {
      throw new Error(`Reading the saved setup failed: ${setupError.message}`);
    }
    if (!setupRow) return { ok: false, message: SAVED_SETUP_NOT_FOUND };
    const setup = parseSavedSetupConfig(setupRow.config);
    const { courts, unavailableCourtIds } = await snapshotCourts(
      adminClient,
      setup.courts.map((court) => court.courtId),
      setup.matchFormat,
    );
    notice = courtsLeftOutNotice(
      setup.courts
        .filter((court) => unavailableCourtIds.includes(court.courtId))
        .map((court) => court.name),
    );
    const configPatch: SessionDraftConfig = {
      courts,
      matchFormat: setup.matchFormat,
      targetMatchMinutes: setup.targetMatchMinutes,
      changeoverMinutes: setup.changeoverMinutes,
      rotation: setup.rotation,
      appliedSavedSetupId: setupId,
    };
    // One transaction: the draft write (under its row lock) and marking the
    // setup as used. End = the locked row's start + the duration.
    const { error } = await adminClient.rpc("apply_saved_setup", {
      p_actor_user_id: host.userId,
      p_session_id: sessionId,
      p_setup_id: setupId,
      p_expected_draft_revision: expectedDraftRevision,
      p_location: setup.location ?? "",
      p_duration_minutes: setup.durationMinutes,
      p_config_patch: configPatch as unknown as Json,
    });
    if (error?.message === DRAFT_NOT_OPEN_ERROR) {
      return { ok: false, message: DRAFT_NOT_OPEN };
    }
    if (error?.message === DRAFT_CHANGED_ELSEWHERE_ERROR) {
      return { ok: false, message: DRAFT_CHANGED_ELSEWHERE, isConflict: true };
    }
    if (error?.message === SAVED_SETUP_NOT_FOUND_ERROR) {
      return { ok: false, message: SAVED_SETUP_NOT_FOUND };
    }
    if (error) throw new Error(`Applying the setup failed: ${error.message}`);
  } catch (error) {
    logWriteFailure("Applying a saved setup failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }

  try {
    const openSession = await readHostOpenSession(host.userId);
    if (openSession.status !== "draft") {
      return { ok: false, message: DRAFT_NOT_OPEN };
    }
    return {
      ok: true,
      draft: openSession.draft,
      notice,
      savedSetups: await listSavedSetups(
        createSupabaseAdminClient(),
        host.userId,
      ),
    };
  } catch (error) {
    logWriteFailure(
      "Reading the draft after applying a setup failed",
      host,
      error,
    );
    return {
      ok: false,
      message:
        "The setup was applied, but the page couldn't refresh. Reload the page.",
      requiresReload: true,
    };
  }
}
