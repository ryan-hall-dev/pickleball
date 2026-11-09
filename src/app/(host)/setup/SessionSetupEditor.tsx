"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { LINK_BUTTON_CLASS_NAME } from "@/components/controlStyles";
import { saveSessionDraft } from "@/server/setup/setupActions";
import type { ClubCourt, SessionDraft } from "@/server/setup/setupDraft";
import type { SaveSessionDraftInput } from "@/server/setup/setupRules";
import { CourtsCard } from "./CourtsCard";
import { DiscardDraftButton } from "./DiscardDraftButton";
import { SessionDetailsCard } from "./SessionDetailsCard";
import { SessionSummary, type SummaryTiming } from "./SessionSummary";
import { SetupPageHeader } from "./SetupPageHeader";
import {
  setupFormFromDraft,
  validateSetupForm,
  type SetupForm,
} from "./setupPlanning";

/** Edits settle for this long before they are saved. */
const AUTOSAVE_DELAY_MS = 700;
const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection.";

function subscribeToNothing() {
  return () => {};
}

/**
 * The draft editor. Times are shown in the browser's time zone, which the
 * server doesn't know, so the form only renders in the browser (no server
 * render of local times that would then mismatch on hydration).
 */
export function SessionSetupEditor(props: {
  draft: SessionDraft;
  initialClubCourts: ClubCourt[];
}) {
  const isInBrowser = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  if (!isInBrowser) {
    return (
      <>
        <SetupPageHeader />
        <p className="text-muted" aria-live="polite">
          Loading your session…
        </p>
      </>
    );
  }
  return <SessionSetupForm {...props} />;
}

type SaveFailure = { saveInputKey: string; message: string };

/**
 * Saves the latest valid form after edits settle. One save runs at a time;
 * edits made meanwhile are saved right after it, newest wins. Leaving the
 * page within the settle delay still saves (on unmount), and closing the tab
 * with unsaved edits asks first.
 */
function useDraftAutosave(
  saveInput: SaveSessionDraftInput | null,
  isPaused: boolean,
) {
  const saveInputKey = useMemo(
    () => (saveInput ? JSON.stringify(saveInput) : null),
    [saveInput],
  );
  // The draft as loaded is already saved.
  const [lastSavedKey, setLastSavedKey] = useState(saveInputKey);
  const [isSaving, setIsSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const isSavingRef = useRef(false);
  const queuedSaveInputRef = useRef<SaveSessionDraftInput | null>(null);
  /** Key of the save awaiting the server, so the unmount flush doesn't repeat it. */
  const inFlightSaveKeyRef = useRef<string | null>(null);

  const runSave = useCallback(async (input: SaveSessionDraftInput) => {
    if (isSavingRef.current) {
      queuedSaveInputRef.current = input;
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    setFailure(null);
    let inputToSave = input;
    for (;;) {
      inFlightSaveKeyRef.current = JSON.stringify(inputToSave);
      const result = await saveSessionDraft(inputToSave).catch(() => ({
        ok: false as const,
        message: OFFLINE_MESSAGE,
      }));
      const queuedInput = queuedSaveInputRef.current;
      queuedSaveInputRef.current = null;
      if (queuedInput) {
        // Newer edits arrived while saving: save those (this result is stale).
        inputToSave = queuedInput;
        continue;
      }
      const inputKey = JSON.stringify(inputToSave);
      if (result.ok) setLastSavedKey(inputKey);
      else setFailure({ saveInputKey: inputKey, message: result.message });
      break;
    }
    inFlightSaveKeyRef.current = null;
    isSavingRef.current = false;
    setIsSaving(false);
  }, []);

  useEffect(() => {
    if (isPaused || !saveInput || saveInputKey === lastSavedKey) return;
    // A failed save is retried by the host (Retry) or by their next edit.
    if (failure?.saveInputKey === saveInputKey) return;
    const timeout = setTimeout(
      () => void runSave(saveInput),
      AUTOSAVE_DELAY_MS,
    );
    return () => clearTimeout(timeout);
  }, [isPaused, saveInput, saveInputKey, lastSavedKey, failure, runSave]);

  // The newest values, for the unmount flush below (refs are written after render).
  const latestRef = useRef({ saveInput, saveInputKey, lastSavedKey, isPaused });
  useEffect(() => {
    latestRef.current = { saveInput, saveInputKey, lastSavedKey, isPaused };
  });
  useEffect(
    () => () => {
      const latest = latestRef.current;
      const queuedInput = queuedSaveInputRef.current;
      const isAlreadyBeingSaved =
        latest.saveInputKey === inFlightSaveKeyRef.current ||
        (queuedInput !== null &&
          JSON.stringify(queuedInput) === latest.saveInputKey);
      if (
        !latest.isPaused &&
        latest.saveInput &&
        latest.saveInputKey !== latest.lastSavedKey &&
        !isAlreadyBeingSaved
      ) {
        // Fire and forget: the page is going away (e.g. a client navigation).
        void saveSessionDraft(latest.saveInput).catch(() => {});
      }
    },
    [],
  );

  const status: SaveStatus =
    saveInput === null
      ? { kind: "invalid" }
      : failure?.saveInputKey === saveInputKey && !isSaving
        ? { kind: "failed", message: failure.message }
        : isSaving || saveInputKey !== lastSavedKey
          ? { kind: "saving" }
          : { kind: "saved" };
  const hasUnsavedEdits = status.kind !== "saved";
  useEffect(() => {
    if (!hasUnsavedEdits) return;
    function askBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", askBeforeLeaving);
    return () => window.removeEventListener("beforeunload", askBeforeLeaving);
  }, [hasUnsavedEdits]);

  const retry = () => {
    if (saveInput) void runSave(saveInput);
  };
  return { status, retry };
}

type SaveStatus =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "invalid" }
  | { kind: "failed"; message: string };

function SaveStatusIndicator({
  status,
  onRetry,
}: {
  status: SaveStatus;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span role="status" className="contents">
        {status.kind === "saved" && <span className="text-muted">Saved</span>}
        {status.kind === "saving" && (
          <span className="text-muted">Saving…</span>
        )}
        {status.kind === "invalid" && (
          <span className="text-orange-soft">
            <span aria-hidden="true">! </span>Not saved: fix the highlighted
            fields
          </span>
        )}
        {status.kind === "failed" && (
          <span className="text-orange-soft">
            <span aria-hidden="true">! </span>Not saved. {status.message}
          </span>
        )}
      </span>
      {status.kind === "failed" && (
        <button
          type="button"
          onClick={onRetry}
          className={LINK_BUTTON_CLASS_NAME}
        >
          Retry
        </button>
      )}
    </div>
  );
}

function wholeNumberOrNull(text: string): number | null {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
}

function SessionSetupForm({
  draft,
  initialClubCourts,
}: {
  draft: SessionDraft;
  initialClubCourts: ClubCourt[];
}) {
  const [clubCourts, setClubCourts] = useState(initialClubCourts);
  const [form, setForm] = useState<SetupForm>(() =>
    setupFormFromDraft(
      draft,
      new Set(initialClubCourts.map((court) => court.id)),
    ),
  );
  const [isAutosavePaused, setIsAutosavePaused] = useState(false);
  const validation = useMemo(
    () => validateSetupForm(form, draft.sessionId),
    [form, draft.sessionId],
  );
  const { status, retry } = useDraftAutosave(
    validation.saveInput,
    isAutosavePaused,
  );
  const { fieldErrors, durationMinutes } = validation;

  const targetMatchMinutes = fieldErrors.targetMatchMinutes
    ? null
    : wholeNumberOrNull(form.targetMatchMinutes);
  const changeoverMinutes = fieldErrors.changeoverMinutes
    ? null
    : wholeNumberOrNull(form.changeoverMinutes);
  const timing: SummaryTiming | null =
    durationMinutes !== null &&
    durationMinutes > 0 &&
    !fieldErrors.endTime &&
    targetMatchMinutes !== null &&
    changeoverMinutes !== null
      ? { durationMinutes, targetMatchMinutes, changeoverMinutes }
      : null;

  function updateForm(patch: Partial<SetupForm>) {
    setForm((currentForm) => ({ ...currentForm, ...patch }));
  }

  function addCourt(court: ClubCourt) {
    setClubCourts((currentCourts) => [...currentCourts, court]);
    // Select the new court when it can host the chosen format.
    if (court.supportedFormats.includes(form.matchFormat)) {
      updateForm({ selectedCourtIds: [...form.selectedCourtIds, court.id] });
    }
  }

  return (
    <>
      <SetupPageHeader
        actions={
          <>
            <SaveStatusIndicator status={status} onRetry={retry} />
            <DiscardDraftButton
              sessionId={draft.sessionId}
              onAutosavePausedChange={setIsAutosavePaused}
            />
          </>
        }
      />
      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-[18px]">
          <SessionDetailsCard
            form={form}
            fieldErrors={fieldErrors}
            durationMinutes={durationMinutes}
            isEndNextDay={validation.isEndNextDay}
            onChange={updateForm}
          />
          <CourtsCard
            clubCourts={clubCourts}
            selectedCourtIds={form.selectedCourtIds}
            matchFormat={form.matchFormat}
            attendingPlayerCount={draft.attendingPlayerCount}
            courtsError={fieldErrors.courts}
            onChange={updateForm}
            onCourtAdded={addCourt}
          />
        </div>
        <SessionSummary
          sessionName={form.name}
          plannedStart={validation.plannedStart}
          plannedEnd={validation.plannedEnd}
          timing={timing}
          courtCount={form.selectedCourtIds.length}
          matchFormat={form.matchFormat}
          attendingPlayerCount={draft.attendingPlayerCount}
          attendingGuestCount={draft.attendingGuestCount}
        />
      </div>
    </>
  );
}
