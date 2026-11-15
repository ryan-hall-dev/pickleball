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
import {
  listDraftParticipants,
  listSocialSavedSetups,
  readSocialOpenSession,
  type ClubCourt,
  type DraftParticipant,
  type SavedSetupSummary,
  type SessionDraft,
} from "./setupDraft";
import {
  setDraftParticipantDetailsInputSchema,
  type SetDraftParticipantDetailsInput,
  addClubCourtInputSchema,
  addDraftParticipantInputSchema,
  DEFAULT_SESSION_DRAFT_CONFIG,
  removeDraftParticipantInputSchema,
  saveSessionDraftInputSchema,
  startSessionDraftInputSchema,
  type AddClubCourtInput,
  type AddDraftParticipantInput,
  type RemoveDraftParticipantInput,
  type SaveSessionDraftInput,
  type SessionDraftConfig,
  type ApplySavedSetupInput,
  type SaveSetupInput,
  applySavedSetupInputSchema,
  coHostDraftNotice,
  courtsLeftOutNotice,
  parseSavedSetupConfig,
  safeParseSavedSetupConfig,
  saveSetupInputSchema,
  type SavedSetupConfig,
  type StartSessionDraftInput,
} from "./setupRules";

// Setup screen writes (plan §7 M4). Every action verifies the caller as a host
// with getUser() first, then writes with the service-role client
// (docs/decisions/0002-server-only-writes.md). Drafts, courts and saved
// setups belong to the host's social, and every host of the social works on
// the same draft (co-editing; the draft revision refuses stale settings
// writes). The service-role client bypasses RLS, so every query filters by
// host.socialId and every insert sets it; the database functions derive the
// social from the actor too.

export type SetupActionResult = { ok: true } | { ok: false; message: string };

/**
 * After "Start a new session". `notice`: the social already had a draft that
 * a co-host started, which this host now edits with them (their new draft's
 * name was not used); null otherwise.
 */
export type StartSessionDraftResult =
  { ok: true; notice: string | null } | { ok: false; message: string };

/**
 * A draft settings write. On success, the draft's new settings revision (the
 * next write must name it). `isConflict`: another tab or device changed the
 * settings since this editor's revision; nothing was written.
 */
export type SaveSessionDraftResult =
  | { ok: true; draftRevision: number }
  | { ok: false; message: string; isConflict?: true };

/** After a saved-setup write: the social's saved setups as the database now has them. */
export type SaveSetupResult =
  | { ok: true; message: string; savedSetups: SavedSetupSummary[] }
  | { ok: false; message: string };

/**
 * After applying a saved setup: the draft as the database now has it (the
 * editor takes these values), an optional note (e.g. a court left out), and
 * the social's saved setups.
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
/** Raised by the draft write functions when the session isn't the social's open draft. */
const DRAFT_NOT_OPEN_ERROR = "DRAFT_NOT_OPEN";
/** Raised by remove_draft_participant when the participant's session is no longer a draft. */
const SESSION_NOT_DRAFT_ERROR = "SESSION_NOT_DRAFT";
/** Raised by remove_draft_participant for a participant that's gone (or another social's). */
const PARTICIPANT_NOT_FOUND_ERROR = "PARTICIPANT_NOT_FOUND";
/** Raised by every participant write when the name is already in the session. */
const NAME_ALREADY_IN_SESSION_ERROR = "NAME_ALREADY_IN_SESSION";
const SAVED_BUT_LIST_NOT_REFRESHED =
  "Saved, but the list couldn't refresh. Reload the page.";
const SAVED_SETUP_NOT_FOUND =
  "That saved setup isn't available any more. Reload the page.";
/** Raised by apply_saved_setup when the setup isn't the social's. */
const SAVED_SETUP_NOT_FOUND_ERROR = "SAVED_SETUP_NOT_FOUND";
const MS_PER_MINUTE = 60_000;
/** Raised by the draft settings writes when the expected revision is stale. */
const DRAFT_CHANGED_ELSEWHERE_ERROR = "DRAFT_CHANGED_ELSEWHERE";
const DRAFT_CHANGED_ELSEWHERE =
  "Setup was changed by another host, tab or device. Reload to see the latest \u2014 your unsaved changes here will be lost.";
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
const ONLY_MANAGERS_ADD_COURTS = "Only the social manager can add courts.";
const LIVE_SESSION_EXISTS =
  "Your social already has a live session. End it before setting up a new one.";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** What the details autosave writes: every draft config key but the applied setup. */
type SessionDraftConfigPatch = Omit<SessionDraftConfig, "appliedSavedSetupId">;

function logActionFailure(label: string, host: SignedInHost, error: unknown) {
  // Ids only: no names or other personal data in logs.
  console.error(label, {
    actorUserId: host.userId,
    cause: error instanceof Error ? error.message : String(error),
  });
}

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the highlighted fields.";
}

/** The social's draft, or null when it's another social's or isn't a draft any more. */
async function readSocialDraft(
  adminClient: AdminClient,
  host: SignedInHost,
  sessionId: string,
) {
  const { data, error } = await adminClient
    .from("sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("social_id", host.socialId)
    .eq("status", "draft")
    .maybeSingle();
  if (error) throw new Error(`Reading the draft failed: ${error.message}`);
  return data;
}

/**
 * Court snapshots for a draft or saved setup: names come from the database
 * (never trusted from the browser), in club order. Courts that were removed,
 * deactivated, don't support the format or belong to another social are
 * listed as unavailable.
 */
async function snapshotCourts(
  adminClient: AdminClient,
  socialId: string,
  courtIds: readonly string[],
  matchFormat: CourtFormat,
): Promise<{ courts: CourtConfig[]; unavailableCourtIds: string[] }> {
  if (courtIds.length === 0) return { courts: [], unavailableCourtIds: [] };
  const { data: courtRows, error } = await adminClient
    .from("courts")
    .select("id, name, supported_formats, is_active, sort_order")
    .eq("social_id", socialId)
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

/**
 * Creates the social's draft. When the social already has one open (a
 * co-host started it), does nothing: the page then shows that draft.
 */
export async function startSessionDraft(
  input: StartSessionDraftInput,
): Promise<StartSessionDraftResult> {
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

  let notice: string | null = null;
  try {
    const adminClient = createSupabaseAdminClient();
    const { error } = await adminClient.from("sessions").insert({
      social_id: host.socialId,
      // "Created by"; any host of the social may edit and run it.
      host_id: host.userId,
      name: parsed.data.name,
      host_name: host.displayName,
      planned_start: parsed.data.plannedStart,
      planned_end: parsed.data.plannedEnd,
      status: "draft",
      config_snapshot: DEFAULT_SESSION_DRAFT_CONFIG as unknown as Json,
    });
    if (error?.code === POSTGRES_UNIQUE_VIOLATION) {
      // One open session per social: report a live one, reuse a draft
      // (possibly a co-host's).
      const { data: openSession, error: readError } = await adminClient
        .from("sessions")
        .select("status, name, host_id")
        .eq("social_id", host.socialId)
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
      // The host's own draft (a double click, another tab) needs no notice.
      if (openSession && openSession.host_id !== host.userId) {
        notice = coHostDraftNotice(openSession.name);
      }
    } else if (error) {
      throw new Error(`Creating the draft failed: ${error.message}`);
    }
  } catch (error) {
    logActionFailure("Starting a session draft failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }

  revalidatePath(SETUP_PATH);
  return { ok: true, notice };
}

/**
 * Saves the Session details, Courts and Rotation cards into the social's draft.
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
      host.socialId,
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
    // only touches the social's draft (DRAFT_NOT_OPEN otherwise), and only if
    // nothing (a co-host, another tab) changed it since this edit's revision.
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
    logActionFailure("Saving a session draft failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
}

/** Discards the social's draft (cancel_draft_session; it never had a log). */
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
    // cancel_draft_session also accepts a cancelled session or refuses a live
    // one; checking for an open draft first gives one clear message.
    const socialDraft = await readSocialDraft(
      adminClient,
      host,
      parsedSessionId.data,
    );
    if (!socialDraft) return { ok: false, message: DRAFT_NOT_OPEN };
    const { error } = await adminClient.rpc("cancel_draft_session", {
      p_actor_user_id: host.userId,
      p_session_id: parsedSessionId.data,
    });
    if (error) throw new Error(`Discarding the draft failed: ${error.message}`);
  } catch (error) {
    logActionFailure("Discarding a session draft failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }

  revalidatePath(SETUP_PATH);
  return { ok: true };
}

/**
 * Adds a court to the manager's social. Social managers only (Ryan,
 * 2026-11-09): courts are shared by every session of the social, so other
 * hosts only choose from the existing ones. Names are unique within the
 * social; another social may have a court of the same name.
 */
export async function addClubCourt(
  input: AddClubCourtInput,
): Promise<AddClubCourtResult> {
  const authorization = await authorizeCurrentHost("manager");
  if (!authorization.ok) {
    return {
      ok: false,
      message:
        authorization.reason === "NOT_A_MANAGER"
          ? ONLY_MANAGERS_ADD_COURTS
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
      .eq("social_id", host.socialId)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (readError) {
      throw new Error(`Reading the courts failed: ${readError.message}`);
    }
    const { data: createdCourt, error } = await adminClient
      .from("courts")
      .insert({
        social_id: host.socialId,
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
    logActionFailure("Adding a club court failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
}

/**
 * Runs one attendance function on the social's draft, then reads the
 * attendee list back. Each function checks in the database, in its own
 * transaction, that the draft is the actor's social's and still open, so there is no
 * separate ownership read here (it would only add a race). A participant
 * that's already gone counts as removed. `nameClashMessage` is shown when
 * the function refuses a name already in the session.
 */
async function writeDraftAttendance(
  host: SignedInHost,
  sessionId: string,
  failureLabel: string,
  callAttendanceFunction: (
    adminClient: AdminClient,
  ) => PromiseLike<{ error: { message: string } | null }>,
  nameClashMessage?: string,
): Promise<DraftAttendanceResult> {
  let adminClient: AdminClient;
  try {
    adminClient = createSupabaseAdminClient();
    const { error } = await callAttendanceFunction(adminClient);
    if (
      error?.message === DRAFT_NOT_OPEN_ERROR ||
      error?.message === SESSION_NOT_DRAFT_ERROR
    ) {
      return { ok: false, message: DRAFT_NOT_OPEN };
    }
    if (error?.message === NAME_ALREADY_IN_SESSION_ERROR && nameClashMessage) {
      return { ok: false, message: nameClashMessage };
    }
    if (error && error.message !== PARTICIPANT_NOT_FOUND_ERROR) {
      throw new Error(`${failureLabel}: ${error.message}`);
    }
  } catch (error) {
    logActionFailure(failureLabel, host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
  try {
    return {
      ok: true,
      participants: await listDraftParticipants(
        adminClient,
        host.socialId,
        sessionId,
      ),
    };
  } catch (error) {
    logActionFailure(
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

/** The host's message when a name is already in the session (plan §2). */
function nameAlreadyInSessionMessage(
  firstName: string,
  lastName: string,
): string {
  return `Someone named ${firstName} ${lastName} is already in this session. Add something to tell them apart, like an initial.`;
}

/**
 * Adds a player to the social's draft (this session only): name and level
 * required, and no two players in a session may share a name. Repeating the
 * same participant id is a no-op, so a retry is safe.
 */
export async function addDraftParticipant(
  input: AddDraftParticipantInput,
): Promise<DraftAttendanceResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsed = addDraftParticipantInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }
  const { sessionId, participantId, firstName, lastName, skillLevel, gender } =
    parsed.data;
  return writeDraftAttendance(
    host,
    sessionId,
    "Adding a draft participant failed",
    (adminClient) =>
      adminClient.rpc("add_draft_participant", {
        p_actor_user_id: host.userId,
        p_session_id: sessionId,
        p_session_participant_id: participantId,
        p_first_name: firstName,
        p_last_name: lastName,
        p_skill_level: skillLevel,
        p_gender: gender,
      }),
    nameAlreadyInSessionMessage(firstName, lastName),
  );
}

/** Removes a player from the social's draft (already gone counts as done). */
export async function removeDraftParticipant(
  input: RemoveDraftParticipantInput,
): Promise<DraftAttendanceResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsed = removeDraftParticipantInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }
  const { sessionId, participantId } = parsed.data;
  return writeDraftAttendance(
    host,
    sessionId,
    "Removing a draft participant failed",
    (adminClient) =>
      adminClient.rpc("remove_draft_participant", {
        p_actor_user_id: host.userId,
        p_session_participant_id: participantId,
      }),
  );
}

function sameSetupName(first: string, second: string): boolean {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}

/**
 * Saves the editor's current values as one of the social's setups (location,
 * duration, courts, format, timings, rotation; never attendance). Saving
 * under a name the social already uses (ignoring case) replaces that setup,
 * whichever host saved it.
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
      host.socialId,
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
    // Never write a row listSocialSavedSetups / applySavedSetup couldn't read.
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
      .eq("social_id", host.socialId);
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
      savedSetups: await listSocialSavedSetups(adminClient, host.socialId),
    };
  } catch (error) {
    logActionFailure("Saving a setup failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
}

/**
 * Copies one of the social's saved setups into its draft: location,
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
      .eq("social_id", host.socialId)
      .maybeSingle();
    if (setupError) {
      throw new Error(`Reading the saved setup failed: ${setupError.message}`);
    }
    if (!setupRow) return { ok: false, message: SAVED_SETUP_NOT_FOUND };
    const setup = parseSavedSetupConfig(setupRow.config);
    const { courts, unavailableCourtIds } = await snapshotCourts(
      adminClient,
      host.socialId,
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
    logActionFailure("Applying a saved setup failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }

  try {
    const openSession = await readSocialOpenSession(host.socialId);
    if (openSession.status !== "draft") {
      return { ok: false, message: DRAFT_NOT_OPEN };
    }
    return {
      ok: true,
      draft: openSession.draft,
      notice,
      savedSetups: await listSocialSavedSetups(
        createSupabaseAdminClient(),
        host.socialId,
      ),
    };
  } catch (error) {
    logActionFailure(
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

export type ReadSessionDraftResult =
  { ok: true; draft: SessionDraft } | { ok: false; message: string };

/**
 * The social's draft as the database has it now. The editor re-reads it
 * after its own earlier writes land, when the page it was rendered from was
 * read before them. Reads under the host's session (RLS).
 */
export async function readSessionDraft(
  sessionId: string,
): Promise<ReadSessionDraftResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;
  const parsedSessionId = z.uuid().safeParse(sessionId);
  if (!parsedSessionId.success) {
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }

  try {
    const openSession = await readSocialOpenSession(host.socialId);
    if (
      openSession.status !== "draft" ||
      openSession.draft.sessionId !== parsedSessionId.data
    ) {
      return { ok: false, message: DRAFT_NOT_OPEN };
    }
    return { ok: true, draft: openSession.draft };
  } catch (error) {
    logActionFailure("Re-reading a session draft failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
}

/** Complete historical missing details without editing the session's identity. */
export async function setDraftParticipantDetails(
  input: SetDraftParticipantDetailsInput,
): Promise<SaveSessionDraftResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok)
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  const parsed = setDraftParticipantDetailsInputSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, message: firstIssueMessage(parsed.error) };
  const { host } = authorization;
  try {
    const value = parsed.data;
    const { data, error } = await createSupabaseAdminClient()
      .rpc("set_draft_participant_details", {
        p_actor_user_id: host.userId,
        p_session_id: value.sessionId,
        p_participant_id: value.participantId,
        p_gender: value.gender,
        p_skill_level: value.skillLevel,
        p_expected_draft_revision: value.expectedDraftRevision,
      })
      .abortSignal(AbortSignal.timeout(15000));
    if (error?.message === DRAFT_CHANGED_ELSEWHERE_ERROR)
      return { ok: false, message: DRAFT_CHANGED_ELSEWHERE, isConflict: true };
    if (
      error?.message === DRAFT_NOT_OPEN_ERROR ||
      error?.message === SESSION_NOT_DRAFT_ERROR
    )
      return { ok: false, message: DRAFT_NOT_OPEN };
    if (error)
      throw new Error(`Saving participant details failed: ${error.message}`);
    return {
      ok: true,
      draftRevision: z
        .object({ draftRevision: z.number().int().nonnegative() })
        .parse(data).draftRevision,
    };
  } catch (error) {
    logActionFailure("Saving participant details failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
}
