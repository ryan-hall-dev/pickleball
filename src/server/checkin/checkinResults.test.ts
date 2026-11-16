// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkinDatabaseErrorKind,
  checkinPageFromRpc,
  submitCheckinOutcomeFromRpc,
} from "./checkinResults";

const REQUEST_ID = "b0000000-0000-4000-8000-000000000001";

const openPageRpc = {
  status: "open",
  social_name: "Pickleball Riverside",
  session: {
    id: "a0000000-0000-4000-8000-000000000001",
    name: "Saturday Social",
    status: "draft",
    duration_minutes: 120,
    started_at: null,
    ends_at: null,
    planned_start: "2026-11-07T18:00:00+00:00",
    planned_end: "2026-11-07T20:00:00+00:00",
    courts_count: 4,
    checked_in_count: 26,
  },
  current_request: {
    id: REQUEST_ID,
    status: "approved",
    first_name: "Grace",
  },
  now: "2026-11-07T17:54:12.345678+00:00",
};

describe("checkinPageFromRpc", () => {
  it("maps an open page (no recognised member since session-only participants)", () => {
    expect(checkinPageFromRpc(openPageRpc)).toEqual({
      status: "open",
      socialName: "Pickleball Riverside",
      session: {
        sessionId: "a0000000-0000-4000-8000-000000000001",
        name: "Saturday Social",
        status: "draft",
        durationMinutes: 120,
        startedAt: null,
        endsAt: null,
        plannedStart: "2026-11-07T18:00:00+00:00",
        plannedEnd: "2026-11-07T20:00:00+00:00",
        courtsCount: 4,
        checkedInCount: 26,
      },
      currentRequest: {
        checkinRequestId: REQUEST_ID,
        status: "approved",
        firstName: "Grace",
      },
      now: "2026-11-07T17:54:12.345678+00:00",
    });
  });

  it("keeps actual live clocks separate from draft placeholders", () => {
    expect(
      checkinPageFromRpc({
        ...openPageRpc,
        session: {
          ...openPageRpc.session,
          status: "live",
          duration_minutes: 75,
          started_at: "2026-11-15T15:00:00Z",
          ends_at: "2026-11-15T16:15:00Z",
        },
      }),
    ).toMatchObject({
      session: {
        status: "live",
        durationMinutes: 75,
        startedAt: "2026-11-15T15:00:00Z",
        endsAt: "2026-11-15T16:15:00Z",
        plannedStart: openPageRpc.session.planned_start,
      },
    });
  });

  it("accepts a null duration (unusable saved duration) without inventing timing", () => {
    const draft = checkinPageFromRpc({
      ...openPageRpc,
      session: { ...openPageRpc.session, duration_minutes: null },
    });
    expect(draft.status === "open" && draft.session.durationMinutes).toBeNull();
    const live = checkinPageFromRpc({
      ...openPageRpc,
      session: {
        ...openPageRpc.session,
        status: "live",
        duration_minutes: null,
        started_at: "2026-11-15T15:00:00Z",
        ends_at: null,
      },
    });
    expect(live.status === "open" && live.session).toMatchObject({
      durationMinutes: null,
      startedAt: "2026-11-15T15:00:00Z",
      endsAt: null,
    });
  });
  it("fails explicitly when lifecycle metadata is missing or malformed", () => {
    expect(() =>
      checkinPageFromRpc({
        ...openPageRpc,
        session: { ...openPageRpc.session, duration_minutes: 0 },
      }),
    ).toThrow();
    expect(() =>
      checkinPageFromRpc({
        ...openPageRpc,
        session: { ...openPageRpc.session, status: undefined },
      }),
    ).toThrow();
    expect(() =>
      checkinPageFromRpc({
        ...openPageRpc,
        session: { ...openPageRpc.session, ends_at: "invalid" },
      }),
    ).toThrow();
  });

  it("maps a page with no phone data", () => {
    expect(
      checkinPageFromRpc({
        ...openPageRpc,
        current_request: null,
      }),
    ).toMatchObject({ currentRequest: null });
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
    // The database no longer answers member_not_found.
    expect(() =>
      submitCheckinOutcomeFromRpc({ status: "member_not_found" }),
    ).toThrow();
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
