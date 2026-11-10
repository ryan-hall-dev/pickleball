import type { SkillLevel } from "@/server/members/memberSearch";
import type {
  CurrentCheckinRequest,
  NameMatch,
  OpenCheckinPage,
  ReadCheckinPageResult,
  SearchCheckinNamesResult,
  SubmitCheckinResult,
} from "@/server/checkin/checkinResults";
import {
  isSearchableQuery,
  type GuestFormFieldErrors,
  type GuestFormValues,
} from "@/server/checkin/checkinRules";

// The public check-in page's view state, as a pure reducer (unit tested).
// Screen names follow docs/designs/m5 (P01-P13). The page read decides the
// first screen, so a reload returns to the current request's state.

export type CheckinScreen =
  /** P01 recognised phone / P02 new phone, with search (P03) and the confirm sheet (P04). */
  | "welcome"
  /** P05 */
  | "guest_form"
  /** P06 */
  | "waiting"
  /** P07 */
  | "approved"
  /** P08 */
  | "rejected"
  /** P09: submit answered already_checked_in (only to the member's own linked phone). */
  | "already_checked_in_own_phone"
  /** P09b: a host closed this phone's request as already checked in. */
  | "already_checked_in_host_confirmed"
  /** P10 */
  | "rate_limited"
  /** P11 */
  | "inactive"
  /** P12 */
  | "no_open_session"
  /** P13 */
  | "unavailable";

export interface CheckinCandidate {
  memberId: string;
  firstName: string;
  lastName: string;
  /** "recognised": this phone's own member (P04a); "search": picked by name (P04b/c). */
  source: "recognised" | "search";
}

export interface ConfirmSheetState {
  candidate: CheckinCandidate;
  isLevelPickerOpen: boolean;
  /** "Update your level": nothing preselected; null keeps the saved level. */
  updatedSkillLevel: SkillLevel | null;
}

/** Who this phone's request is for, as shown on P06-P09b. */
export interface Requester {
  /** Null when no request was created (P09). */
  checkinRequestId: string | null;
  firstName: string;
  /** The full name when this page knows it; after a reload only the first name. */
  displayName: string;
}

export interface SearchState {
  query: string;
  /** Null until a searchable query has results. */
  matches: NameMatch[] | null;
  /** The query `matches` answer (results can lag behind typing). */
  matchesQuery: string;
}

export interface CheckinState {
  screen: CheckinScreen;
  /** The social's name for the brand line; null on P11 (the link isn't active). */
  socialName: string | null;
  /** The latest open page read: header, recognised member. */
  openPage: OpenCheckinPage | null;
  search: SearchState;
  confirm: ConfirmSheetState | null;
  requester: Requester | null;
  /** What the guest form holds, kept across a failed submit and its retry. */
  guestFormValues: GuestFormValues;
  /** The server's field errors for the guest form (the browser checks first). */
  guestFieldErrors: GuestFormFieldErrors;
  /** A guest submit failed (P10/P13): after Try again, return to the form. */
  isGuestSubmitInterrupted: boolean;
  /** A submit or a re-read is in flight. */
  isBusy: boolean;
}

export type CheckinAction =
  | { type: "page_read"; result: ReadCheckinPageResult }
  /** The welcome screen's periodic re-read: freshens the header only. */
  | { type: "header_refreshed"; result: ReadCheckinPageResult }
  | { type: "refresh_started" }
  | { type: "search_query_changed"; query: string }
  | { type: "search_finished"; query: string; result: SearchCheckinNamesResult }
  | { type: "confirm_opened"; candidate: CheckinCandidate }
  | { type: "confirm_closed" }
  | { type: "level_picker_toggled" }
  | { type: "level_pressed"; skillLevel: SkillLevel }
  | { type: "guest_form_opened" }
  | { type: "guest_form_closed" }
  | { type: "guest_form_changed"; values: GuestFormValues }
  | { type: "submit_started" }
  | {
      type: "submit_finished";
      submittedName: { firstName: string; lastName: string };
      result: SubmitCheckinResult;
    }
  | { type: "try_again_after_rejection" };

const EMPTY_SEARCH: SearchState = {
  query: "",
  matches: null,
  matchesQuery: "",
};

const EMPTY_GUEST_FORM: GuestFormValues = {
  firstName: "",
  lastName: "",
  skillLevel: null,
};

const EMPTY_STATE: CheckinState = {
  screen: "unavailable",
  socialName: null,
  openPage: null,
  search: EMPTY_SEARCH,
  confirm: null,
  requester: null,
  guestFormValues: EMPTY_GUEST_FORM,
  guestFieldErrors: {},
  isGuestSubmitInterrupted: false,
  isBusy: false,
};

/** The first state, from the server-rendered page read. */
export function initialCheckinState(
  pageReadResult: ReadCheckinPageResult,
): CheckinState {
  return checkinReducer(EMPTY_STATE, {
    type: "page_read",
    result: pageReadResult,
  });
}

/** This phone's latest request decides the screen; none (or withdrawn) is the welcome. */
function screenForCurrentRequest(
  currentRequest: CurrentCheckinRequest | null,
): CheckinScreen {
  switch (currentRequest?.status) {
    case "pending":
      return "waiting";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "already_checked_in":
      return "already_checked_in_host_confirmed";
    case "withdrawn":
    case undefined:
      return "welcome";
  }
}

function requesterForPage(
  page: OpenCheckinPage,
  previousRequester: Requester | null,
): Requester | null {
  const { currentRequest, recognisedMember } = page;
  if (!currentRequest) return null;
  // Same request as this page submitted: keep the full name it knows.
  if (previousRequester?.checkinRequestId === currentRequest.checkinRequestId) {
    return previousRequester;
  }
  const isRecognisedMembersRequest =
    recognisedMember !== null &&
    recognisedMember.memberId === currentRequest.memberId;
  return {
    checkinRequestId: currentRequest.checkinRequestId,
    firstName: currentRequest.firstName,
    displayName: isRecognisedMembersRequest
      ? `${recognisedMember.firstName} ${recognisedMember.lastName}`
      : currentRequest.firstName,
  };
}

function applyPageRead(
  state: CheckinState,
  result: ReadCheckinPageResult,
): CheckinState {
  const next = pageReadState(
    { ...state, isBusy: false, confirm: null },
    result,
  );
  // A new screen starts with an empty search, so typing searches again.
  return next.screen === state.screen
    ? next
    : { ...next, search: EMPTY_SEARCH };
}

function pageReadState(
  settled: CheckinState,
  result: ReadCheckinPageResult,
): CheckinState {
  if (!result.ok) return { ...settled, screen: "unavailable" };
  const { page } = result;
  switch (page.status) {
    case "inactive":
      return {
        ...settled,
        screen: "inactive",
        socialName: null,
        openPage: null,
      };
    case "no_open_session":
      return {
        ...settled,
        screen: "no_open_session",
        socialName: page.socialName,
        openPage: null,
      };
    case "open": {
      const screen = screenForCurrentRequest(page.currentRequest);
      return {
        ...settled,
        // Try again after a failed guest submit goes back to the form.
        screen:
          screen === "welcome" && settled.isGuestSubmitInterrupted
            ? "guest_form"
            : screen,
        isGuestSubmitInterrupted: false,
        socialName: page.socialName,
        openPage: page,
        requester: requesterForPage(page, settled.requester),
      };
    }
  }
}

/** Freshens the header ("min left", "to first game") without leaving the screen. */
function applyHeaderRefresh(
  state: CheckinState,
  result: ReadCheckinPageResult,
): CheckinState {
  if (!result.ok) return state;
  if (result.page.status !== "open") return applyPageRead(state, result);
  return {
    ...state,
    socialName: result.page.socialName,
    openPage: result.page,
  };
}

function applySubmitFinished(
  state: CheckinState,
  submittedName: { firstName: string; lastName: string },
  result: SubmitCheckinResult,
): CheckinState {
  const settled = { ...state, isBusy: false };
  if (!result.ok) {
    if (result.failure === "invalid_input") {
      return { ...settled, guestFieldErrors: result.fieldErrors };
    }
    return {
      ...settled,
      confirm: null,
      screen: result.failure,
      isGuestSubmitInterrupted: state.screen === "guest_form",
    };
  }
  const { outcome } = result;
  const finished = {
    ...settled,
    confirm: null,
    guestFieldErrors: {},
    guestFormValues: EMPTY_GUEST_FORM,
  };
  const displayName = `${submittedName.firstName} ${submittedName.lastName}`;
  switch (outcome.status) {
    case "pending":
      return {
        ...finished,
        screen: "waiting",
        requester: {
          checkinRequestId: outcome.checkinRequestId,
          firstName: submittedName.firstName,
          displayName,
        },
      };
    case "already_checked_in":
      return {
        ...finished,
        screen: "already_checked_in_own_phone",
        requester: {
          checkinRequestId: null,
          firstName: submittedName.firstName,
          displayName,
        },
      };
    case "member_not_found":
      // Deactivated since the search: "Try again" re-reads the page.
      return { ...finished, screen: "unavailable" };
  }
}

export function checkinReducer(
  state: CheckinState,
  action: CheckinAction,
): CheckinState {
  switch (action.type) {
    case "page_read":
      return applyPageRead(state, action.result);
    case "header_refreshed":
      return applyHeaderRefresh(state, action.result);
    case "refresh_started":
      return { ...state, isBusy: true };
    case "search_query_changed":
      return {
        ...state,
        search: isSearchableQuery(action.query)
          ? { ...state.search, query: action.query }
          : { ...EMPTY_SEARCH, query: action.query },
      };
    case "search_finished": {
      // A slower answer for an older query is dropped.
      if (action.query !== state.search.query) return state;
      if (!action.result.ok) {
        return {
          ...state,
          screen: action.result.failure,
          search: EMPTY_SEARCH,
        };
      }
      return {
        ...state,
        search: {
          query: action.query,
          matches: action.result.matches,
          matchesQuery: action.query,
        },
      };
    }
    case "confirm_opened":
      return {
        ...state,
        confirm: {
          candidate: action.candidate,
          isLevelPickerOpen: false,
          updatedSkillLevel: null,
        },
      };
    case "confirm_closed":
      return state.isBusy ? state : { ...state, confirm: null };
    case "level_picker_toggled":
      return state.confirm
        ? {
            ...state,
            confirm: {
              ...state.confirm,
              isLevelPickerOpen: !state.confirm.isLevelPickerOpen,
            },
          }
        : state;
    case "level_pressed":
      return state.confirm
        ? {
            ...state,
            confirm: {
              ...state.confirm,
              // Tapping the selected level again clears it (keeps the saved one).
              updatedSkillLevel:
                state.confirm.updatedSkillLevel === action.skillLevel
                  ? null
                  : action.skillLevel,
            },
          }
        : state;
    case "guest_form_opened":
      return {
        ...state,
        screen: "guest_form",
        confirm: null,
        guestFieldErrors: {},
      };
    case "guest_form_changed":
      return { ...state, guestFormValues: action.values };
    case "guest_form_closed":
      return { ...state, screen: "welcome", guestFieldErrors: {} };
    case "submit_started":
      return { ...state, isBusy: true };
    case "submit_finished":
      return applySubmitFinished(state, action.submittedName, action.result);
    case "try_again_after_rejection":
      // A retry is a new request (and counts towards the rate limits).
      return {
        ...state,
        screen: "welcome",
        search: EMPTY_SEARCH,
        confirm: null,
        requester: null,
      };
  }
}
