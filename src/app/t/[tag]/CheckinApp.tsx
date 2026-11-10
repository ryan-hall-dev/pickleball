"use client";

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useSyncExternalStore,
  type Dispatch,
} from "react";
import {
  ensureCheckinDevice,
  readCheckinPage,
  searchCheckinNames,
  submitCheckin,
} from "@/server/checkin/checkinActions";
import type {
  ReadCheckinPageResult,
  SearchCheckinNamesResult,
  SubmitCheckinResult,
} from "@/server/checkin/checkinResults";
import {
  isSearchableQuery,
  type CheckinSubmitInput,
} from "@/server/checkin/checkinRules";
import { APP_NAME } from "./CheckinParts";
import {
  AlreadyCheckedInScreen,
  ApprovedScreen,
  InactiveLinkScreen,
  NoOpenSessionScreen,
  RateLimitedScreen,
  RejectedScreen,
  UnavailableScreen,
  WaitingScreen,
} from "./CheckinStateScreens";
import {
  checkinReducer,
  initialCheckinState,
  type CheckinAction,
  type CheckinState,
} from "./checkinViewState";
import { ConfirmSheet } from "./ConfirmSheet";
import { GuestCheckinForm } from "./GuestCheckinForm";
import { settleWithin } from "./settleWithin";
import { WelcomeScreen } from "./WelcomeScreen";

/** Typing settles for this long before a search is sent. */
const SEARCH_DEBOUNCE_MS = 300;
/** How often the waiting screen asks whether a host has decided (plan: 5 s polling). */
const WAITING_POLL_INTERVAL_MS = 5_000;
/** How often the welcome screen freshens "min left" and "to first game". */
const HEADER_REFRESH_INTERVAL_MS = 60_000;
/** A server call with no answer by then shows P13 (Try again). */
const SERVER_CALL_TIMEOUT_MS = 15_000;

const UNAVAILABLE_PAGE_READ: ReadCheckinPageResult = {
  ok: false,
  failure: "unavailable",
};
const UNAVAILABLE_SUBMIT: SubmitCheckinResult = {
  ok: false,
  failure: "unavailable",
};
const UNAVAILABLE_SEARCH: SearchCheckinNamesResult = {
  ok: false,
  failure: "unavailable",
};

function readCheckinPageWithin(checkinTag: string) {
  return settleWithin(
    readCheckinPage(checkinTag),
    SERVER_CALL_TIMEOUT_MS,
    UNAVAILABLE_PAGE_READ,
  );
}

function subscribeToNothing() {
  return () => {};
}

/**
 * The public check-in page (/t/<tag>). Times show in the phone's time zone,
 * which the server doesn't know, so it renders in the browser only (no
 * server render of local times that would mismatch on hydration).
 */
export function CheckinApp({
  checkinTag,
  initialPageRead,
  needsDeviceCookie,
}: {
  checkinTag: string;
  initialPageRead: ReadCheckinPageResult;
  /** A new phone on an open check-in: give it its device cookie straight away. */
  needsDeviceCookie: boolean;
}) {
  const isInBrowser = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  if (!isInBrowser) {
    return (
      <p className="text-muted" aria-live="polite">
        Loading check-in…
      </p>
    );
  }
  return (
    <CheckinFlow
      checkinTag={checkinTag}
      initialPageRead={initialPageRead}
      needsDeviceCookie={needsDeviceCookie}
    />
  );
}

function CheckinFlow({
  checkinTag,
  initialPageRead,
  needsDeviceCookie,
}: {
  checkinTag: string;
  initialPageRead: ReadCheckinPageResult;
  needsDeviceCookie: boolean;
}) {
  const [state, dispatch] = useReducer(
    checkinReducer,
    initialPageRead,
    initialCheckinState,
  );

  useDeviceCookieBeforeSubmit(needsDeviceCookie);
  useDebouncedSearch(checkinTag, state.search.query, dispatch);
  usePeriodicPageRead(
    checkinTag,
    state.screen === "waiting" ? WAITING_POLL_INTERVAL_MS : null,
    (result) => dispatch({ type: "page_read", result }),
  );
  usePeriodicPageRead(
    checkinTag,
    state.screen === "welcome" ? HEADER_REFRESH_INTERVAL_MS : null,
    (result) => dispatch({ type: "header_refreshed", result }),
  );

  const refreshPage = useCallback(() => {
    dispatch({ type: "refresh_started" });
    void readCheckinPageWithin(checkinTag).then((result) =>
      dispatch({ type: "page_read", result }),
    );
  }, [checkinTag]);

  const submit = useCallback(
    (input: CheckinSubmitInput) => {
      dispatch({ type: "submit_started" });
      void settleWithin(
        submitCheckin(checkinTag, input),
        SERVER_CALL_TIMEOUT_MS,
        UNAVAILABLE_SUBMIT,
      ).then((result) =>
        dispatch({
          type: "submit_finished",
          submittedName: {
            firstName: input.firstName,
            lastName: input.lastName,
          },
          result,
        }),
      );
    },
    [checkinTag],
  );

  return (
    <CheckinScreenView
      state={state}
      dispatch={dispatch}
      onRefresh={refreshPage}
      onSubmit={submit}
    />
  );
}

/** Searches 300 ms after typing stops; nothing is sent for fewer than 2 letters. */
function useDebouncedSearch(
  checkinTag: string,
  nameQuery: string,
  dispatch: Dispatch<CheckinAction>,
) {
  useEffect(() => {
    if (!isSearchableQuery(nameQuery)) return;
    const timeout = setTimeout(() => {
      void settleWithin(
        searchCheckinNames(checkinTag, nameQuery),
        SERVER_CALL_TIMEOUT_MS,
        UNAVAILABLE_SEARCH,
      ).then((result) =>
        dispatch({ type: "search_finished", query: nameQuery, result }),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [checkinTag, nameQuery, dispatch]);
}

/**
 * A new phone gets its device cookie once, as soon as the page opens, so a
 * retried submit (after a lost answer) is the same phone and returns the same
 * request. If this fails, the first search or submit creates it instead.
 */
function useDeviceCookieBeforeSubmit(needsDeviceCookie: boolean) {
  useEffect(() => {
    if (!needsDeviceCookie) return;
    void ensureCheckinDevice().catch(() => {
      // Offline: the first search or submit sets the cookie.
    });
  }, [needsDeviceCookie]);
}

/**
 * Re-reads the page every `intervalMs` while it is set: 5 s while a request
 * waits, 60 s on the welcome screen (header only). Paused while the page is
 * hidden, and once more as soon as it is shown again. A failed read is
 * ignored: the next one tries again.
 */
function usePeriodicPageRead(
  checkinTag: string,
  intervalMs: number | null,
  onPageRead: (result: ReadCheckinPageResult) => void,
) {
  const onPageReadRef = useRef(onPageRead);
  useEffect(() => {
    onPageReadRef.current = onPageRead;
  });

  useEffect(() => {
    if (intervalMs === null) return;
    let isStopped = false;
    function readPage() {
      if (document.hidden) return;
      void readCheckinPageWithin(checkinTag).then((result) => {
        if (!isStopped && result.ok) onPageReadRef.current(result);
      });
    }
    const interval = setInterval(readPage, intervalMs);
    document.addEventListener("visibilitychange", readPage);
    return () => {
      isStopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", readPage);
    };
  }, [checkinTag, intervalMs]);
}

function CheckinScreenView({
  state,
  dispatch,
  onRefresh,
  onSubmit,
}: {
  state: CheckinState;
  dispatch: Dispatch<CheckinAction>;
  onRefresh: () => void;
  onSubmit: (input: CheckinSubmitInput) => void;
}) {
  const { screen, openPage, requester } = state;
  const brandName = state.socialName ?? APP_NAME;

  switch (screen) {
    case "inactive":
      return <InactiveLinkScreen />;
    case "no_open_session":
      return (
        <NoOpenSessionScreen
          socialName={brandName}
          isBusy={state.isBusy}
          onCheckAgain={onRefresh}
        />
      );
    case "rate_limited":
      return (
        <RateLimitedScreen
          brandName={brandName}
          isBusy={state.isBusy}
          onTryAgain={onRefresh}
        />
      );
    case "unavailable":
      return (
        <UnavailableScreen
          brandName={brandName}
          isBusy={state.isBusy}
          onTryAgain={onRefresh}
        />
      );
    case "rejected":
      return (
        <RejectedScreen
          socialName={brandName}
          onTryAgain={() => dispatch({ type: "try_again_after_rejection" })}
        />
      );
  }

  if (!openPage) {
    throw new Error(`The ${screen} screen needs an open check-in page.`);
  }

  switch (screen) {
    case "welcome":
      return (
        <>
          <WelcomeScreen
            page={openPage}
            search={state.search}
            onSearchQueryChange={(query) =>
              dispatch({ type: "search_query_changed", query })
            }
            onCandidatePicked={(candidate) =>
              dispatch({ type: "confirm_opened", candidate })
            }
            onGuestFormOpened={() => dispatch({ type: "guest_form_opened" })}
          />
          <ConfirmSheet
            page={openPage}
            confirm={state.confirm}
            isBusy={state.isBusy}
            onClose={() => dispatch({ type: "confirm_closed" })}
            onLevelPickerToggled={() =>
              dispatch({ type: "level_picker_toggled" })
            }
            onLevelPressed={(skillLevel) =>
              dispatch({ type: "level_pressed", skillLevel })
            }
            onCheckIn={() => {
              if (!state.confirm) return;
              const { candidate, updatedSkillLevel } = state.confirm;
              onSubmit({
                kind: "member",
                memberId: candidate.memberId,
                firstName: candidate.firstName,
                lastName: candidate.lastName,
                updatedSkillLevel,
              });
            }}
          />
        </>
      );
    case "guest_form":
      return (
        <GuestCheckinForm
          page={openPage}
          values={state.guestFormValues}
          onValuesChange={(values) =>
            dispatch({ type: "guest_form_changed", values })
          }
          serverFieldErrors={state.guestFieldErrors}
          isBusy={state.isBusy}
          onBack={() => dispatch({ type: "guest_form_closed" })}
          onCheckIn={onSubmit}
        />
      );
  }

  if (!requester) {
    throw new Error(`The ${screen} screen needs the request's name.`);
  }
  const screenProps = {
    socialName: openPage.socialName,
    session: openPage.session,
    requester,
  };
  switch (screen) {
    case "waiting":
      return <WaitingScreen {...screenProps} />;
    case "approved":
      return <ApprovedScreen {...screenProps} />;
    case "already_checked_in_own_phone":
      return (
        <AlreadyCheckedInScreen {...screenProps} confirmedBy="own_phone" />
      );
    case "already_checked_in_host_confirmed":
      return <AlreadyCheckedInScreen {...screenProps} confirmedBy="host" />;
  }
}
