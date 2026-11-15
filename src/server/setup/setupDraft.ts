import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CourtFormat, RotationObjective } from "@/engine/session";
import type { Database } from "@/lib/database.types";
import { readAllRows } from "@/lib/supabase/readAllRows";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { genderSchema, type Gender } from "@/server/participantRules";
import type { SkillLevel } from "@/server/skillLevels";
import {
  parseSessionDraftConfig,
  safeParseSavedSetupConfig,
  type SessionDraftConfig,
} from "./setupRules";

// Reads for the Setup screen use the signed-in host's session, so RLS decides
// what is visible: only the host's own social's courts, sessions, participants and
// saved setups, so nothing of another social is ever listed. Queries still
// filter by social where the service-role client (which bypasses RLS) reuses
// them. Writes live in setupActions.ts.

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
  /** Everyone on the draft's attendee list. */
  participants: DraftParticipant[];
}

/** One row of a draft's attendee list (`session_participants`): this session only. */
export interface DraftParticipant {
  participantId: string;
  firstName: string;
  lastName: string;
  /** Null only for rows recorded before a level was required. */
  skillLevel: SkillLevel | null;
  gender: Gender | null;
}

/** The social's one open session (the sessions_one_open_per_social_idx index). */
export type SocialOpenSession =
  | { status: "none" }
  | { status: "live"; sessionId: string; name: string }
  | { status: "draft"; draft: SessionDraft };

/**
 * The social's open session, shared by all its hosts (co-editing: any host
 * of the social edits the same draft). Read under RLS; filtered by social too.
 */
export async function readSocialOpenSession(
  socialId: string,
): Promise<SocialOpenSession> {
  const supabase = await createSupabaseServerClient();
  const { data: session, error } = await supabase
    .from("sessions")
    .select(
      "id, status, name, location, host_name, planned_start, planned_end, config_snapshot, draft_revision",
    )
    .eq("social_id", socialId)
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
      participants: await listDraftParticipants(supabase, socialId, session.id),
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
  socialId: string,
  sessionId: string,
): Promise<DraftParticipant[]> {
  const rows = await readAllRows(
    (fromRow, toRow) =>
      supabase
        .from("session_participants")
        .select(DRAFT_PARTICIPANT_COLUMNS)
        .eq("social_id", socialId)
        .eq("session_id", sessionId)
        .order("created_at")
        .order("id")
        .range(fromRow, toRow),
    "Reading the draft's players failed",
  );
  return rows.map(draftParticipantFromRow);
}

/** The `session_participants` columns a DraftParticipant is read from. */
export const DRAFT_PARTICIPANT_COLUMNS =
  "id, first_name, last_name, skill_level, gender";

export function draftParticipantFromRow(row: {
  id: string;
  first_name: string;
  last_name: string;
  skill_level: SkillLevel | null;
  gender: string | null;
}): DraftParticipant {
  return {
    participantId: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    skillLevel: row.skill_level,
    gender: row.gender === null ? null : genderSchema.parse(row.gender),
  };
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

/** One of the social's saved setups, as the Saved setups list and reuse banner show it. */
export interface SavedSetupSummary {
  setupId: string;
  name: string;
  /** ISO timestamp. */
  lastUsedAt: string;
  courtCount: number;
  topObjective: RotationObjective;
}

/** Plenty for one social; the list shows the most recently used first. */
export const SAVED_SETUPS_LIST_LIMIT = 50;

/**
 * The social's saved setups (shared by all its hosts), most recently used
 * first. RLS also limits every host to their own social's; the social filter
 * is still needed because the service-role client bypasses RLS. A row that
 * doesn't parse is skipped and logged (ids only) so one bad row can't break
 * the Setup screen. Takes the client like listDraftParticipants.
 */
export async function listSocialSavedSetups(
  supabase: SupabaseClient<Database>,
  socialId: string,
): Promise<SavedSetupSummary[]> {
  const { data, error } = await supabase
    .from("saved_setups")
    .select("id, name, config, last_used_at")
    .eq("social_id", socialId)
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
        socialId,
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

/** The signed-in host's social's saved setups, read under RLS. */
export async function listSocialSavedSetupsUnderRls(
  socialId: string,
): Promise<SavedSetupSummary[]> {
  return listSocialSavedSetups(await createSupabaseServerClient(), socialId);
}
