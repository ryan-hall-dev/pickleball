// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  CheckinPage,
  CurrentCheckinRequest,
  NameMatch,
  OpenCheckinPage,
  ReadCheckinPageResult,
} from "@/server/checkin/checkinResults";
import {
  checkinReducer,
  initialCheckinState,
  type CheckinAction,
  type CheckinCandidate,
  type CheckinState,
} from "./checkinViewState";

const GRACE_ID = "a0000000-0000-4000-8000-000000000001";
const PETER_ID = "a0000000-0000-4000-8000-000000000002";
const REQUEST_ID = "b0000000-0000-4000-8000-000000000001";
const OTHER_REQUEST_ID = "b0000000-0000-4000-8000-000000000002";

function openPage(overrides: Partial<OpenCheckinPage> = {}): OpenCheckinPage {
  return {
    status: "open",
    socialName: "Pickleball Riverside",
    session: {
      name: "Saturday Social",
      plannedStart: "2026-11-07T18:00:00Z",
      plannedEnd: "2026-11-07T20:00:00Z",
      courtsCount: 4,
      checkedInCount: 26,
    },
    recognisedMember: null,
    currentRequest: null,
    now: "2026-11-07T17:54:00Z",
    ...overrides,
  };
}

const graceRecognised = {
  memberId: GRACE_ID,
  firstName: "Grace",
  lastName: "Kim",
  skillLevel: "beginner" as const,
};

function request(
  status: CurrentCheckinRequest["status"],
  overrides: Partial<CurrentCheckinRequest> = {},
): CurrentCheckinRequest {
  return {
    checkinRequestId: REQUEST_ID,
    status,
    firstName: "Grace",
    memberId: GRACE_ID,
    ...overrides,
  };
}

function read(page: CheckinPage): ReadCheckinPageResult {
  return { ok: true, page };
}

function reduceAll(state: CheckinState, actions: CheckinAction[]) {
  return actions.reduce(checkinReducer, state);
}

const peterFromSearch: CheckinCandidate = {
  memberId: PETER_ID,
  firstName: "Peter",
  lastName: "Lindqvist",
  source: "search",
};

describe("the first screen comes from the page read", () => {
  it("shows the welcome for a new phone (P02) and a recognised phone (P01)", () => {
    const newPhone = initialCheckinState(read(openPage()));
    expect(newPhone.screen).toBe("welcome");
    expect(newPhone.socialName).toBe("Pickleball Riverside");
    expect(newPhone.openPage?.recognisedMember).toBeNull();

    const recognised = initialCheckinState(
      read(openPage({ recognisedMember: graceRecognised })),
    );
    expect(recognised.screen).toBe("welcome");
    expect(recognised.openPage?.recognisedMember).toEqual(graceRecognised);
  });

  it.each([
    ["pending", "waiting"],
    ["approved", "approved"],
    ["rejected", "rejected"],
    ["already_checked_in", "already_checked_in_host_confirmed"],
    ["withdrawn", "welcome"],
  ] as const)(
    "a current request that is %s shows %s (a reload returns to it)",
    (status, screen) => {
      const state = initialCheckinState(
        read(openPage({ currentRequest: request(status) })),
      );
      expect(state.screen).toBe(screen);
    },
  );

  it("shows P11 for an inactive link, without any social name", () => {
    const state = initialCheckinState(read({ status: "inactive" }));
    expect(state).toMatchObject({
      screen: "inactive",
      socialName: null,
      openPage: null,
    });
  });

  it("shows P12 when nothing is open, with the social's name", () => {
    const state = initialCheckinState(
      read({ status: "no_open_session", socialName: "Pickleball Riverside" }),
    );
    expect(state).toMatchObject({
      screen: "no_open_session",
      socialName: "Pickleball Riverside",
    });
  });

  it("shows P13 when the page can't be read", () => {
    const state = initialCheckinState({ ok: false, failure: "unavailable" });
    expect(state.screen).toBe("unavailable");
  });

  it("names a reloaded request by its first name, or in full for the phone's own member", () => {
    const pickedFromSearch = initialCheckinState(
      read(
        openPage({
          currentRequest: request("pending", {
            firstName: "Peter",
            memberId: PETER_ID,
          }),
        }),
      ),
    );
    expect(pickedFromSearch.requester).toEqual({
      checkinRequestId: REQUEST_ID,
      firstName: "Peter",
      displayName: "Peter",
    });

    const ownMember = initialCheckinState(
      read(
        openPage({
          recognisedMember: graceRecognised,
          currentRequest: request("approved"),
        }),
      ),
    );
    expect(ownMember.requester?.displayName).toBe("Grace Kim");
  });
});

describe("search (P03)", () => {
  const welcome = initialCheckinState(read(openPage()));
  const matches: NameMatch[] = [
    { memberId: PETER_ID, firstName: "Peter", lastName: "Lindqvist" },
  ];

  it("keeps nothing listed before 2 letters", () => {
    const state = reduceAll(welcome, [
      { type: "search_query_changed", query: "Pe" },
      {
        type: "search_finished",
        query: "Pe",
        result: { ok: true, matches },
      },
      { type: "search_query_changed", query: "P" },
    ]);
    expect(state.search).toEqual({
      query: "P",
      matches: null,
      matchesQuery: "",
    });
  });

  it("shows the answer for the current query and drops a slower, older one", () => {
    const state = reduceAll(welcome, [
      { type: "search_query_changed", query: "Pe" },
      { type: "search_query_changed", query: "Pet" },
      {
        type: "search_finished",
        query: "Pet",
        result: { ok: true, matches },
      },
      {
        type: "search_finished",
        query: "Pe",
        result: { ok: true, matches: [] },
      },
    ]);
    expect(state.search).toEqual({
      query: "Pet",
      matches,
      matchesQuery: "Pet",
    });
  });

  it("keeps the last results while a longer query is on its way", () => {
    const state = reduceAll(welcome, [
      { type: "search_query_changed", query: "Pe" },
      { type: "search_finished", query: "Pe", result: { ok: true, matches } },
      { type: "search_query_changed", query: "Pet" },
    ]);
    expect(state.search).toEqual({ query: "Pet", matches, matchesQuery: "Pe" });
  });

  it.each([
    ["rate_limited", "rate_limited"],
    ["inactive", "inactive"],
    ["no_open_session", "no_open_session"],
    ["unavailable", "unavailable"],
  ] as const)("a search failure %s shows %s", (failure, screen) => {
    const state = reduceAll(welcome, [
      { type: "search_query_changed", query: "Pe" },
      { type: "search_finished", query: "Pe", result: { ok: false, failure } },
    ]);
    expect(state.screen).toBe(screen);
  });
});

describe("confirm sheet (P04)", () => {
  const welcome = initialCheckinState(read(openPage()));

  it("opens with nothing preselected and the level picker collapsed", () => {
    const state = checkinReducer(welcome, {
      type: "confirm_opened",
      candidate: peterFromSearch,
    });
    expect(state.confirm).toEqual({
      candidate: peterFromSearch,
      isLevelPickerOpen: false,
      updatedSkillLevel: null,
    });
  });

  it("toggles the picker, and tapping the selected level again clears it", () => {
    const opened = reduceAll(welcome, [
      { type: "confirm_opened", candidate: peterFromSearch },
      { type: "level_picker_toggled" },
      { type: "level_pressed", skillLevel: "intermediate" },
    ]);
    expect(opened.confirm).toMatchObject({
      isLevelPickerOpen: true,
      updatedSkillLevel: "intermediate",
    });
    expect(
      checkinReducer(opened, { type: "level_pressed", skillLevel: "advanced" })
        .confirm?.updatedSkillLevel,
    ).toBe("advanced");
    expect(
      checkinReducer(opened, {
        type: "level_pressed",
        skillLevel: "intermediate",
      }).confirm?.updatedSkillLevel,
    ).toBeNull();
  });

  it("closes with Back, but not while the check-in is being sent", () => {
    const opened = checkinReducer(welcome, {
      type: "confirm_opened",
      candidate: peterFromSearch,
    });
    expect(
      checkinReducer(opened, { type: "confirm_closed" }).confirm,
    ).toBeNull();
    const sending = checkinReducer(opened, { type: "submit_started" });
    expect(
      checkinReducer(sending, { type: "confirm_closed" }).confirm,
    ).not.toBeNull();
  });
});

describe("submitting", () => {
  const sending = reduceAll(initialCheckinState(read(openPage())), [
    { type: "confirm_opened", candidate: peterFromSearch },
    { type: "submit_started" },
  ]);
  const peterName = { firstName: "Peter", lastName: "Lindqvist" };

  it("goes to Waiting (P06) with the full name", () => {
    const state = checkinReducer(sending, {
      type: "submit_finished",
      submittedName: peterName,
      result: {
        ok: true,
        outcome: { status: "pending", checkinRequestId: REQUEST_ID },
      },
    });
    expect(state).toMatchObject({
      screen: "waiting",
      confirm: null,
      isBusy: false,
      requester: {
        checkinRequestId: REQUEST_ID,
        firstName: "Peter",
        displayName: "Peter Lindqvist",
      },
    });
  });

  it("goes to Already checked in (P09) on the member's own phone", () => {
    const state = checkinReducer(sending, {
      type: "submit_finished",
      submittedName: peterName,
      result: { ok: true, outcome: { status: "already_checked_in" } },
    });
    expect(state.screen).toBe("already_checked_in_own_phone");
    expect(state.requester).toEqual({
      checkinRequestId: null,
      firstName: "Peter",
      displayName: "Peter Lindqvist",
    });
  });

  it("shows P13 when the member was deactivated since the search", () => {
    const state = checkinReducer(sending, {
      type: "submit_finished",
      submittedName: peterName,
      result: { ok: true, outcome: { status: "member_not_found" } },
    });
    expect(state.screen).toBe("unavailable");
  });

  it.each([
    ["rate_limited", "rate_limited"],
    ["inactive", "inactive"],
    ["no_open_session", "no_open_session"],
    ["unavailable", "unavailable"],
  ] as const)("a submit failure %s shows %s", (failure, screen) => {
    const state = checkinReducer(sending, {
      type: "submit_finished",
      submittedName: peterName,
      result: { ok: false, failure },
    });
    expect(state).toMatchObject({ screen, confirm: null, isBusy: false });
  });

  it("keeps the guest form open with the server's field errors", () => {
    const guestForm = reduceAll(initialCheckinState(read(openPage())), [
      { type: "guest_form_opened" },
      { type: "submit_started" },
      {
        type: "submit_finished",
        submittedName: { firstName: "Kai", lastName: "" },
        result: {
          ok: false,
          failure: "invalid_input",
          fieldErrors: { lastName: "Enter your last name" },
        },
      },
    ]);
    expect(guestForm).toMatchObject({
      screen: "guest_form",
      isBusy: false,
      guestFieldErrors: { lastName: "Enter your last name" },
    });
  });
});

describe("guest form (P05)", () => {
  it("opens from the welcome and goes back to it", () => {
    const welcome = initialCheckinState(read(openPage()));
    const guestForm = checkinReducer(welcome, { type: "guest_form_opened" });
    expect(guestForm.screen).toBe("guest_form");
    expect(
      checkinReducer(guestForm, { type: "guest_form_closed" }).screen,
    ).toBe("welcome");
  });
});

describe("while waiting (P06 polling)", () => {
  const waiting = initialCheckinState(
    read(openPage({ currentRequest: request("pending") })),
  );

  it.each([
    ["pending", "waiting"],
    ["approved", "approved"],
    ["rejected", "rejected"],
    ["already_checked_in", "already_checked_in_host_confirmed"],
    ["withdrawn", "welcome"],
  ] as const)("a poll answering %s shows %s", (status, screen) => {
    const state = checkinReducer(waiting, {
      type: "page_read",
      result: read(openPage({ currentRequest: request(status) })),
    });
    expect(state.screen).toBe(screen);
  });

  it("keeps the full name this page submitted for the same request", () => {
    const submitted = checkinReducer(initialCheckinState(read(openPage())), {
      type: "submit_finished",
      submittedName: { firstName: "Peter", lastName: "Lindqvist" },
      result: {
        ok: true,
        outcome: { status: "pending", checkinRequestId: REQUEST_ID },
      },
    });
    const approved = checkinReducer(submitted, {
      type: "page_read",
      result: read(
        openPage({
          currentRequest: request("approved", {
            firstName: "Peter",
            memberId: PETER_ID,
          }),
        }),
      ),
    });
    expect(approved.requester?.displayName).toBe("Peter Lindqvist");

    const otherRequest = checkinReducer(submitted, {
      type: "page_read",
      result: read(
        openPage({
          currentRequest: request("approved", {
            checkinRequestId: OTHER_REQUEST_ID,
            firstName: "Kai",
            memberId: null,
          }),
        }),
      ),
    });
    expect(otherRequest.requester?.displayName).toBe("Kai");
  });

  it("follows the session closing (P12) and the link being reissued (P11)", () => {
    expect(
      checkinReducer(waiting, {
        type: "page_read",
        result: read({
          status: "no_open_session",
          socialName: "Pickleball Riverside",
        }),
      }).screen,
    ).toBe("no_open_session");
    expect(
      checkinReducer(waiting, {
        type: "page_read",
        result: read({ status: "inactive" }),
      }).screen,
    ).toBe("inactive");
  });
});

describe("try again", () => {
  it("goes from Rejected (P08) to a fresh welcome", () => {
    const rejected = reduceAll(
      initialCheckinState(
        read(openPage({ currentRequest: request("rejected") })),
      ),
      [{ type: "search_query_changed", query: "Gr" }],
    );
    const state = checkinReducer(rejected, {
      type: "try_again_after_rejection",
    });
    expect(state).toMatchObject({
      screen: "welcome",
      requester: null,
      confirm: null,
      search: { query: "", matches: null, matchesQuery: "" },
    });
  });

  it("re-reads the page from P10, P12 and P13", () => {
    const failed = initialCheckinState({ ok: false, failure: "unavailable" });
    const refreshing = checkinReducer(failed, { type: "refresh_started" });
    expect(refreshing.isBusy).toBe(true);
    const state = checkinReducer(refreshing, {
      type: "page_read",
      result: read(openPage()),
    });
    expect(state).toMatchObject({ screen: "welcome", isBusy: false });
  });
});

describe("review fixes", () => {
  const welcome = initialCheckinState(read(openPage()));

  it("starts a fresh search after a search failure and Try again (the debounce can fire again)", () => {
    const failed = reduceAll(welcome, [
      { type: "search_query_changed", query: "Pe" },
      {
        type: "search_finished",
        query: "Pe",
        result: { ok: false, failure: "unavailable" },
      },
    ]);
    expect(failed.screen).toBe("unavailable");
    expect(failed.search).toEqual({
      query: "",
      matches: null,
      matchesQuery: "",
    });
    const retried = reduceAll(failed, [
      { type: "refresh_started" },
      { type: "page_read", result: read(openPage()) },
    ]);
    expect(retried.screen).toBe("welcome");
    expect(retried.search.query).toBe("");
  });

  it("clears the search whenever a page read changes the screen", () => {
    const searching = checkinReducer(welcome, {
      type: "search_query_changed",
      query: "Gr",
    });
    const waiting = checkinReducer(searching, {
      type: "page_read",
      result: read(openPage({ currentRequest: request("pending") })),
    });
    expect(waiting.search.query).toBe("");
  });

  it("returns to the guest form, values kept, after a failed guest submit and Try again", () => {
    const values = {
      firstName: "Kai",
      lastName: "Moreno",
      skillLevel: "advanced" as const,
    };
    const failed = reduceAll(welcome, [
      { type: "guest_form_opened" },
      { type: "guest_form_changed", values },
      { type: "submit_started" },
      {
        type: "submit_finished",
        submittedName: { firstName: "Kai", lastName: "Moreno" },
        result: { ok: false, failure: "unavailable" },
      },
    ]);
    expect(failed.screen).toBe("unavailable");
    const retried = reduceAll(failed, [
      { type: "refresh_started" },
      { type: "page_read", result: read(openPage()) },
    ]);
    expect(retried).toMatchObject({
      screen: "guest_form",
      guestFormValues: values,
      isGuestSubmitInterrupted: false,
    });
    // A later re-read (e.g. after Back) doesn't bounce back to the form.
    const backAndRead = reduceAll(retried, [
      { type: "guest_form_closed" },
      { type: "page_read", result: read(openPage()) },
    ]);
    expect(backAndRead.screen).toBe("welcome");
  });

  it("a member submit failure retries to the welcome, and a sent guest form is emptied", () => {
    const memberFailed = reduceAll(welcome, [
      { type: "confirm_opened", candidate: peterFromSearch },
      { type: "submit_started" },
      {
        type: "submit_finished",
        submittedName: { firstName: "Peter", lastName: "Lindqvist" },
        result: { ok: false, failure: "rate_limited" },
      },
      { type: "page_read", result: read(openPage()) },
    ]);
    expect(memberFailed.screen).toBe("welcome");

    const sent = reduceAll(welcome, [
      { type: "guest_form_opened" },
      {
        type: "guest_form_changed",
        values: {
          firstName: "Kai",
          lastName: "Moreno",
          skillLevel: "beginner",
        },
      },
      {
        type: "submit_finished",
        submittedName: { firstName: "Kai", lastName: "Moreno" },
        result: {
          ok: true,
          outcome: { status: "pending", checkinRequestId: REQUEST_ID },
        },
      },
    ]);
    expect(sent.guestFormValues).toEqual({
      firstName: "",
      lastName: "",
      skillLevel: null,
    });
  });

  it("the header refresh freshens the header without closing the sheet or leaving the screen", () => {
    const deciding = checkinReducer(welcome, {
      type: "confirm_opened",
      candidate: peterFromSearch,
    });
    const later = openPage({
      now: "2026-11-07T18:30:00Z",
      session: { ...openPage().session, checkedInCount: 30 },
      currentRequest: request("pending"),
    });
    const refreshed = checkinReducer(deciding, {
      type: "header_refreshed",
      result: read(later),
    });
    expect(refreshed.screen).toBe("welcome");
    expect(refreshed.confirm).not.toBeNull();
    expect(refreshed.openPage?.now).toBe("2026-11-07T18:30:00Z");
    expect(refreshed.openPage?.session.checkedInCount).toBe(30);

    expect(
      checkinReducer(deciding, {
        type: "header_refreshed",
        result: { ok: false, failure: "unavailable" },
      }),
    ).toBe(deciding);
    expect(
      checkinReducer(deciding, {
        type: "header_refreshed",
        result: read({
          status: "no_open_session",
          socialName: "Pickleball Riverside",
        }),
      }).screen,
    ).toBe("no_open_session");
  });
});
