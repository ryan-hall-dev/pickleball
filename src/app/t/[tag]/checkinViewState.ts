import type {
  ClaimRosterResult,
  CurrentCheckinRequest,
  OpenCheckinPage,
  ReadCheckinPageResult,
  RequestRosterTransferResult,
  RosterSearchResult,
  SubmitCheckinResult,
} from "@/server/checkin/checkinResults";
import type {
  CheckinFormFieldErrors,
  CheckinFormValues,
} from "@/server/checkin/checkinRules";
export type CheckinScreen =
  /** The walk-in form (or, with no roster, everyone's form). */
  | "welcome"
  /** Roster: find your name, then level and gender, then you're in. */
  | "roster_find"
  | "roster_details"
  | "roster_in_use"
  | "roster_transfer_waiting"
  | "roster_checked_in"
  | "walk_ins_closed"
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
  /** The roster name the player chose. */
  rosterSelection: RosterSearchResult | null;
  /** Why the player is back at Find your name. */
  rosterNotice: "kept" | "gone" | null;
}

/** Screens the player moved to themselves; a page read doesn't leave them. */
const ROSTER_CHOICE_SCREENS: ReadonlySet<CheckinScreen> = new Set([
  "welcome",
  "roster_details",
  "roster_in_use",
]);

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
  | { type: "try_again_after_rejection" }
  | { type: "roster_name_chosen"; result: RosterSearchResult }
  | { type: "roster_find_again" }
  | { type: "walk_in_chosen" }
  | { type: "roster_call_started" }
  | { type: "roster_claim_finished"; result: ClaimRosterResult }
  | { type: "roster_transfer_finished"; result: RequestRosterTransferResult };

const EMPTY_CHECKIN_FORM: CheckinFormValues = {
  firstName: "",
  lastName: "",
  skillLevel: null,
  gender: null,
};

const EMPTY_STATE: CheckinState = {
  screen: "unavailable",
  socialName: null,
  openPage: null,
  requester: null,
  formValues: EMPTY_CHECKIN_FORM,
  fieldErrors: {},
  isBusy: false,
  rosterSelection: null,
  rosterNotice: null,
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

/**
 * This phone's roster name, then its walk-in request, then a "That's my name"
 * waiting on the host decide the screen. Otherwise a session with a roster
 * starts at Find your name (or stays where the player went from there).
 */
function screenForOpenPage(
  page: OpenCheckinPage,
  settled: CheckinState,
  sessionChanged: boolean,
): CheckinScreen {
  if (page.rosterClaim) return "roster_checked_in";
  const requestScreen = screenForCurrentRequest(page.currentRequest);
  if (requestScreen !== "welcome") return requestScreen;
  if (page.rosterTransferRequest?.status === "pending")
    return "roster_transfer_waiting";
  if (!page.session.hasRoster) return "welcome";
  // A list added after the page opened wins over the walk-in form the player
  // never chose: Find your name comes first.
  if (
    !sessionChanged &&
    settled.openPage?.session.hasRoster &&
    ROSTER_CHOICE_SCREENS.has(settled.screen)
  )
    return settled.screen;
  return "roster_find";
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
      const sessionChanged =
        settled.openPage !== null &&
        settled.openPage.session.sessionId !== page.session.sessionId;
      const screen = screenForOpenPage(page, settled, sessionChanged);
      return {
        ...settled,
        screen,
        rosterSelection: sessionChanged ? null : settled.rosterSelection,
        rosterNotice:
          page.rosterTransferRequest?.status === "kept" &&
          settled.screen === "roster_transfer_waiting"
            ? "kept"
            : sessionChanged
              ? null
              : settled.rosterNotice,
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
  if (
    state.openPage?.session.sessionId !== result.page.session.sessionId ||
    (result.page.session.hasRoster && !state.openPage.session.hasRoster)
  )
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

function applyRosterClaimFinished(
  state: CheckinState,
  result: ClaimRosterResult,
): CheckinState {
  const settled = { ...state, isBusy: false };
  if (!result.ok) return rosterFailureState(settled, result.failure);
  // Claimed (or already this phone's, or this phone is in another way): the
  // caller re-reads the page, which shows where this phone stands.
  if (result.outcome === "in_use")
    return { ...settled, screen: "roster_in_use" };
  return { ...settled, isBusy: true };
}

function applyRosterTransferFinished(
  state: CheckinState,
  result: RequestRosterTransferResult,
): CheckinState {
  const settled = { ...state, isBusy: false };
  if (!result.ok) return rosterFailureState(settled, result.failure);
  switch (result.outcome) {
    case "requested":
      return { ...settled, screen: "roster_transfer_waiting" };
    case "not_in_use":
      // Freed meanwhile: the player can simply claim it.
      return { ...settled, screen: "roster_details" };
    case "already_yours":
    case "phone_has_other_name":
      return { ...settled, isBusy: true };
  }
}

function rosterFailureState(
  settled: CheckinState,
  failure: Exclude<ClaimRosterResult, { ok: true }>["failure"],
): CheckinState {
  switch (failure) {
    case "roster_entry_gone":
      return {
        ...settled,
        screen: "roster_find",
        rosterSelection: null,
        rosterNotice: "gone",
      };
    case "session_changed":
      return {
        ...settled,
        screen: "unavailable",
        rosterSelection: null,
        rosterNotice: null,
      };
    case "invalid_input":
      // The browser checks the same rules first: only an outdated page gets here.
      return { ...settled, screen: "unavailable" };
    default:
      return { ...settled, screen: failure };
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
    case "roster_name_chosen":
      return {
        ...state,
        screen: action.result.isInUse ? "roster_in_use" : "roster_details",
        rosterSelection: action.result,
        rosterNotice: null,
      };
    case "roster_find_again":
      return {
        ...state,
        screen: "roster_find",
        rosterSelection: null,
        rosterNotice: null,
      };
    case "walk_in_chosen":
      return {
        ...state,
        screen: state.openPage?.session.walkInsOpen
          ? "welcome"
          : "walk_ins_closed",
      };
    case "roster_call_started":
      return { ...state, isBusy: true };
    case "roster_claim_finished":
      return applyRosterClaimFinished(state, action.result);
    case "roster_transfer_finished":
      return applyRosterTransferFinished(state, action.result);
    case "try_again_after_rejection":
      // A retry is a new request (and counts towards the rate limits).
      return {
        ...state,
        screen: state.openPage?.session.hasRoster ? "roster_find" : "welcome",
        requester: null,
        formValues: EMPTY_CHECKIN_FORM,
        fieldErrors: {},
      };
  }
}
