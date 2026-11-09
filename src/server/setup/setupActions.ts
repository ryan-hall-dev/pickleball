"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { CourtConfig } from "@/engine/session";
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
  type ClubCourt,
  type DraftParticipant,
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
  type StartSessionDraftInput,
} from "./setupRules";

// Setup screen writes (plan §7 M4). Every action verifies the caller as a host
// with getUser() first, then writes with the service-role client
// (docs/decisions/0002-server-only-writes.md). A host only ever touches their
// OWN draft: every session read and write is filtered by host_id = caller.

export type SetupActionResult = { ok: true } | { ok: false; message: string };

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
const ONLY_ADMINS_ADD_COURTS = "Only admins can add courts to the club.";
const LIVE_SESSION_EXISTS =
  "You already have a live session. End it before setting up a new one.";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

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
 * Saves the Session details and Courts cards into the host's own draft.
 * Court names are read from the database (never trusted from the browser) and
 * snapshotted with the chosen format.
 */
export async function saveSessionDraft(
  input: SaveSessionDraftInput,
): Promise<SetupActionResult> {
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
  const draftInput = parsed.data;

  try {
    const adminClient = createSupabaseAdminClient();
    let courts: CourtConfig[] = [];
    if (draftInput.courtIds.length > 0) {
      const { data: courtRows, error: courtsError } = await adminClient
        .from("courts")
        .select("id, name, supported_formats, is_active, sort_order")
        .in("id", draftInput.courtIds)
        .order("sort_order")
        .order("name");
      if (courtsError) {
        throw new Error(`Reading the courts failed: ${courtsError.message}`);
      }
      const usableCourts = courtRows.filter(
        (court) =>
          court.is_active &&
          court.supported_formats.includes(draftInput.matchFormat),
      );
      if (usableCourts.length !== draftInput.courtIds.length) {
        return {
          ok: false,
          message: `A chosen court was removed or doesn't support ${draftInput.matchFormat}. Reload the page.`,
        };
      }
      courts = usableCourts.map((court) => ({
        courtId: court.id,
        name: court.name,
        format: draftInput.matchFormat,
      }));
    }

    const draftConfig: SessionDraftConfig = {
      courts,
      matchFormat: draftInput.matchFormat,
      targetMatchMinutes: draftInput.targetMatchMinutes,
      changeoverMinutes: draftInput.changeoverMinutes,
    };
    // One statement, under the session's row lock: writes the details and
    // merges this step's config keys, keeping keys other setup steps own. It
    // only touches the caller's own draft (DRAFT_NOT_OPEN otherwise).
    const { error } = await adminClient.rpc("save_session_draft", {
      p_actor_user_id: host.userId,
      p_session_id: draftInput.sessionId,
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
    if (error?.code === POSTGRES_CHECK_VIOLATION) {
      return { ok: false, message: "Check the session details and try again." };
    }
    if (error) throw new Error(`Saving the draft failed: ${error.message}`);
  } catch (error) {
    logWriteFailure("Saving a session draft failed", host, error);
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }
  return { ok: true };
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
