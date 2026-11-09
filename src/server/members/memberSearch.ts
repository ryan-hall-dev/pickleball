import type { Database } from "@/lib/database.types";

// Pure helpers for the Members directory URL and search. Shared by the server
// (querying) and the browser (building filter links), so no server-only imports.

export type SkillLevel = Database["public"]["Enums"]["skill_level"];

export const SKILL_LEVELS = [
  "beginner",
  "intermediate",
  "advanced",
] as const satisfies readonly SkillLevel[];

export const SKILL_LEVEL_LABELS: Record<SkillLevel, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

/** The skill filter chips: "All" (null), then each level. */
export const SKILL_FILTER_OPTIONS: {
  skillLevel: SkillLevel | null;
  label: string;
}[] = [
  { skillLevel: null, label: "All" },
  ...SKILL_LEVELS.map((skillLevel) => ({
    skillLevel,
    label: SKILL_LEVEL_LABELS[skillLevel],
  })),
];

export type MemberStatusFilter = "active" | "deactivated";

/**
 * How many member cards one "Show more" adds. A UI page size only: the
 * directory itself has no limit, and every match stays reachable.
 */
export const MEMBER_DIRECTORY_PAGE_SIZE = 48;

/** Longer search text can't match a name (first + last are at most 50 each). */
export const MEMBER_SEARCH_TEXT_MAX_LENGTH = 101;

export interface MemberDirectoryQuery {
  /** As typed (trimmed); normalised only when querying. Empty = no search. */
  searchText: string;
  /** Null = all levels (members without a level only show under "All"). */
  skillLevel: SkillLevel | null;
  status: MemberStatusFilter;
  /** How many pages are shown, from the first (1 = the first page only). */
  pageCount: number;
}

export const DEFAULT_MEMBER_DIRECTORY_QUERY: MemberDirectoryQuery = {
  searchText: "",
  skillLevel: null,
  status: "active",
  pageCount: 1,
};

type SearchParamValue = string | string[] | undefined;

function firstValue(value: SearchParamValue): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function isSkillLevel(value: string): value is SkillLevel {
  return (SKILL_LEVELS as readonly string[]).includes(value);
}

/**
 * Reads the directory filters from the URL. Unknown or malformed values fall
 * back to the defaults (a hand-edited URL shouldn't break the page).
 */
export function parseMemberDirectoryQuery(
  searchParams: Record<string, SearchParamValue>,
): MemberDirectoryQuery {
  const skillParam = firstValue(searchParams.skill);
  const pageParam = firstValue(searchParams.page);
  const pageCount = /^\d{1,6}$/.test(pageParam) ? Number(pageParam) : 1;
  return {
    searchText: firstValue(searchParams.q)
      .trim()
      .slice(0, MEMBER_SEARCH_TEXT_MAX_LENGTH),
    skillLevel: isSkillLevel(skillParam) ? skillParam : null,
    status:
      firstValue(searchParams.status) === "deactivated"
        ? "deactivated"
        : "active",
    pageCount: Math.max(1, pageCount),
  };
}

/** The /members URL for a query; defaults are left out to keep URLs short. */
export function buildMemberDirectoryHref(query: MemberDirectoryQuery): string {
  const params = new URLSearchParams();
  if (query.searchText) params.set("q", query.searchText);
  if (query.skillLevel) params.set("skill", query.skillLevel);
  if (query.status === "deactivated") params.set("status", "deactivated");
  if (query.pageCount > 1) params.set("page", String(query.pageCount));
  const queryString = params.toString();
  return queryString ? `/members?${queryString}` : "/members";
}

/**
 * Folds text the same way as the `members.search_name` column (migration
 * 20261109090000): lowercase, accents removed, whitespace collapsed.
 */
export function normalizeMemberSearchText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Escapes text for a LIKE pattern sent through PostgREST. `%` and `_` are SQL
 * wildcards and `\` is the escape itself. `*` can't be matched literally:
 * PostgREST turns every `*` into `%`, even after a `\`. So it becomes the
 * single-character wildcard `_`, which still finds names containing "*"
 * (and, harmlessly, any other character in that spot).
 */
export function escapeLikePattern(text: string): string {
  return text
    .replace(/[\\%_]/g, (character) => `\\${character}`)
    .replace(/\*/g, "_");
}

/** The `search_name LIKE` pattern for a "contains" search, or null for no search. */
export function memberSearchLikePattern(searchText: string): string | null {
  const normalizedSearchText = normalizeMemberSearchText(searchText);
  if (!normalizedSearchText) return null;
  return `%${escapeLikePattern(normalizedSearchText)}%`;
}
