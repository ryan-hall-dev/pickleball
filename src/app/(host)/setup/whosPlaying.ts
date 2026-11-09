// Pure helpers for the Setup screen's "Who's playing?" card: the member list
// (search, skill filter, paging), Select all / Clear, optimistic attendance
// changes and the guest form. No React here, so it's unit tested directly.
//
// The browser holds every active member (the club's directory has no size
// limit; 2,000 names is a small payload), so search is instant and "Select
// all" covers every match, not just the rows on screen. Search folds text the
// same way as `members.search_name` (normalizeMemberSearchText).
import type { ActiveMemberChoice } from "@/server/members/memberDirectory";
import {
  memberFullNameKey,
  memberInputSchema,
  type MemberInput,
} from "@/server/members/memberRules";
import {
  normalizeMemberSearchText,
  type SkillLevel,
} from "@/server/members/memberSearch";
import type { DraftParticipant } from "@/server/setup/setupDraft";

export interface WhosPlayingMemberRow {
  memberId: string;
  firstName: string;
  lastName: string;
  skillLevel: SkillLevel | null;
  /** False for a member deactivated after being marked as attending. */
  isActive: boolean;
  isAttending: boolean;
  /** The full name folded for search (as `members.search_name`). */
  searchKey: string;
}

export interface MemberRowFilter {
  searchText: string;
  /** Null = all levels. */
  skillLevel: SkillLevel | null;
}

/** One attendance write, applied optimistically until the server answers. */
export type AttendanceChange =
  | { kind: "setMembers"; memberIds: string[]; attending: boolean }
  | {
      kind: "addGuest";
      /** Chosen in the browser, so a retried add can't add the guest twice. */
      participantId: string;
      guest: MemberInput;
    }
  | { kind: "removeGuest"; participantId: string };

/** A change plus the words that describe it if it fails ("Adding Grace Kim"). */
export interface QueuedAttendanceChange {
  change: AttendanceChange;
  description: string;
}

export interface AttendanceFailure extends QueuedAttendanceChange {
  message: string;
}

export function attendingMemberIds(
  participants: readonly DraftParticipant[],
): Set<string> {
  return new Set(
    participants.flatMap((participant) =>
      !participant.isGuest && participant.memberId
        ? [participant.memberId]
        : [],
    ),
  );
}

export function guestParticipants(
  participants: readonly DraftParticipant[],
): DraftParticipant[] {
  return participants.filter((participant) => participant.isGuest);
}

/**
 * Every active member, plus anyone attending who isn't in that list (a member
 * deactivated after being added, so the host can still remove them; they
 * come first so they're seen). Names for those come from the attendee
 * snapshot.
 */
export function buildMemberRows(
  activeMembers: readonly ActiveMemberChoice[],
  participants: readonly DraftParticipant[],
): WhosPlayingMemberRow[] {
  const attendingIds = attendingMemberIds(participants);
  const activeMemberIds = new Set(activeMembers.map((member) => member.id));
  const attendingOutsideList: WhosPlayingMemberRow[] = participants.flatMap(
    (participant) =>
      !participant.isGuest &&
      participant.memberId &&
      !activeMemberIds.has(participant.memberId)
        ? [
            {
              memberId: participant.memberId,
              firstName: participant.firstName,
              lastName: participant.lastName,
              skillLevel: participant.skillLevel,
              // A member added in another tab since this page loaded is active.
              isActive: participant.isMemberActive === true,
              isAttending: true,
              searchKey: memberFullNameKey(participant),
            },
          ]
        : [],
  );
  const activeRows = activeMembers.map((member) => ({
    memberId: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    skillLevel: member.skillLevel,
    isActive: true,
    isAttending: attendingIds.has(member.id),
    searchKey: memberFullNameKey(member),
  }));
  return [...attendingOutsideList, ...activeRows];
}

/** Rows matching a "contains" name search and the skill filter. */
export function filterMemberRows(
  rows: readonly WhosPlayingMemberRow[],
  filter: MemberRowFilter,
): WhosPlayingMemberRow[] {
  const normalizedSearchText = normalizeMemberSearchText(filter.searchText);
  return rows.filter(
    (row) =>
      (filter.skillLevel === null || row.skillLevel === filter.skillLevel) &&
      (normalizedSearchText === "" ||
        row.searchKey.includes(normalizedSearchText)),
  );
}

/** "Select all": the matching members who can attend and aren't yet. */
export function memberIdsToSelect(
  matchingRows: readonly WhosPlayingMemberRow[],
): string[] {
  return matchingRows
    .filter((row) => row.isActive && !row.isAttending)
    .map((row) => row.memberId);
}

/** How many matching members "Select all" is about (active ones only). */
export function selectableMemberCount(
  matchingRows: readonly WhosPlayingMemberRow[],
): number {
  return matchingRows.filter((row) => row.isActive).length;
}

/**
 * The attendee list as it will be once `change` lands, so the screen updates
 * at once. Mirrors the database functions: only active members are added,
 * members already attending keep their row, and member changes never touch
 * guests.
 */
export function applyAttendanceChange(
  participants: readonly DraftParticipant[],
  change: AttendanceChange,
  activeMembersById: ReadonlyMap<string, ActiveMemberChoice>,
): DraftParticipant[] {
  switch (change.kind) {
    case "setMembers": {
      const changedIds = new Set(change.memberIds);
      if (!change.attending) {
        return participants.filter(
          (participant) =>
            participant.isGuest ||
            !participant.memberId ||
            !changedIds.has(participant.memberId),
        );
      }
      const alreadyAttending = attendingMemberIds(participants);
      const added: DraftParticipant[] = [...changedIds].flatMap((memberId) => {
        const member = activeMembersById.get(memberId);
        return member && !alreadyAttending.has(memberId)
          ? [
              {
                participantId: `pending-member-${memberId}`,
                memberId,
                isGuest: false,
                firstName: member.firstName,
                lastName: member.lastName,
                skillLevel: member.skillLevel,
                isMemberActive: true,
              },
            ]
          : [];
      });
      return [...participants, ...added];
    }
    case "addGuest":
      return [
        ...participants,
        {
          participantId: change.participantId,
          memberId: null,
          isGuest: true,
          firstName: change.guest.firstName,
          lastName: change.guest.lastName,
          skillLevel: change.guest.skillLevel,
          isMemberActive: null,
        },
      ];
    case "removeGuest":
      return participants.filter(
        (participant) =>
          !participant.isGuest ||
          participant.participantId !== change.participantId,
      );
  }
}

/** The member ids a change is still writing (their rows show "Saving…"). */
export function memberIdsInChanges(
  changes: readonly AttendanceChange[],
): Set<string> {
  return new Set(
    changes.flatMap((change) =>
      change.kind === "setMembers" ? change.memberIds : [],
    ),
  );
}

/** Who a change is about: "member:<id>" and "guest:<participant id>" keys. */
export function attendanceChangeKeys(change: AttendanceChange): string[] {
  return change.kind === "setMembers"
    ? change.memberIds.map((memberId) => `member:${memberId}`)
    : [`guest:${change.participantId}`];
}

function memberCountPhrase(count: number): string {
  return `${count} ${count === 1 ? "member" : "members"}`;
}

/**
 * The failed changes still worth retrying once `laterChange` is made: the
 * members or guest it touches are dropped from them (a failure left with
 * nothing is dropped), so Retry never undoes what the host did since.
 */
export function pruneFailuresTouchedBy(
  failures: readonly AttendanceFailure[],
  laterChange: AttendanceChange,
): AttendanceFailure[] {
  const touchedKeys = new Set(attendanceChangeKeys(laterChange));
  return failures.flatMap((failure) => {
    const { change } = failure;
    if (change.kind !== "setMembers") {
      return attendanceChangeKeys(change).some((key) => touchedKeys.has(key))
        ? []
        : [failure];
    }
    const remainingMemberIds = change.memberIds.filter(
      (memberId) => !touchedKeys.has(`member:${memberId}`),
    );
    if (remainingMemberIds.length === change.memberIds.length) return [failure];
    if (remainingMemberIds.length === 0) return [];
    return [
      {
        ...failure,
        change: { ...change, memberIds: remainingMemberIds },
        description: `${change.attending ? "Adding" : "Removing"} ${memberCountPhrase(remainingMemberIds.length)}`,
      },
    ];
  });
}

export interface GuestForm {
  firstName: string;
  lastName: string;
  /** "" = not set. */
  skillLevel: string;
}

export const EMPTY_GUEST_FORM: GuestForm = {
  firstName: "",
  lastName: "",
  skillLevel: "",
};

export type GuestFormErrors = Partial<Record<keyof GuestForm, string>>;

export type GuestFormValidation =
  | { ok: true; guest: MemberInput }
  | { ok: false; fieldErrors: GuestFormErrors };

/** The guest form under the same rules as a member (first and last name required). */
export function validateGuestForm(form: GuestForm): GuestFormValidation {
  const parsed = memberInputSchema.safeParse(form);
  if (parsed.success) return { ok: true, guest: parsed.data };
  const fieldErrors: GuestFormErrors = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0]) as keyof GuestForm;
    fieldErrors[field] ??= issue.message;
  }
  return { ok: false, fieldErrors };
}
