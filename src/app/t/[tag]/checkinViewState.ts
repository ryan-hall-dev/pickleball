import type {
  CurrentCheckinRequest,
  OpenCheckinPage,
  ReadCheckinPageResult,
  SubmitCheckinResult,
} from "@/server/checkin/checkinResults";
import type {
  CheckinFormFieldErrors,
  CheckinFormValues,
} from "@/server/checkin/checkinRules";
export type CheckinScreen =
  | "welcome"
  | "waiting"
  | "approved"
  | "rejected"
  | "already_checked_in_own_phone"
  | "rate_limited"
  | "inactive"
  | "no_open_session"
  | "unavailable";

export interface Requester {
  /** Null when no request was created (P09). */
  checkinRequestId: string | null;
  firstName: string;
  /** The full name when this page knows it; after a reload only the first name. */
  displayName: string;
}

export interface CheckinState {
  screen: CheckinScreen;
  /** The social's name for the brand line; null on P11 (the link isn't active). */
  socialName: string | null;
  /** The latest open page read: header, session details. */
  openPage: OpenCheckinPage | null;
  requester: Requester | null;
  /** What the form holds, kept across a failed submit and its retry. */
  formValues: CheckinFormValues;
  /** The server's field errors for the form (the browser checks first). */
  fieldErrors: CheckinFormFieldErrors;
  /** A submit or a re-read is in flight. */
  isBusy: boolean;
}

export type CheckinAction =
  | { type: "page_read"; result: ReadCheckinPageResult }
  /** The welcome screen's periodic re-read: freshens the header only. */
  | { type: "header_refreshed"; result: ReadCheckinPageResult }
  | { type: "refresh_started" }
  | { type: "session_changed" }
  | { type: "form_changed"; values: CheckinFormValues }
  | { type: "submit_started" }
  | {
      type: "submit_finished";
      submittedName: { firstName: string; lastName: string };
      result: SubmitCheckinResult;
    }
  | { type: "try_again_after_rejection" };

const EMPTY_CHECKIN_FORM: CheckinFormValues = {
  firstName: "",
  lastName: "",
  skillLevel: null,
};

const EMPTY_STATE: CheckinState = {
  screen: "unavailable",
  socialName: null,
  openPage: null,
  requester: null,
  formValues: EMPTY_CHECKIN_FORM,
  fieldErrors: {},
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
    case "withdrawn":
    case undefined:
      return "welcome";
  }
}

function requesterForPage(
  page: OpenCheckinPage,
  previousRequester: Requester | null,
): Requester | null {
  const { currentRequest } = page;
  if (!currentRequest) return null;
  if (previousRequester?.checkinRequestId === currentRequest.checkinRequestId)
    return previousRequester;
  return {
    checkinRequestId: currentRequest.checkinRequestId,
    firstName: currentRequest.firstName,
    displayName: currentRequest.firstName,
  };
}

function applyPageRead(
  state: CheckinState,
  result: ReadCheckinPageResult,
): CheckinState {
  return pageReadState({ ...state, isBusy: false }, result);
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
        formValues: EMPTY_CHECKIN_FORM,
        fieldErrors: {},
        requester: null,
      };
    case "no_open_session":
      return {
        ...settled,
        screen: "no_open_session",
        socialName: page.socialName,
        openPage: null,
        formValues: EMPTY_CHECKIN_FORM,
        fieldErrors: {},
        requester: null,
      };
    case "open": {
      const screen = screenForCurrentRequest(page.currentRequest);
      const sessionChanged =
        settled.openPage !== null &&
        settled.openPage.session.sessionId !== page.session.sessionId;
      return {
        ...settled,
        screen,
        socialName: page.socialName,
        openPage: page,
        requester: requesterForPage(
          page,
          sessionChanged ? null : settled.requester,
        ),
        formValues: sessionChanged ? EMPTY_CHECKIN_FORM : settled.formValues,
        fieldErrors: sessionChanged ? {} : settled.fieldErrors,
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
  if (state.openPage?.session.sessionId !== result.page.session.sessionId)
    return applyPageRead(state, result);
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
    if (result.failure === "session_changed")
      return {
        ...settled,
        screen: "unavailable",
        formValues: EMPTY_CHECKIN_FORM,
        fieldErrors: {},
        requester: null,
      };
    if (result.failure === "invalid_input") {
      return { ...settled, fieldErrors: result.fieldErrors };
    }
    return {
      ...settled,
      screen: result.failure,
    };
  }
  const { outcome } = result;
  const finished = {
    ...settled,
    fieldErrors: {},
    formValues: EMPTY_CHECKIN_FORM,
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
    case "session_changed":
      return {
        ...state,
        isBusy: true,
        formValues: EMPTY_CHECKIN_FORM,
        fieldErrors: {},
        requester: null,
      };
    case "refresh_started":
      return { ...state, isBusy: true };
    case "form_changed":
      return { ...state, formValues: action.values };
    case "submit_started":
      return { ...state, isBusy: true };
    case "submit_finished":
      return applySubmitFinished(state, action.submittedName, action.result);
    case "try_again_after_rejection":
      // A retry is a new request (and counts towards the rate limits).
      return {
        ...state,
        screen: "welcome",
        requester: null,
        formValues: EMPTY_CHECKIN_FORM,
        fieldErrors: {},
      };
  }
}
