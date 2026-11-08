"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { TEXT_INPUT_CLASS_NAME } from "@/components/controlStyles";
import {
  buildMemberDirectoryHref,
  MEMBER_SEARCH_TEXT_MAX_LENGTH,
  SKILL_LEVEL_LABELS,
  SKILL_LEVELS,
  type MemberDirectoryQuery,
  type MemberStatusFilter,
  type SkillLevel,
} from "@/server/members/memberSearch";

const SEARCH_DEBOUNCE_MS = 300;

const FILTER_CHIP_BASE_CLASS_NAME =
  "inline-flex h-11 items-center rounded-full px-3.5 text-sm";
const FILTER_CHIP_SELECTED_CLASS_NAME = "bg-text font-bold text-bg";
const FILTER_CHIP_UNSELECTED_CLASS_NAME =
  "border border-outline font-semibold text-text hover:bg-inner";

const SKILL_FILTER_OPTIONS: { skillLevel: SkillLevel | null; label: string }[] =
  [
    { skillLevel: null, label: "All" },
    ...SKILL_LEVELS.map((skillLevel) => ({
      skillLevel,
      label: SKILL_LEVEL_LABELS[skillLevel],
    })),
  ];

const STATUS_FILTER_OPTIONS: { status: MemberStatusFilter; label: string }[] = [
  { status: "active", label: "Active" },
  { status: "deactivated", label: "Deactivated" },
];

function filterChipClassName(isSelected: boolean): string {
  return `${FILTER_CHIP_BASE_CLASS_NAME} ${
    isSelected
      ? FILTER_CHIP_SELECTED_CLASS_NAME
      : FILTER_CHIP_UNSELECTED_CLASS_NAME
  }`;
}

/**
 * Search, skill and status filters. They live in the URL (so a refresh or a
 * shared link keeps them); the server reads the URL and runs the query.
 */
export function MemberDirectoryFilters({
  query,
}: {
  query: MemberDirectoryQuery;
}) {
  const router = useRouter();
  const [isNavigating, startNavigation] = useTransition();
  const [searchInput, setSearchInput] = useState(query.searchText);
  // The search text this component last put in the URL, and the URL's search
  // text it last saw: together they tell a back/forward navigation (sync the
  // input) apart from our own debounced update (keep what the user is typing).
  const [requestedSearchText, setRequestedSearchText] = useState(
    query.searchText,
  );
  const [observedUrlSearchText, setObservedUrlSearchText] = useState(
    query.searchText,
  );
  const pendingSearchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  if (query.searchText !== observedUrlSearchText) {
    setObservedUrlSearchText(query.searchText);
    if (query.searchText !== requestedSearchText) {
      setSearchInput(query.searchText);
      setRequestedSearchText(query.searchText);
    }
  }

  function navigateTo(nextQuery: MemberDirectoryQuery) {
    clearTimeout(pendingSearchTimeout.current);
    setRequestedSearchText(nextQuery.searchText);
    startNavigation(() => {
      // Filters reset paging: "Show more" counts from the first page again.
      router.replace(buildMemberDirectoryHref({ ...nextQuery, pageCount: 1 }), {
        scroll: false,
      });
    });
  }

  function handleSearchInputChange(nextSearchInput: string) {
    setSearchInput(nextSearchInput);
    clearTimeout(pendingSearchTimeout.current);
    pendingSearchTimeout.current = setTimeout(() => {
      const nextSearchText = nextSearchInput.trim();
      if (nextSearchText !== query.searchText) {
        navigateTo({ ...query, searchText: nextSearchText });
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigateTo({ ...query, searchText: searchInput.trim() });
  }

  // Chips keep whatever is typed, even if the debounce hasn't fired yet.
  const currentQuery = { ...query, searchText: searchInput.trim() };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <form
          role="search"
          onSubmit={handleSearchSubmit}
          className="relative flex-[1_1_260px]"
        >
          <label htmlFor="member-search" className="sr-only">
            Search members by name
          </label>
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            className="pointer-events-none absolute top-[15px] left-3.5 stroke-muted"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            id="member-search"
            type="search"
            placeholder="Search by name"
            autoComplete="off"
            maxLength={MEMBER_SEARCH_TEXT_MAX_LENGTH}
            value={searchInput}
            onChange={(event) => handleSearchInputChange(event.target.value)}
            className={`${TEXT_INPUT_CLASS_NAME} pl-[42px] text-[15px]`}
          />
        </form>
        <div
          role="group"
          aria-label="Filter by skill"
          className="flex flex-wrap gap-1.5"
        >
          {SKILL_FILTER_OPTIONS.map(({ skillLevel, label }) => {
            const isSelected = query.skillLevel === skillLevel;
            return (
              <button
                key={label}
                type="button"
                aria-pressed={isSelected}
                onClick={() => navigateTo({ ...currentQuery, skillLevel })}
                className={filterChipClassName(isSelected)}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div
          role="group"
          aria-label="Show members"
          className="flex flex-wrap gap-1.5"
        >
          {STATUS_FILTER_OPTIONS.map(({ status, label }) => {
            const isSelected = query.status === status;
            return (
              <button
                key={status}
                type="button"
                aria-pressed={isSelected}
                onClick={() => navigateTo({ ...currentQuery, status })}
                className={filterChipClassName(isSelected)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      {/* Visual only: the result count below is the live region. */}
      {isNavigating && <p className="text-sm text-muted">Updating…</p>}
    </div>
  );
}
