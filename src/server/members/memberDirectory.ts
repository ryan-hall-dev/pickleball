import "server-only";
import { cache } from "react";
import { DATA_API_MAX_ROWS, readAllRows } from "@/lib/supabase/readAllRows";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  MEMBER_DIRECTORY_PAGE_SIZE,
  memberSearchLikePattern,
  type MemberDirectoryQuery,
  type SkillLevel,
} from "./memberSearch";

// Reads use the signed-in host's session, so RLS decides what is visible
// (hosts only; anyone else gets no rows). Writes live in memberActions.ts.

export interface MemberListEntry {
  id: string;
  firstName: string;
  lastName: string;
  skillLevel: SkillLevel | null;
  isActive: boolean;
  lastCheckedInAt: string | null;
}

export interface MemberDirectoryPage {
  members: MemberListEntry[];
  /** All members matching the filters, not just the rows shown. */
  matchingMemberCount: number;
}

export interface MemberStatusCounts {
  activeMemberCount: number;
  deactivatedMemberCount: number;
}

const MEMBER_COLUMNS =
  "id, first_name, last_name, skill_level, is_active, last_checked_in_at";

type MemberRow = {
  id: string;
  first_name: string;
  last_name: string;
  skill_level: SkillLevel | null;
  is_active: boolean;
  last_checked_in_at: string | null;
};

function toMemberListEntry(row: MemberRow): MemberListEntry {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    skillLevel: row.skill_level,
    isActive: row.is_active,
    lastCheckedInAt: row.last_checked_in_at,
  };
}

/**
 * One window of the directory: the first `pageCount` pages of members matching
 * the filters, ordered by name (id breaks ties so pages never overlap).
 */
export async function listMembers(
  query: MemberDirectoryQuery,
): Promise<MemberDirectoryPage> {
  const supabase = await createSupabaseServerClient();
  const searchLikePattern = memberSearchLikePattern(query.searchText);

  function membersQuery(
    rangeStart: number,
    rangeEnd: number,
    { withMatchingCount }: { withMatchingCount: boolean },
  ) {
    let builder = supabase
      .from("members")
      // Only the first request counts the matches; later chunks don't repeat it.
      .select(
        MEMBER_COLUMNS,
        withMatchingCount ? { count: "exact" } : undefined,
      )
      .eq("is_active", query.status === "active");
    if (query.skillLevel) builder = builder.eq("skill_level", query.skillLevel);
    // Parameterised by PostgREST; wildcards in the typed text are escaped.
    if (searchLikePattern) {
      builder = builder.like("search_name", searchLikePattern);
    }
    return builder
      .order("first_name")
      .order("last_name")
      .order("id")
      .range(rangeStart, rangeEnd);
  }

  const wantedRowCount = query.pageCount * MEMBER_DIRECTORY_PAGE_SIZE;
  const firstChunk = await membersQuery(
    0,
    Math.min(wantedRowCount, DATA_API_MAX_ROWS) - 1,
    { withMatchingCount: true },
  );
  if (firstChunk.error) {
    throw new Error(`Listing members failed: ${firstChunk.error.message}`);
  }
  const matchingMemberCount = firstChunk.count ?? 0;
  const rows: MemberRow[] = [...firstChunk.data];

  // Only reached past DATA_API_MAX_ROWS rows; capped by the real count, so a
  // huge `page` in the URL can't fan out into needless requests.
  const lastWantedRow = Math.min(wantedRowCount, matchingMemberCount);
  const chunkStarts: number[] = [];
  for (
    let chunkStart = DATA_API_MAX_ROWS;
    chunkStart < lastWantedRow;
    chunkStart += DATA_API_MAX_ROWS
  ) {
    chunkStarts.push(chunkStart);
  }
  const laterChunks = await Promise.all(
    chunkStarts.map((chunkStart) =>
      membersQuery(
        chunkStart,
        Math.min(chunkStart + DATA_API_MAX_ROWS, lastWantedRow) - 1,
        { withMatchingCount: false },
      ),
    ),
  );
  for (const chunk of laterChunks) {
    if (chunk.error) {
      throw new Error(`Listing members failed: ${chunk.error.message}`);
    }
    rows.push(...chunk.data);
  }

  return { members: rows.map(toMemberListEntry), matchingMemberCount };
}

/** What the Setup screen needs to list and pick a member. */
export type ActiveMemberChoice = Pick<
  MemberListEntry,
  "id" | "firstName" | "lastName" | "skillLevel"
>;

/**
 * Every active member, ordered by name, for the Setup screen's "Who's
 * playing?" list (searched and paged in the browser, so filtering is instant
 * and "Select all" covers every match). No limit: long clubs are read in chunks.
 */
export async function listAllActiveMembers(): Promise<ActiveMemberChoice[]> {
  const supabase = await createSupabaseServerClient();
  const rows = await readAllRows(
    (fromRow, toRow) =>
      supabase
        .from("members")
        .select("id, first_name, last_name, skill_level")
        .eq("is_active", true)
        .order("first_name")
        .order("last_name")
        .order("id")
        .range(fromRow, toRow),
    "Listing active members failed",
  );
  return rows.map((row) => ({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    skillLevel: row.skill_level,
  }));
}

/** Cached per request: the page header and the directory both need it. */
export const countMembersByStatus = cache(
  async (): Promise<MemberStatusCounts> => {
    const supabase = await createSupabaseServerClient();
    const [activeResult, deactivatedResult] = await Promise.all([
      supabase
        .from("members")
        .select("id", { count: "exact", head: true })
        .eq("is_active", true),
      supabase
        .from("members")
        .select("id", { count: "exact", head: true })
        .eq("is_active", false),
    ]);
    if (activeResult.error || deactivatedResult.error) {
      throw new Error(
        `Counting members failed: ${activeResult.error?.message ?? deactivatedResult.error?.message}`,
      );
    }
    return {
      activeMemberCount: activeResult.count ?? 0,
      deactivatedMemberCount: deactivatedResult.count ?? 0,
    };
  },
);

/** One member by id, or null if there is none (or the caller can't read it). */
export async function getMember(
  memberId: string,
): Promise<MemberListEntry | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("members")
    .select(MEMBER_COLUMNS)
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw new Error(`Reading the member failed: ${error.message}`);
  return data ? toMemberListEntry(data) : null;
}
