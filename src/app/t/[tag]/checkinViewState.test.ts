// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  CurrentCheckinRequest,
  OpenCheckinPage,
  ReadCheckinPageResult,
} from "@/server/checkin/checkinResults";
import { checkinReducer, initialCheckinState } from "./checkinViewState";

const requestId = "b0000000-0000-4000-8000-000000000001";
const page: OpenCheckinPage = {
  status: "open",
  socialName: "Riverside",
  session: {
    sessionId: "a0000000-0000-4000-8000-000000000001",
    name: "Saturday",
    plannedStart: "2026-11-15T10:00:00Z",
    plannedEnd: "2026-11-15T12:00:00Z",
    courtsCount: 2,
    checkedInCount: 0,
  },
  now: "2026-11-15T09:00:00Z",
  currentRequest: null,
};
function read(
  currentRequest: CurrentCheckinRequest | null = null,
): ReadCheckinPageResult {
  return { ok: true, page: { ...page, currentRequest } };
}
function request(
  status: CurrentCheckinRequest["status"],
): CurrentCheckinRequest {
  return { checkinRequestId: requestId, status, firstName: "Kai" };
}
const values = {
  firstName: "Kai",
  lastName: "Moreno",
  skillLevel: "advanced" as const,
  gender: "male" as const,
};

describe("session-only check-in state", () => {
  it("starts with an empty required form", () => {
    expect(initialCheckinState(read())).toMatchObject({
      screen: "welcome",
      formValues: {
        firstName: "",
        lastName: "",
        skillLevel: null,
        gender: null,
      },
      requester: null,
    });
  });
  it.each([
    ["pending", "waiting"],
    ["approved", "approved"],
    ["rejected", "rejected"],
    ["withdrawn", "welcome"],
  ] as const)("restores %s on reload", (status, screen) => {
    expect(initialCheckinState(read(request(status))).screen).toBe(screen);
  });
  it("keeps entered details across a failed submit and retry", () => {
    let state = checkinReducer(initialCheckinState(read()), {
      type: "form_changed",
      values,
    });
    state = checkinReducer(state, { type: "submit_started" });
    expect(state.isBusy).toBe(true);
    state = checkinReducer(state, {
      type: "submit_finished",
      submittedName: values,
      result: { ok: false, failure: "unavailable" },
    });
    expect(state).toMatchObject({ screen: "unavailable", isBusy: false });
    state = checkinReducer(state, { type: "page_read", result: read() });
    expect(state).toMatchObject({ screen: "welcome", formValues: values });
  });
  it("recovers a lost submit answer from the phone's pending request", () => {
    let state = initialCheckinState(read());
    state = checkinReducer(state, {
      type: "submit_finished",
      submittedName: values,
      result: { ok: false, failure: "unavailable" },
    });
    state = checkinReducer(state, {
      type: "page_read",
      result: read(request("pending")),
    });
    expect(state).toMatchObject({
      screen: "waiting",
      requester: { checkinRequestId: requestId },
    });
  });
  it("polling approval keeps the full name of the same request", () => {
    let state = checkinReducer(initialCheckinState(read()), {
      type: "submit_finished",
      submittedName: values,
      result: {
        ok: true,
        outcome: { status: "pending", checkinRequestId: requestId },
      },
    });
    state = checkinReducer(state, {
      type: "page_read",
      result: read(request("approved")),
    });
    expect(state).toMatchObject({
      screen: "approved",
      requester: { displayName: "Kai Moreno" },
      formValues: {
        firstName: "",
        lastName: "",
        skillLevel: null,
        gender: null,
      },
    });
  });
  it("rejection retry clears all details for a fresh request", () => {
    const state = checkinReducer(
      initialCheckinState(read(request("rejected"))),
      { type: "try_again_after_rejection" },
    );
    expect(state).toMatchObject({
      screen: "welcome",
      requester: null,
      formValues: {
        firstName: "",
        lastName: "",
        skillLevel: null,
        gender: null,
      },
    });
  });
  it("shows already checked in only for the own-phone outcome", () => {
    expect(
      checkinReducer(initialCheckinState(read()), {
        type: "submit_finished",
        submittedName: values,
        result: { ok: true, outcome: { status: "already_checked_in" } },
      }).screen,
    ).toBe("already_checked_in_own_phone");
  });
  it("shows server field errors without losing input", () => {
    const state = checkinReducer(
      { ...initialCheckinState(read()), formValues: values, isBusy: true },
      {
        type: "submit_finished",
        submittedName: values,
        result: {
          ok: false,
          failure: "invalid_input",
          fieldErrors: { skillLevel: "Choose your level" },
        },
      },
    );
    expect(state).toMatchObject({
      screen: "welcome",
      isBusy: false,
      formValues: values,
      fieldErrors: { skillLevel: "Choose your level" },
    });
  });
  it.each([
    "rate_limited",
    "inactive",
    "no_open_session",
    "unavailable",
  ] as const)("maps %s failures", (failure) => {
    expect(
      checkinReducer(initialCheckinState(read()), {
        type: "submit_finished",
        submittedName: values,
        result: { ok: false, failure },
      }).screen,
    ).toBe(failure);
  });
  it("ignores failed header refreshes and preserves entered details", () => {
    const state = { ...initialCheckinState(read()), formValues: values };
    expect(
      checkinReducer(state, {
        type: "header_refreshed",
        result: { ok: false, failure: "unavailable" },
      }),
    ).toBe(state);
    expect(
      checkinReducer(state, { type: "header_refreshed", result: read() })
        .formValues,
    ).toEqual(values);
  });
  it("handles inactive and closed sessions without retaining open page details", () => {
    expect(
      initialCheckinState({ ok: true, page: { status: "inactive" } }),
    ).toMatchObject({ screen: "inactive", openPage: null, socialName: null });
    expect(
      initialCheckinState({
        ok: true,
        page: { status: "no_open_session", socialName: "Riverside" },
      }),
    ).toMatchObject({
      screen: "no_open_session",
      openPage: null,
      socialName: "Riverside",
    });
  });
});

it("a new session on the same page clears entered details", () => {
  const state = { ...initialCheckinState(read()), formValues: values };
  const next = checkinReducer(state, {
    type: "header_refreshed",
    result: {
      ok: true,
      page: {
        ...page,
        session: {
          ...page.session,
          sessionId: "a0000000-0000-4000-8000-000000000002",
        },
      },
    },
  });
  expect(next).toMatchObject({
    screen: "welcome",
    formValues: { firstName: "", lastName: "", skillLevel: null, gender: null },
  });
});

it("a session-changed submit clears details before a fresh page read", () => {
  const state = { ...initialCheckinState(read()), formValues: values };
  const clearing = checkinReducer(state, { type: "session_changed" });
  expect(clearing).toMatchObject({
    isBusy: true,
    formValues: { firstName: "", lastName: "", skillLevel: null, gender: null },
    requester: null,
  });
  const next = checkinReducer(clearing, { type: "page_read", result: read() });
  expect(next).toMatchObject({
    screen: "welcome",
    isBusy: false,
    formValues: { firstName: "", lastName: "", skillLevel: null, gender: null },
  });
});

it.each(["no_open_session", "inactive"] as const)(
  "clears A details across an intervening %s before B opens",
  (status) => {
    const state = {
      ...initialCheckinState(read()),
      formValues: values,
      fieldErrors: { firstName: "Old error" },
      requester: {
        checkinRequestId: requestId,
        firstName: "Kai",
        displayName: "Kai Moreno",
      },
    };
    const closed = checkinReducer(state, {
      type: "header_refreshed",
      result: {
        ok: true,
        page:
          status === "inactive"
            ? { status }
            : { status, socialName: "Riverside" },
      },
    });
    expect(closed).toMatchObject({
      openPage: null,
      formValues: {
        firstName: "",
        lastName: "",
        skillLevel: null,
        gender: null,
      },
      fieldErrors: {},
      requester: null,
    });
    const reopened = checkinReducer(closed, {
      type: "page_read",
      result: {
        ok: true,
        page: {
          ...page,
          session: {
            ...page.session,
            sessionId: "a0000000-0000-4000-8000-000000000002",
          },
        },
      },
    });
    expect(reopened).toMatchObject({
      screen: "welcome",
      formValues: {
        firstName: "",
        lastName: "",
        skillLevel: null,
        gender: null,
      },
      fieldErrors: {},
      requester: null,
    });
  },
);

it("SESSION_CHANGED clears all four submitted fields before any refreshed session", () => {
  const state = { ...initialCheckinState(read()), formValues: values };
  const next = checkinReducer(state, {
    type: "submit_finished",
    submittedName: values,
    result: { ok: false, failure: "session_changed" },
  });
  expect(next.formValues).toEqual({
    firstName: "",
    lastName: "",
    skillLevel: null,
    gender: null,
  });
  expect(next.requester).toBeNull();
});
