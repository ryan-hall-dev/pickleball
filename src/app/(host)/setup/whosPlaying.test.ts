// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ActiveMemberChoice } from "@/server/members/memberDirectory";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import {
  applyAttendanceChange,
  buildMemberRows,
  filterMemberRows,
  memberIdsInChanges,
  memberIdsToSelect,
  pruneFailuresTouchedBy,
  selectableMemberCount,
  validateGuestForm,
  type AttendanceFailure,
} from "./whosPlaying";

function member(
  id: string,
  firstName: string,
  lastName: string,
  skillLevel: ActiveMemberChoice["skillLevel"] = null,
): ActiveMemberChoice {
  return {
    id,
    firstName,
    lastName,
    skillLevel,
  };
}

const grace = member("m-grace", "Grace", "Kim", "advanced");
const elodie = member("m-elodie", "Élodie", "Durand", "beginner");
const kofi = member("m-kofi", "Kofi", "Mensah");
const activeMembers = [elodie, grace, kofi];
const activeMembersById = new Map(
  activeMembers.map((entry) => [entry.id, entry]),
);

function attendingMember(
  memberId: string,
  overrides: Partial<DraftParticipant> = {},
): DraftParticipant {
  return {
    participantId: `p-${memberId}`,
    memberId,
    isGuest: false,
    firstName: "Snap",
    lastName: "Shot",
    skillLevel: null,
    isMemberActive: true,
    ...overrides,
  };
}

const guestKai: DraftParticipant = {
  participantId: "p-kai",
  memberId: null,
  isGuest: true,
  firstName: "Kai",
  lastName: "Lee",
  skillLevel: "intermediate",
  isMemberActive: null,
};

describe("buildMemberRows", () => {
  it("lists every active member and marks who is attending", () => {
    const rows = buildMemberRows(activeMembers, [
      attendingMember("m-grace"),
      guestKai,
    ]);
    expect(
      rows.map((row) => [row.firstName, row.isAttending, row.isActive]),
    ).toEqual([
      ["Élodie", false, true],
      ["Grace", true, true],
      ["Kofi", false, true],
    ]);
  });

  it("keeps a deactivated member who is still attending, first, from the snapshot", () => {
    const rows = buildMemberRows(activeMembers, [
      attendingMember("m-gone", {
        firstName: "Ina",
        lastName: "Gone",
        isMemberActive: false,
      }),
    ]);
    expect(rows[0]).toMatchObject({
      memberId: "m-gone",
      firstName: "Ina",
      isActive: false,
      isAttending: true,
    });
    expect(rows).toHaveLength(4);
  });

  it("treats a member added in another tab since the page loaded as active", () => {
    const [row] = buildMemberRows(
      [],
      [attendingMember("m-new", { isMemberActive: true })],
    );
    expect(row).toMatchObject({ isActive: true, isAttending: true });
  });

  it("is empty for a club with no members", () => {
    expect(buildMemberRows([], [guestKai])).toEqual([]);
  });
});

describe("filterMemberRows", () => {
  const rows = buildMemberRows(activeMembers, []);
  const names = (filtered: typeof rows) => filtered.map((row) => row.firstName);

  it("matches any part of the full name, ignoring case, accents and spacing", () => {
    expect(
      names(filterMemberRows(rows, { searchText: "elo", skillLevel: null })),
    ).toEqual(["Élodie"]);
    expect(
      names(filterMemberRows(rows, { searchText: "  KIM ", skillLevel: null })),
    ).toEqual(["Grace"]);
    expect(
      names(
        filterMemberRows(rows, { searchText: "elodie   d", skillLevel: null }),
      ),
    ).toEqual(["Élodie"]);
    expect(
      filterMemberRows(rows, { searchText: "zzz", skillLevel: null }),
    ).toEqual([]);
  });

  it("filters by skill; members without a level only show under All", () => {
    expect(
      names(filterMemberRows(rows, { searchText: "", skillLevel: "advanced" })),
    ).toEqual(["Grace"]);
    expect(
      names(filterMemberRows(rows, { searchText: "", skillLevel: null })),
    ).toEqual(["Élodie", "Grace", "Kofi"]);
  });

  it("combines search and skill", () => {
    expect(
      filterMemberRows(rows, { searchText: "grace", skillLevel: "beginner" }),
    ).toEqual([]);
  });

  it("handles a large club", () => {
    const manyMembers = Array.from({ length: 2000 }, (_, index) =>
      member(`m-${index}`, `Player${index}`, "Test"),
    );
    const manyRows = buildMemberRows(manyMembers, []);
    expect(
      filterMemberRows(manyRows, { searchText: "player19", skillLevel: null }),
    ).toHaveLength(111);
  });
});

describe("Select all", () => {
  it("selects only the matching members who aren't attending yet, never deactivated ones", () => {
    const rows = buildMemberRows(activeMembers, [
      attendingMember("m-grace"),
      attendingMember("m-gone", { isMemberActive: false }),
    ]);
    expect(memberIdsToSelect(rows)).toEqual(["m-elodie", "m-kofi"]);
    expect(selectableMemberCount(rows)).toBe(3);
    const advancedOnly = filterMemberRows(rows, {
      searchText: "",
      skillLevel: "advanced",
    });
    expect(memberIdsToSelect(advancedOnly)).toEqual([]);
  });
});

describe("applyAttendanceChange", () => {
  it("adds active members once, from the directory, and skips unknown ids", () => {
    const after = applyAttendanceChange(
      [attendingMember("m-grace")],
      {
        kind: "setMembers",
        memberIds: ["m-grace", "m-kofi", "m-unknown"],
        attending: true,
      },
      activeMembersById,
    );
    expect(after.map((participant) => participant.memberId)).toEqual([
      "m-grace",
      "m-kofi",
    ]);
    expect(after[1]).toMatchObject({ firstName: "Kofi", isGuest: false });
  });

  it("removes members but never guests", () => {
    const after = applyAttendanceChange(
      [attendingMember("m-grace"), attendingMember("m-kofi"), guestKai],
      {
        kind: "setMembers",
        memberIds: ["m-grace", "m-kofi"],
        attending: false,
      },
      activeMembersById,
    );
    expect(after).toEqual([guestKai]);
  });

  it("adds and removes guests", () => {
    const added = applyAttendanceChange(
      [guestKai],
      {
        kind: "addGuest",
        participantId: "pending-1",
        guest: { firstName: "Kai", lastName: "Lee", skillLevel: null },
      },
      activeMembersById,
    );
    // Same name is fine: guests are told apart by id.
    expect(added.map((participant) => participant.participantId)).toEqual([
      "p-kai",
      "pending-1",
    ]);
    expect(
      applyAttendanceChange(
        added,
        { kind: "removeGuest", participantId: "p-kai" },
        activeMembersById,
      ).map((participant) => participant.participantId),
    ).toEqual(["pending-1"]);
  });

  it("lists the member ids a change is still writing", () => {
    expect(
      memberIdsInChanges([
        { kind: "setMembers", memberIds: ["m-grace"], attending: true },
        { kind: "removeGuest", participantId: "p-kai" },
      ]),
    ).toEqual(new Set(["m-grace"]));
  });
});

describe("validateGuestForm", () => {
  it("accepts first and last name with an optional skill, tidying spaces", () => {
    expect(
      validateGuestForm({
        firstName: "  Kai ",
        lastName: "Lee   Jr",
        skillLevel: "",
      }),
    ).toEqual({
      ok: true,
      guest: { firstName: "Kai", lastName: "Lee Jr", skillLevel: null },
    });
    expect(
      validateGuestForm({
        firstName: "Kai",
        lastName: "Lee",
        skillLevel: "advanced",
      }),
    ).toMatchObject({ ok: true, guest: { skillLevel: "advanced" } });
  });

  it("requires both names", () => {
    expect(
      validateGuestForm({ firstName: " ", lastName: "", skillLevel: "" }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        firstName: "Enter a first name.",
        lastName: "Enter a last name.",
      },
    });
  });

  it("refuses names that are too long and unknown levels", () => {
    expect(
      validateGuestForm({
        firstName: "K".repeat(51),
        lastName: "Lee",
        skillLevel: "pro",
      }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        firstName: "Use at most 50 characters.",
        skillLevel: "Choose a skill level from the list.",
      },
    });
  });
});

describe("pruneFailuresTouchedBy", () => {
  const failed = (
    change: AttendanceFailure["change"],
    description: string,
  ): AttendanceFailure => ({ change, description, message: "Offline" });
  const selectThree = failed(
    {
      kind: "setMembers",
      memberIds: ["m-grace", "m-kofi", "m-elodie"],
      attending: true,
    },
    "Selecting 3 members",
  );
  const addKai = failed(
    {
      kind: "addGuest",
      participantId: "p-kai",
      guest: { firstName: "Kai", lastName: "Lee", skillLevel: null },
    },
    "Adding guest Kai Lee",
  );

  it("keeps failures the later change doesn't touch", () => {
    expect(
      pruneFailuresTouchedBy([selectThree, addKai], {
        kind: "removeGuest",
        participantId: "p-other",
      }),
    ).toEqual([selectThree, addKai]);
  });

  it("drops the members a later change touches, and rewords what's left", () => {
    expect(
      pruneFailuresTouchedBy([selectThree], {
        kind: "setMembers",
        memberIds: ["m-grace", "m-kofi"],
        attending: false,
      }),
    ).toEqual([
      {
        ...selectThree,
        change: { ...selectThree.change, memberIds: ["m-elodie"] },
        description: "Adding 1 member",
      },
    ]);
  });

  it("drops a failure once nothing in it is left to retry", () => {
    expect(
      pruneFailuresTouchedBy([selectThree, addKai], {
        kind: "setMembers",
        memberIds: ["m-grace", "m-kofi", "m-elodie"],
        attending: true,
      }),
    ).toEqual([addKai]);
    expect(
      pruneFailuresTouchedBy([addKai], {
        kind: "removeGuest",
        participantId: "p-kai",
      }),
    ).toEqual([]);
  });
});
