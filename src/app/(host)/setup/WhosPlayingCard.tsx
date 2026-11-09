"use client";

import Link from "next/link";
import {
  useId,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  LINK_BUTTON_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
  SELECTED_FILTER_CHIP_CLASS_NAME,
  TEXT_INPUT_CLASS_NAME,
  UNSELECTED_FILTER_CHIP_CLASS_NAME,
} from "@/components/controlStyles";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import { SkillChip } from "@/components/SkillChip";
import type { ActiveMemberChoice } from "@/server/members/memberDirectory";
import {
  MEMBER_DIRECTORY_PAGE_SIZE,
  MEMBER_SEARCH_TEXT_MAX_LENGTH,
  SKILL_FILTER_OPTIONS,
  type SkillLevel,
} from "@/server/members/memberSearch";
import { CheckIcon } from "./CheckIcon";
import { QuickAddGuestBox } from "./QuickAddGuestBox";
import { SetupSection } from "./SetupSection";
import type { DraftAttendance } from "./useDraftAttendance";
import {
  attendingMemberIds,
  buildMemberRows,
  filterMemberRows,
  guestParticipants,
  memberIdsInChanges,
  memberIdsToSelect,
  selectableMemberCount,
  type GuestForm,
  type WhosPlayingMemberRow,
} from "./whosPlaying";

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Card 3: which members attend (search, filter, select) and quick-add guests. */
export function WhosPlayingCard({
  activeMembers,
  attendance,
  guestForm,
  onGuestFormChange,
}: {
  activeMembers: ActiveMemberChoice[];
  attendance: DraftAttendance;
  guestForm: GuestForm;
  onGuestFormChange: Dispatch<SetStateAction<GuestForm>>;
}) {
  const {
    participants,
    pendingChanges,
    failures,
    refreshProblem,
    queueChange,
    retryFailures,
  } = attendance;
  const [searchText, setSearchText] = useState("");
  const [skillLevel, setSkillLevel] = useState<SkillLevel | null>(null);
  const [visibleRowCount, setVisibleRowCount] = useState(
    MEMBER_DIRECTORY_PAGE_SIZE,
  );
  const showingLineId = useId();

  const memberRows = useMemo(
    () => buildMemberRows(activeMembers, participants),
    [activeMembers, participants],
  );
  const matchingRows = useMemo(
    () => filterMemberRows(memberRows, { searchText, skillLevel }),
    [memberRows, searchText, skillLevel],
  );
  const visibleRows = matchingRows.slice(0, visibleRowCount);
  const pendingMemberIds = memberIdsInChanges(
    pendingChanges.map((queued) => queued.change),
  );
  const pendingParticipantIds = new Set(
    pendingChanges.flatMap((queued) =>
      queued.change.kind === "addGuest" ? [queued.change.participantId] : [],
    ),
  );
  const guests = guestParticipants(participants);
  const attendingIdSet = attendingMemberIds(participants);
  const attendingIds = [...attendingIdSet];
  // As in the design: registered = active members; not attending = the rest.
  const notAttendingCount = activeMembers.filter(
    (member) => !attendingIdSet.has(member.id),
  ).length;
  const idsToSelect = memberIdsToSelect(matchingRows);
  const selectableCount = selectableMemberCount(matchingRows);
  const isFiltering = searchText.trim() !== "" || skillLevel !== null;

  function changeFilter(patch: {
    searchText?: string;
    skillLevel?: SkillLevel | null;
  }) {
    if (patch.searchText !== undefined) setSearchText(patch.searchText);
    if (patch.skillLevel !== undefined) setSkillLevel(patch.skillLevel);
    // A new filter starts from the first page again.
    setVisibleRowCount(MEMBER_DIRECTORY_PAGE_SIZE);
  }

  function toggleMember(row: WhosPlayingMemberRow) {
    const fullName = `${row.firstName} ${row.lastName}`;
    queueChange({
      change: {
        kind: "setMembers",
        memberIds: [row.memberId],
        attending: !row.isAttending,
      },
      description: `${row.isAttending ? "Removing" : "Adding"} ${fullName}`,
    });
  }

  return (
    <SetupSection
      stepNumber={3}
      headingId="whos-playing-heading"
      heading="Who's playing?"
      actions={
        <div className="flex flex-wrap gap-2 tabular-nums">
          <span className="rounded-[14px] bg-inner px-3.5 py-2 text-sm">
            <b className="text-lg">{activeMembers.length}</b>{" "}
            <span className="text-muted">registered</span>
          </span>
          <span className="rounded-[14px] bg-lime-surface px-3.5 py-2 text-sm text-lime-soft">
            <b className="text-lg">{attendingIds.length}</b> attending
          </span>
          <span className="rounded-[14px] bg-inner px-3.5 py-2 text-sm">
            <b className="text-lg">{notAttendingCount}</b>{" "}
            <span className="text-muted">not attending</span>
          </span>
          <span className="rounded-[14px] bg-blue-surface px-3.5 py-2 text-sm text-blue-soft">
            <b className="text-lg">+{guests.length}</b>{" "}
            {guests.length === 1 ? "guest" : "guests"}
          </span>
        </div>
      }
    >
      {memberRows.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-2xl bg-inner px-4 py-3.5">
          <p className="text-[15px] text-muted">
            The club has no members yet. Add members to pick who&apos;s playing,
            or add guests below.
          </p>
          <Link href="/members/new" className={SECONDARY_BUTTON_CLASS_NAME}>
            Add a member
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
            <div role="search" className="relative flex-[1_1_260px]">
              <label htmlFor="whos-playing-search" className="sr-only">
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
                id="whos-playing-search"
                type="search"
                placeholder="Search by name"
                autoComplete="off"
                maxLength={MEMBER_SEARCH_TEXT_MAX_LENGTH}
                value={searchText}
                onChange={(event) =>
                  changeFilter({ searchText: event.target.value })
                }
                aria-describedby={showingLineId}
                className={`${TEXT_INPUT_CLASS_NAME} pl-[42px] text-[15px]`}
              />
            </div>
            <div
              role="group"
              aria-label="Filter by skill"
              className="flex flex-wrap gap-1.5"
            >
              {SKILL_FILTER_OPTIONS.map((option) => {
                const isSelected = option.skillLevel === skillLevel;
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() =>
                      changeFilter({ skillLevel: option.skillLevel })
                    }
                    className={
                      isSelected
                        ? SELECTED_FILTER_CHIP_CLASS_NAME
                        : UNSELECTED_FILTER_CHIP_CLASS_NAME
                    }
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                aria-label={`Select all ${plural(selectableCount, "matching member", "matching members")}`}
                disabled={idsToSelect.length === 0}
                onClick={() =>
                  queueChange({
                    change: {
                      kind: "setMembers",
                      memberIds: idsToSelect,
                      attending: true,
                    },
                    description: `Selecting ${plural(idsToSelect.length, "member", "members")}`,
                  })
                }
                className={OUTLINE_BUTTON_CLASS_NAME}
              >
                Select all
              </button>
              <button
                type="button"
                aria-label={`Clear ${plural(attendingIds.length, "attending member", "attending members")} (guests stay)`}
                disabled={attendingIds.length === 0}
                onClick={() =>
                  queueChange({
                    change: {
                      kind: "setMembers",
                      memberIds: attendingIds,
                      attending: false,
                    },
                    description: `Clearing ${plural(attendingIds.length, "member", "members")}`,
                  })
                }
                className={OUTLINE_BUTTON_CLASS_NAME}
              >
                Clear
              </button>
            </div>
          </div>

          <p
            id={showingLineId}
            aria-live="polite"
            className="mb-2.5 text-sm text-muted tabular-nums"
          >
            {matchingRows.length === 0
              ? "No members match. Try another name or level."
              : `Showing ${visibleRows.length} of ${plural(
                  matchingRows.length,
                  isFiltering ? "matching member" : "member",
                  isFiltering ? "matching members" : "members",
                )}`}
          </p>
          {visibleRows.length > 0 && (
            <ul
              aria-labelledby="whos-playing-heading"
              className="grid grid-cols-[repeat(auto-fill,minmax(min(250px,100%),1fr))] gap-2"
            >
              {visibleRows.map((row) => (
                <li key={row.memberId}>
                  <MemberRowButton
                    row={row}
                    isPending={pendingMemberIds.has(row.memberId)}
                    onToggle={() => toggleMember(row)}
                  />
                </li>
              ))}
            </ul>
          )}
          {matchingRows.length > visibleRows.length && (
            <button
              type="button"
              onClick={() =>
                setVisibleRowCount(
                  (currentCount) => currentCount + MEMBER_DIRECTORY_PAGE_SIZE,
                )
              }
              className={`${OUTLINE_BUTTON_CLASS_NAME} mt-3`}
            >
              Show{" "}
              {Math.min(
                MEMBER_DIRECTORY_PAGE_SIZE,
                matchingRows.length - visibleRows.length,
              )}{" "}
              more
            </button>
          )}
        </>
      )}

      <div aria-live="polite" className="mt-3 flex flex-col gap-1 empty:hidden">
        {failures.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3">
            <AttentionMessage>
              {failures.length === 1
                ? `Not saved: ${failures[0].description}. ${failures[0].message}`
                : `${failures.length} changes not saved. ${failures.at(-1)!.message}`}
            </AttentionMessage>
            <button
              type="button"
              onClick={retryFailures}
              className={LINK_BUTTON_CLASS_NAME}
            >
              {failures.length === 1 ? "Retry" : "Retry all"}
            </button>
          </div>
        )}
        {refreshProblem && (
          <AttentionMessage>{refreshProblem}</AttentionMessage>
        )}
        {pendingChanges.length > 0 && (
          <p className="text-sm text-muted">Saving attendance…</p>
        )}
      </div>

      <QuickAddGuestBox
        form={guestForm}
        onFormChange={onGuestFormChange}
        guests={guests}
        pendingParticipantIds={pendingParticipantIds}
        onAddGuest={(guest) =>
          queueChange({
            change: {
              kind: "addGuest",
              participantId: crypto.randomUUID(),
              guest,
            },
            description: `Adding guest ${guest.firstName} ${guest.lastName}`,
          })
        }
        onRemoveGuest={(guest) =>
          queueChange({
            change: { kind: "removeGuest", participantId: guest.participantId },
            description: `Removing guest ${guest.firstName} ${guest.lastName}`,
          })
        }
      />
    </SetupSection>
  );
}

function MemberRowButton({
  row,
  isPending,
  onToggle,
}: {
  row: WhosPlayingMemberRow;
  isPending: boolean;
  onToggle: () => void;
}) {
  const fullName = `${row.firstName} ${row.lastName}`;
  const status = row.isAttending ? "Attending" : "Not attending";
  // Words, never colour alone; "Deactivated" first so it's never cut off.
  const caption = isPending
    ? "Saving…"
    : row.isActive
      ? status
      : `Deactivated · ${status}`;
  return (
    <button
      type="button"
      aria-pressed={row.isAttending}
      onClick={onToggle}
      className={`flex min-h-[60px] w-full items-center gap-2.5 rounded-2xl border px-3 py-2 text-left text-text ${
        row.isAttending
          ? "border-lime-edge bg-lime-surface"
          : "border-inner-border bg-inner hover:border-outline"
      } ${row.isActive ? "" : "border-dashed"}`}
    >
      <span
        aria-hidden="true"
        className={`flex size-[22px] shrink-0 items-center justify-center rounded-[7px] ${
          row.isAttending ? "bg-lime text-on-lime" : "border-2 border-outline"
        }`}
      >
        {row.isAttending && <CheckIcon sizePx={13} />}
      </span>
      <InitialsAvatar
        name={fullName}
        tone={row.isAttending ? "playing" : "notAttending"}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-semibold">{fullName}</span>
        <span
          className={`truncate text-xs ${row.isAttending ? "text-lime-status" : "text-muted"}`}
        >
          {caption}
        </span>
      </span>
      <SkillChip skillLevel={row.skillLevel} />
    </button>
  );
}
