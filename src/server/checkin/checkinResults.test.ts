// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkinDatabaseErrorKind,
  checkinPageFromRpc,
  nameMatchesFromRpc,
  submitCheckinOutcomeFromRpc,
} from "./checkinResults";

const MEMBER_ID = "a0000000-0000-4000-8000-000000000001";
const REQUEST_ID = "b0000000-0000-4000-8000-000000000001";

const openPageRpc = {
  status: "open",
  social_name: "Pickleball Riverside",
  session: {
    name: "Saturday Social",
    status: "draft",
    planned_start: "2026-11-07T18:00:00+00:00",
    planned_end: "2026-11-07T20:00:00+00:00",
    courts_count: 4,
    checked_in_count: 26,
  },
  recognised_member: {
    member_id: MEMBER_ID,
    first_name: "Grace",
    last_name: "Kim",
    skill_level: null,
  },
  current_request: {
    id: REQUEST_ID,
    status: "already_checked_in",
    first_name: "Grace",
    member_id: null,
  },
  now: "2026-11-07T17:54:12.345678+00:00",
};

describe("checkinPageFromRpc", () => {
  it("maps an open page, keeping the SQL's nullable fields nullable", () => {
    expect(checkinPageFromRpc(openPageRpc)).toEqual({
      status: "open",
      socialName: "Pickleball Riverside",
      session: {
        name: "Saturday Social",
        plannedStart: "2026-11-07T18:00:00+00:00",
        plannedEnd: "2026-11-07T20:00:00+00:00",
        courtsCount: 4,
        checkedInCount: 26,
      },
      recognisedMember: {
        memberId: MEMBER_ID,
        firstName: "Grace",
        lastName: "Kim",
        skillLevel: null,
      },
      currentRequest: {
        checkinRequestId: REQUEST_ID,
        status: "already_checked_in",
        firstName: "Grace",
        memberId: null,
      },
      now: "2026-11-07T17:54:12.345678+00:00",
    });
  });

  it("maps a page with no phone data", () => {
    expect(
      checkinPageFromRpc({
        ...openPageRpc,
        recognised_member: null,
        current_request: null,
      }),
    ).toMatchObject({ recognisedMember: null, currentRequest: null });
  });

  it("maps inactive (nothing else) and no open session", () => {
    expect(checkinPageFromRpc({ status: "inactive" })).toEqual({
      status: "inactive",
    });
    expect(
      checkinPageFromRpc({
        status: "no_open_session",
        social_name: "Pickleball Riverside",
      }),
    ).toEqual({
      status: "no_open_session",
      socialName: "Pickleball Riverside",
    });
  });

  it("fails fast on anything unexpected", () => {
    expect(() => checkinPageFromRpc(null)).toThrow();
    expect(() => checkinPageFromRpc({ status: "closed" })).toThrow();
    expect(() =>
      checkinPageFromRpc({ ...openPageRpc, now: "yesterday" }),
    ).toThrow();
  });
});

describe("nameMatchesFromRpc", () => {
  it("maps names and refuses more than 5", () => {
    const row = { member_id: MEMBER_ID, first_name: "Grace", last_name: "Kim" };
    expect(nameMatchesFromRpc([row])).toEqual([
      { memberId: MEMBER_ID, firstName: "Grace", lastName: "Kim" },
    ]);
    expect(() => nameMatchesFromRpc(Array(6).fill(row))).toThrow();
  });
});

describe("submitCheckinOutcomeFromRpc", () => {
  it("maps each reply", () => {
    expect(
      submitCheckinOutcomeFromRpc({
        status: "pending",
        checkin_request_id: REQUEST_ID,
        was_already_pending: true,
      }),
    ).toEqual({ status: "pending", checkinRequestId: REQUEST_ID });
    expect(
      submitCheckinOutcomeFromRpc({ status: "already_checked_in" }),
    ).toEqual({ status: "already_checked_in" });
    expect(submitCheckinOutcomeFromRpc({ status: "member_not_found" })).toEqual(
      { status: "member_not_found" },
    );
    expect(() => submitCheckinOutcomeFromRpc({ status: "approved" })).toThrow();
  });
});

describe("checkinDatabaseErrorKind", () => {
  it.each([
    ["RATE_LIMITED", "rate_limited"],
    ["NO_OPEN_SESSION", "no_open_session_or_unknown_tag"],
    ["INVALID_INPUT", "invalid_input"],
    ["INVALID_NAME", "invalid_input"],
    ["permission denied for function submit_checkin", "unexpected"],
    ["AbortError: The operation was aborted", "unexpected"],
  ] as const)("%s → %s", (message, kind) => {
    expect(checkinDatabaseErrorKind({ message })).toBe(kind);
  });
});
