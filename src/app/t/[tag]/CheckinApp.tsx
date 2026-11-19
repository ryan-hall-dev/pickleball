"use client";

import {
  type Dispatch,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ensureCheckinDevice,
  readCheckinPage,
  submitCheckin,
} from "@/server/checkin/checkinActions";
import type {
  ReadCheckinPageResult,
  SubmitCheckinResult,
} from "@/server/checkin/checkinResults";
import { type CheckinSubmitInput } from "@/server/checkin/checkinRules";
import { useMessages } from "@/i18n/LocaleProvider";
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
import { ParticipantCheckinForm } from "./ParticipantCheckinForm";
import { settleWithin } from "@/lib/settleWithin";

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
}: {
  checkinTag: string;
  initialPageRead: ReadCheckinPageResult;
}) {
  const isInBrowser = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const messages = useMessages();
  if (!isInBrowser) {
    return (
      <p className="text-muted" aria-live="polite">
        {messages.loading.checkin}
      </p>
    );
  }
  return (
    <CheckinFlow checkinTag={checkinTag} initialPageRead={initialPageRead} />
  );
}

function CheckinFlow({
  checkinTag,
  initialPageRead,
}: {
  checkinTag: string;
  initialPageRead: ReadCheckinPageResult;
}) {
  const [state, dispatch] = useReducer(
    checkinReducer,
    initialPageRead,
    initialCheckinState,
  );

  const isDeviceReady = useDeviceCookieBeforeSubmit(
    checkinTag,
    state.openPage?.session.sessionId,
    dispatch,
  );
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
        submitCheckin(checkinTag, {
          ...input,
          sessionId: state.openPage?.session.sessionId,
        }),
        SERVER_CALL_TIMEOUT_MS,
        UNAVAILABLE_SUBMIT,
      ).then((result) => {
        if (!result.ok && result.failure === "session_changed") {
          dispatch({ type: "session_changed" });
          void readCheckinPageWithin(checkinTag).then((freshPage) =>
            dispatch({ type: "page_read", result: freshPage }),
          );
          return;
        }
        dispatch({
          type: "submit_finished",
          submittedName: {
            firstName: input.firstName,
            lastName: input.lastName,
          },
          result,
        });
      });
    },
    [checkinTag, state.openPage?.session.sessionId],
  );

  return (
    <CheckinScreenView
      state={{ ...state, isBusy: state.isBusy || !isDeviceReady }}
      dispatch={dispatch}
      onRefresh={refreshPage}
      onSubmit={submit}
    />
  );
}

/**
 * A new phone gets its device cookie once, as soon as the page opens, so a
 * retried submit (after a lost answer) is the same phone and returns the same
 * request. If this fails, the first search or submit creates it instead.
 */
function useDeviceCookieBeforeSubmit(
  checkinTag: string,
  sessionId: string | undefined,
  dispatch: Dispatch<CheckinAction>,
) {
  const [preparedSessionId, setPreparedSessionId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!sessionId) return;
    let isStopped = false;
    let retryTimeout: ReturnType<typeof setTimeout>;
    async function prepareDevice() {
      const result = await settleWithin(
        ensureCheckinDevice(checkinTag),
        SERVER_CALL_TIMEOUT_MS,
        { ok: false, failure: "unavailable" } as const,
      );
      if (isStopped) return;
      if (result.ok) setPreparedSessionId(sessionId!);
      else {
        dispatch({
          type: "page_read",
          result: { ok: false, failure: "unavailable" },
        });
        retryTimeout = setTimeout(() => {
          void prepareDevice();
        }, WAITING_POLL_INTERVAL_MS);
      }
    }
    void prepareDevice();
    return () => {
      isStopped = true;
      clearTimeout(retryTimeout);
    };
  }, [checkinTag, sessionId, dispatch]);
  return !sessionId || preparedSessionId === sessionId;
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
  const messages = useMessages();
  const { screen, openPage, requester } = state;
  const brandName = state.socialName ?? messages.appName;

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
        <ParticipantCheckinForm
          page={openPage}
          values={state.formValues}
          onValuesChange={(values) =>
            dispatch({ type: "form_changed", values })
          }
          serverFieldErrors={state.fieldErrors}
          isBusy={state.isBusy}
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
      return <AlreadyCheckedInScreen {...screenProps} />;
  }
}
