import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CourtFormat, RotationObjective } from "@/engine/session";
import type { Database } from "@/lib/database.types";
import { readAllRows } from "@/lib/supabase/readAllRows";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SkillLevel } from "@/server/members/memberSearch";
import {
  parseSessionDraftConfig,
  safeParseSavedSetupConfig,
  type SessionDraftConfig,
} from "./setupRules";

// Reads for the Setup screen use the signed-in host's session, so RLS decides
// what is visible (hosts only; courts and members of the host's own social
// only, so the court picker and "Who's playing?" never list another
// social's). Writes live in setupActions.ts.

export interface ClubCourt {
  id: string;
  name: string;
  supportedFormats: CourtFormat[];
}

export interface SessionDraft {
  sessionId: string;
  name: string;
  location: string | null;
  hostName: string;
  /** ISO timestamps; the browser shows them in its own time zone. */
  plannedStart: string;
  plannedEnd: string;
  config: SessionDraftConfig;
  /** Settings revision: every settings write names it and bumps it. */
  draftRevision: number;
  /** Everyone on the draft's attendee list (members and guests). */
  participants: DraftParticipant[];
}

/** One row of a draft's attendee list (`session_participants`), names snapshotted. */
export interface DraftParticipant {
  participantId: string;
  /** Null for a guest who isn't a club member. */
  memberId: string | null;
  isGuest: boolean;
  firstName: string;
  lastName: string;
  skillLevel: SkillLevel | null;
  /** Whether the linked member is still active; null without a member. */
  isMemberActive: boolean | null;
}

/** The host's one open session (the sessions_one_open_per_host_idx index). */
export type HostOpenSession =
  | { status: "none" }
  | { status: "live"; sessionId: string; name: string }
  | { status: "draft"; draft: SessionDraft };

export async function readHostOpenSession(
  hostUserId: string,
): Promise<HostOpenSession> {
  const supabase = await createSupabaseServerClient();
  const { data: session, error } = await supabase
    .from("sessions")
    .select(
      "id, status, name, location, host_name, planned_start, planned_end, config_snapshot, draft_revision",
    )
    .eq("host_id", hostUserId)
    .in("status", ["draft", "live"])
    .maybeSingle();
  if (error)
    throw new Error(`Reading the open session failed: ${error.message}`);
  if (!session) return { status: "none" };
  if (session.status === "live") {
    return { status: "live", sessionId: session.id, name: session.name };
  }

  return {
    status: "draft",
    draft: {
      sessionId: session.id,
      name: session.name,
      location: session.location,
      hostName: session.host_name,
      plannedStart: session.planned_start,
      plannedEnd: session.planned_end,
      config: parseSessionDraftConfig(session.config_snapshot),
      draftRevision: session.draft_revision,
      participants: await listDraftParticipants(supabase, session.id),
    },
  };
}

/**
 * A draft's whole attendee list in the order people were added. Takes the
 * client so the page reads under RLS and the attendance actions (which have
 * just checked ownership in the database) read with the service-role client.
 * No limit on attendance: long lists are read in chunks.
 */
export async function listDraftParticipants(
  supabase: SupabaseClient<Database>,
  sessionId: string,
): Promise<DraftParticipant[]> {
  const rows = await readAllRows(
    (fromRow, toRow) =>
      supabase
        .from("session_participants")
        .select(
          "id, member_id, is_guest, first_name, last_name, skill_level, members(is_active)",
        )
        .eq("session_id", sessionId)
        .order("created_at")
        .order("id")
        .range(fromRow, toRow),
    "Reading the draft's players failed",
  );
  return rows.map((row) => ({
    participantId: row.id,
    memberId: row.member_id,
    isGuest: row.is_guest,
    firstName: row.first_name,
    lastName: row.last_name,
    skillLevel: row.skill_level,
    isMemberActive: row.members?.is_active ?? null,
  }));
}

/** The social's active courts in display order (RLS scopes them to the host's social). */
export async function listActiveClubCourts(): Promise<ClubCourt[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("courts")
    .select("id, name, supported_formats")
    .eq("is_active", true)
    .order("sort_order")
    .order("name");
  if (error) throw new Error(`Reading the courts failed: ${error.message}`);
  return data.map((court) => ({
    id: court.id,
    name: court.name,
    supportedFormats: court.supported_formats,
  }));
}

/** One of the host's saved setups, as the Saved setups list and reuse banner show it. */
export interface SavedSetupSummary {
  setupId: string;
  name: string;
  /** ISO timestamp. */
  lastUsedAt: string;
  courtCount: number;
  topObjective: RotationObjective;
}

/** Plenty for one host; the list shows the most recently used first. */
export const SAVED_SETUPS_LIST_LIMIT = 50;

/**
 * The host's OWN saved setups, most recently used first. RLS also limits
 * every host to their own (saved_setups_select_own); the host filter is
 * still needed because the service-role client bypasses RLS. A row that
 * doesn't parse is skipped and logged (ids only) so one bad row can't break
 * the Setup screen. Takes the client like listDraftParticipants.
 */
export async function listSavedSetups(
  supabase: SupabaseClient<Database>,
  hostUserId: string,
): Promise<SavedSetupSummary[]> {
  const { data, error } = await supabase
    .from("saved_setups")
    .select("id, name, config, last_used_at")
    .eq("host_id", hostUserId)
    .order("last_used_at", { ascending: false })
    .order("id")
    .limit(SAVED_SETUPS_LIST_LIMIT);
  if (error) {
    throw new Error(`Reading the saved setups failed: ${error.message}`);
  }
  return data.flatMap((row) => {
    const parsed = safeParseSavedSetupConfig(row.config);
    if (!parsed.success) {
      console.error("Skipping a saved setup with a malformed config", {
        setupId: row.id,
        hostUserId,
      });
      return [];
    }
    return [
      {
        setupId: row.id,
        name: row.name,
        lastUsedAt: row.last_used_at,
        courtCount: parsed.data.courts.length,
        topObjective: parsed.data.rotation.objectiveOrder[0],
      },
    ];
  });
}

/** The signed-in host's saved setups, read under RLS. */
export async function listOwnSavedSetups(
  hostUserId: string,
): Promise<SavedSetupSummary[]> {
  return listSavedSetups(await createSupabaseServerClient(), hostUserId);
}
