import "server-only";
import type { CourtFormat } from "@/engine/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { parseSessionDraftConfig, type SessionDraftConfig } from "./setupRules";

// Reads for the Setup screen use the signed-in host's session, so RLS decides
// what is visible (hosts only). Writes live in setupActions.ts.

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
  /** Everyone on the draft's attendee list (members and guests). */
  attendingPlayerCount: number;
  attendingGuestCount: number;
}

/** The host's one open session (the sessions_one_open_per_host_idx index). */
export type HostOpenSession =
  | { status: "none" }
  | { status: "live"; sessionId: string; name: string }
  | { status: "draft"; draft: SessionDraft };

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export async function readHostOpenSession(
  hostUserId: string,
): Promise<HostOpenSession> {
  const supabase = await createSupabaseServerClient();
  const { data: session, error } = await supabase
    .from("sessions")
    .select(
      "id, status, name, location, host_name, planned_start, planned_end, config_snapshot",
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

  const [attendingPlayerCount, attendingGuestCount] = await Promise.all([
    countParticipants(supabase, session.id, false),
    countParticipants(supabase, session.id, true),
  ]);
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
      attendingPlayerCount,
      attendingGuestCount,
    },
  };
}

async function countParticipants(
  supabase: ServerClient,
  sessionId: string,
  onlyGuests: boolean,
): Promise<number> {
  let builder = supabase
    .from("session_participants")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);
  if (onlyGuests) builder = builder.eq("is_guest", true);
  const { count, error } = await builder;
  if (error || count === null) {
    throw new Error(
      `Counting the draft's players failed: ${error?.message ?? "no count"}`,
    );
  }
  return count;
}

/** The club's active courts in display order. */
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
