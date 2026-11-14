"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  ATTENTION_OUTLINE_BUTTON_CLASS_NAME,
  LINK_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import {
  applySavedSetup,
  readSessionDraft,
  saveSessionDraft,
  saveSetup,
  type ApplySavedSetupResult,
  type SaveSessionDraftResult,
} from "@/server/setup/setupActions";
import type {
  ClubCourt,
  DraftParticipant,
  SavedSetupSummary,
  SessionDraft,
} from "@/server/setup/setupDraft";
import type { SaveSessionDraftInput } from "@/server/setup/setupRules";
import { CoHostDraftNotice } from "./CoHostDraftNotice";
import { CourtsCard } from "./CourtsCard";
import { DiscardDraftButton } from "./DiscardDraftButton";
import { PendingCheckinTray } from "./PendingCheckinTray";
import {
  forgetShownConflict,
  ownDraftWritesNotYetLoaded,
  trackOwnDraftWrite,
} from "./ownDraftWrites";
import { RotationCard } from "./RotationCard";
import {
  ReuseSetupBanner,
  SavedSetupsButtons,
  SavedSetupsList,
  SaveSetupForm,
  type SavedSetupsPanel,
} from "./SavedSetups";
import { topObjectiveSummary } from "./rotationOptions";
import { SessionDetailsCard } from "./SessionDetailsCard";
import { SessionSummary, type SummaryTiming } from "./SessionSummary";
import { SetupPageHeader } from "./SetupPageHeader";
import { setupReadiness } from "./setupReadiness";
import { SetupStepper } from "./SetupStepper";
import {
  setupFormFromDraft,
  validateSetupForm,
  type SetupForm,
} from "./setupPlanning";
import { useDraftAttendance } from "./useDraftAttendance";
import { EMPTY_PARTICIPANT_FORM, type ParticipantForm } from "./whosPlaying";
import { WhosPlayingCard } from "./WhosPlayingCard";

/** Edits settle for this long before they are saved. */
const AUTOSAVE_DELAY_MS = 700;
/** How long a new editor waits for this tab's earlier writes before asking for a reload. */
const EARLIER_WRITES_WAIT_LIMIT_MS = 15_000;
const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection.";

function subscribeToNothing() {
  return () => {};
}

/**
 * The draft editor. Times are shown in the browser's time zone, which the
 * server doesn't know, so the form only renders in the browser (no server
 * render of local times that would then mismatch on hydration).
 */
export function SessionSetupEditor(props: SessionSetupFormProps) {
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
  return <SessionSetupAfterOwnWrites {...props} />;
}

/**
 * How this editor starts, given this tab's own earlier writes to the draft
 * (see ownDraftWrites.ts): `pending` waits for them (inputs disabled,
 * "Saving…"), `conflict` one was refused, `unreadable` the re-read failed.
 */
type EarlierOwnWrites = "settled" | "pending" | "conflict" | "unreadable";

type EditorStart =
  | { earlierOwnWrites: "settled"; draft: SessionDraft }
  | { earlierOwnWrites: Exclude<EarlierOwnWrites, "settled"> };

/**
 * Starts the form from a draft that includes this tab's own earlier writes.
 * A previous editor for this draft may have unmounted with a save on its
 * way, and the page data may have been read before it landed: then wait for
 * it and re-read the draft, so the form shows its values and builds on its
 * revision (not a false "changed elsewhere").
 */
function SessionSetupAfterOwnWrites(props: SessionSetupFormProps) {
  const loadedDraft = props.draft;
  const [editorStart, setEditorStart] = useState<EditorStart>(() =>
    ownDraftWritesNotYetLoaded(loadedDraft.sessionId, loadedDraft.draftRevision)
      ? { earlierOwnWrites: "pending" }
      : { earlierOwnWrites: "settled", draft: loadedDraft },
  );
  /**
   * Set once this mount's start is settled. Next's hidden <Activity> re-runs
   * effects but keeps refs, so coming back doesn't check again (the form's
   * own saves while hidden are its own business).
   */
  const isStartDecidedRef = useRef(false);
  useEffect(() => {
    if (isStartDecidedRef.current) return;
    // Checked again here, not just while rendering: a previous editor
    // unmounting in this same commit records its last save in its cleanup,
    // which runs after this render but before this effect.
    const { sessionId } = loadedDraft;
    const ownWrites = ownDraftWritesNotYetLoaded(
      sessionId,
      loadedDraft.draftRevision,
    );
    // The registry is outside React and only complete now (see above).
    setEditorStart((current) =>
      ownWrites
        ? { earlierOwnWrites: "pending" }
        : current.earlierOwnWrites === "pending"
          ? // They landed (or failed) without changing what was loaded.
            { earlierOwnWrites: "settled", draft: loadedDraft }
          : current,
    );
    if (!ownWrites) {
      isStartDecidedRef.current = true;
      return;
    }
    let isCurrent = true;
    let waitLimitTimeout: ReturnType<typeof setTimeout> | undefined;
    const waitLimitReached = new Promise<null>((resolve) => {
      waitLimitTimeout = setTimeout(
        () => resolve(null),
        EARLIER_WRITES_WAIT_LIMIT_MS,
      );
    });
    void (async () => {
      const outcome = await Promise.race([ownWrites.landed, waitLimitReached]);
      clearTimeout(waitLimitTimeout);
      if (outcome === null) {
        // A save that never answers: don't wait forever with inputs locked.
        if (!isCurrent) return;
        isStartDecidedRef.current = true;
        setEditorStart({ earlierOwnWrites: "unreadable" });
        return;
      }
      // A conflict not shown yet (it came with a save made while leaving) is
      // shown now; one already shown ends with a fresh read of the draft.
      const reread =
        outcome.isConflict && ownWrites.wasStillLanding
          ? null
          : await readSessionDraft(sessionId).catch(() => ({
              ok: false as const,
              message: OFFLINE_MESSAGE,
            }));
      // Hidden or unmounted meanwhile: the next effect run starts over.
      if (!isCurrent) return;
      isStartDecidedRef.current = true;
      if (reread?.ok)
        forgetShownConflict(sessionId, reread.draft.draftRevision);
      setEditorStart(
        reread === null
          ? { earlierOwnWrites: "conflict" }
          : reread.ok
            ? { earlierOwnWrites: "settled", draft: reread.draft }
            : { earlierOwnWrites: "unreadable" },
      );
    })();
    return () => {
      isCurrent = false;
      clearTimeout(waitLimitTimeout);
    };
  }, [loadedDraft]);

  const draft =
    editorStart.earlierOwnWrites === "settled"
      ? editorStart.draft
      : props.draft;
  return (
    <SessionSetupForm
      // Each start is a fresh form: its state comes from that draft.
      key={`${editorStart.earlierOwnWrites}:${draft.draftRevision}`}
      {...props}
      draft={draft}
      earlierOwnWrites={editorStart.earlierOwnWrites}
    />
  );
}

type SaveFailure = { saveInputKey: string; message: string };

/**
 * Saves the latest valid form after edits settle. One save runs at a time;
 * edits made meanwhile are saved right after it, newest wins. Leaving the
 * page within the settle delay still saves (on unmount), and closing the tab
 * with unsaved edits asks first.
 *
 * `holdAndSaveLatest` / `release` bracket a write that replaces the form from
 * the server (applying a saved setup): no autosave can start in between, and
 * the latest edits are saved first so the server works from them.
 *
 * Every save names the draft's settings revision it builds on. If another
 * tab or device saved in between, the server refuses (a conflict): autosave
 * then stops for good, the edits stay on screen, and only a reload goes on.
 * `startsInConflict`: an earlier editor in this tab already got that refusal.
 *
 * Every save is also recorded in ownDraftWrites.ts, so an editor mounted
 * after this one unmounts waits for it.
 */
function useDraftAutosave({
  sessionId,
  saveInput,
  isPaused,
  initialDraftRevision,
  startsInConflict,
}: {
  sessionId: string;
  saveInput: SaveSessionDraftInput | null;
  isPaused: boolean;
  initialDraftRevision: number;
  startsInConflict: boolean;
}) {
  const saveInputKey = useMemo(
    () => (saveInput ? JSON.stringify(saveInput) : null),
    [saveInput],
  );
  // The draft as loaded is already saved.
  const [lastSavedKey, setLastSavedKey] = useState(saveInputKey);
  const lastSavedKeyRef = useRef(saveInputKey);
  const [isSaving, setIsSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [isHeld, setIsHeld] = useState(startsInConflict);
  const isHeldRef = useRef(startsInConflict);
  /** The settings revision the next write builds on (from the load, then each write). */
  const draftRevisionRef = useRef(initialDraftRevision);
  const [isConflict, setIsConflict] = useState(startsInConflict);
  const isConflictRef = useRef(startsInConflict);
  /** Set by the Reload button so its own reload doesn't ask "leave page?". */
  const isReloadingDeliberatelyRef = useRef(false);
  const isSavingRef = useRef(false);
  const queuedSaveInputRef = useRef<SaveSessionDraftInput | null>(null);
  /** Key of the save awaiting the server, so the unmount flush doesn't repeat it. */
  const inFlightSaveKeyRef = useRef<string | null>(null);
  /** The running save loop; resolves with the result of its last save. */
  const saveLoopRef = useRef<Promise<SaveSessionDraftResult> | null>(null);

  const markSaved = useCallback((inputKey: string) => {
    lastSavedKeyRef.current = inputKey;
    setLastSavedKey(inputKey);
  }, []);

  /** Another tab or device changed the settings: never write again from here. */
  const markConflict = useCallback(() => {
    isHeldRef.current = true;
    isConflictRef.current = true;
    setIsHeld(true);
    setIsConflict(true);
  }, []);

  const runSave = useCallback(
    (input: SaveSessionDraftInput): Promise<SaveSessionDraftResult> => {
      if (isSavingRef.current && saveLoopRef.current) {
        queuedSaveInputRef.current = input;
        return saveLoopRef.current;
      }
      isSavingRef.current = true;
      setIsSaving(true);
      setFailure(null);
      const saveLoop = (async () => {
        let inputToSave = input;
        let result: SaveSessionDraftResult;
        for (;;) {
          inFlightSaveKeyRef.current = JSON.stringify(inputToSave);
          result = await saveSessionDraft(
            inputToSave,
            draftRevisionRef.current,
          ).catch(() => ({
            ok: false as const,
            message: OFFLINE_MESSAGE,
          }));
          if (result.ok) draftRevisionRef.current = result.draftRevision;
          const queuedInput = queuedSaveInputRef.current;
          queuedSaveInputRef.current = null;
          if (!result.ok && result.isConflict) {
            // Queued edits are dropped too: they'd overwrite the newer settings.
            markConflict();
            break;
          }
          if (queuedInput) {
            // Newer edits arrived while saving: save those (this result is stale).
            inputToSave = queuedInput;
            continue;
          }
          const inputKey = JSON.stringify(inputToSave);
          if (result.ok) markSaved(inputKey);
          else setFailure({ saveInputKey: inputKey, message: result.message });
          break;
        }
        inFlightSaveKeyRef.current = null;
        isSavingRef.current = false;
        saveLoopRef.current = null;
        setIsSaving(false);
        return result;
      })();
      saveLoopRef.current = saveLoop;
      trackOwnDraftWrite(sessionId, saveLoop);
      return saveLoop;
    },
    [sessionId, markSaved, markConflict],
  );

  const isAutosavePaused = isPaused || isHeld;
  useEffect(() => {
    if (isAutosavePaused || !saveInput || saveInputKey === lastSavedKey) return;
    // A failed save is retried by the host (Retry) or by their next edit.
    if (failure?.saveInputKey === saveInputKey) return;
    const timeout = setTimeout(() => {
      // A hold can begin before this effect re-runs to clear the timer.
      if (!isHeldRef.current) void runSave(saveInput);
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [
    isAutosavePaused,
    saveInput,
    saveInputKey,
    lastSavedKey,
    failure,
    runSave,
  ]);

  // The newest values, for the unmount flush below (refs are written after render).
  const latestRef = useRef({ saveInput, saveInputKey, isPaused });
  useEffect(() => {
    latestRef.current = { saveInput, saveInputKey, isPaused };
  });
  // Leaving (unmount) or being hidden: with cacheComponents, Next keeps
  // recent routes in a hidden <Activity>, which runs this cleanup but keeps
  // state and refs. So the flush goes through runSave: it records the new
  // revision and marks the edits saved, so coming back doesn't re-save with
  // a stale revision (a false "changed elsewhere"). After a true unmount,
  // runSave's record in ownDraftWrites.ts makes the next editor wait for this
  // save and re-read the draft. A full reload or closing the tab can't wait
  // for it: the "leave page?" prompt below covers that.
  useEffect(
    () => () => {
      const latest = latestRef.current;
      if (
        !latest.isPaused &&
        !isHeldRef.current &&
        latest.saveInput &&
        latest.saveInputKey !== lastSavedKeyRef.current &&
        latest.saveInputKey !== inFlightSaveKeyRef.current
      ) {
        void runSave(latest.saveInput);
      }
    },
    [runSave],
  );

  /**
   * Stops autosave, waits for any save, then saves the newest valid edits.
   * After a conflict nothing more is written: it returns the conflict.
   */
  const holdAndSaveLatest =
    useCallback(async (): Promise<SaveSessionDraftResult> => {
      isHeldRef.current = true;
      setIsHeld(true);
      if (saveLoopRef.current) await saveLoopRef.current;
      if (isConflictRef.current) {
        return {
          ok: false,
          message: "The setup was changed elsewhere.",
          isConflict: true,
        };
      }
      const latest = latestRef.current;
      if (
        !latest.saveInput ||
        latest.saveInputKey === lastSavedKeyRef.current
      ) {
        return { ok: true, draftRevision: draftRevisionRef.current };
      }
      return runSave(latest.saveInput);
    }, [runSave]);

  /**
   * Resumes autosave. After a server write that replaced the form, pass what
   * the server now holds (not saved again) and its settings revision.
   */
  const release = useCallback(
    (
      applied: {
        savedInput: SaveSessionDraftInput | null;
        draftRevision: number;
      } | null,
    ) => {
      if (applied) {
        draftRevisionRef.current = applied.draftRevision;
        if (applied.savedInput) markSaved(JSON.stringify(applied.savedInput));
      }
      isHeldRef.current = false;
      setIsHeld(false);
    },
    [markSaved],
  );

  const status: SaveStatus = isConflict
    ? { kind: "conflict" }
    : saveInput === null
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
      if (isReloadingDeliberatelyRef.current) return;
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
  /** The conflict banner's Reload: the host has been told edits here are lost. */
  const reloadDiscardingEdits = () => {
    isReloadingDeliberatelyRef.current = true;
    window.location.reload();
  };
  return {
    status,
    retry,
    holdAndSaveLatest,
    release,
    markConflict,
    draftRevisionRef,
    reloadDiscardingEdits,
  };
}

type SaveStatus =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "invalid" }
  | { kind: "failed"; message: string }
  /** A setup was applied but couldn't be read back; autosave stays held. */
  | { kind: "reloadRequired" }
  /** Another tab or device changed the settings; autosave has stopped. */
  | { kind: "conflict" };

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
        {status.kind === "conflict" && (
          <span className="text-orange-soft">
            <span aria-hidden="true">! </span>Not saved: changed elsewhere
          </span>
        )}
        {status.kind === "reloadRequired" && (
          <span className="text-orange-soft">
            <span aria-hidden="true">! </span>Not saved: reload the page
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

interface SessionSetupFormProps {
  draft: SessionDraft;
  initialClubCourts: ClubCourt[];
  /** Only the social manager adds courts. */
  canAddCourts: boolean;
  /** The host's own saved setups, most recently used first. */
  initialSavedSetups: SavedSetupSummary[];
  /** Named in the discard dialog: discarding affects every host of the social. */
  socialName: string;
}

/** What happened after saving or applying a setup (shown under the header). */
type SavedSetupMessage = { tone: "info" | "attention"; text: string };

/** Saving the latest edits, then applying a saved setup: where it stopped. */
type SavedSetupApplication =
  | {
      stoppedAt: "savingLatestEdits";
      result: Extract<SaveSessionDraftResult, { ok: false }>;
    }
  | { stoppedAt: "applying"; result: ApplySavedSetupResult };

/** The applying step as a settings write, for ownDraftWrites.ts. */
function draftWriteResultOf(
  application: SavedSetupApplication,
): SaveSessionDraftResult {
  if (application.stoppedAt === "savingLatestEdits") return application.result;
  const { result } = application;
  if (result.ok) return { ok: true, draftRevision: result.draft.draftRevision };
  return result.isConflict
    ? { ok: false, message: result.message, isConflict: true }
    : { ok: false, message: result.message };
}

function SessionSetupForm({
  draft,
  initialClubCourts,
  canAddCourts,
  initialSavedSetups,
  socialName,
  earlierOwnWrites,
}: SessionSetupFormProps & { earlierOwnWrites: EarlierOwnWrites }) {
  const isWaitingForEarlierWrites = earlierOwnWrites === "pending";
  const [clubCourts, setClubCourts] = useState(initialClubCourts);
  const [form, setForm] = useState<SetupForm>(() =>
    setupFormFromDraft(
      draft,
      new Set(initialClubCourts.map((court) => court.id)),
    ),
  );
  const [participantForm, setParticipantForm] = useState<ParticipantForm>(
    EMPTY_PARTICIPANT_FORM,
  );
  const [isAutosavePaused, setIsAutosavePaused] = useState(false);
  const [savedSetups, setSavedSetups] = useState(initialSavedSetups);
  const [appliedSavedSetupId, setAppliedSavedSetupId] = useState(
    draft.config.appliedSavedSetupId,
  );
  const [openSavedSetupsPanel, setOpenSavedSetupsPanel] =
    useState<SavedSetupsPanel>("none");
  const [isReuseBannerDismissed, setIsReuseBannerDismissed] = useState(false);
  const [isApplyingSetup, setIsApplyingSetup] = useState(false);
  const [savedSetupMessage, setSavedSetupMessage] =
    useState<SavedSetupMessage | null>(null);
  const [isReloadRequired, setIsReloadRequired] = useState(false);
  const validation = useMemo(
    () => validateSetupForm(form, draft.sessionId),
    [form, draft.sessionId],
  );
  const {
    status: autosaveStatus,
    retry,
    holdAndSaveLatest,
    release,
    markConflict,
    draftRevisionRef,
    reloadDiscardingEdits,
  } = useDraftAutosave({
    sessionId: draft.sessionId,
    saveInput: validation.saveInput,
    isPaused:
      isAutosavePaused ||
      isWaitingForEarlierWrites ||
      earlierOwnWrites === "unreadable",
    initialDraftRevision: draft.draftRevision,
    startsInConflict: earlierOwnWrites === "conflict",
  });
  const status: SaveStatus = isWaitingForEarlierWrites
    ? { kind: "saving" }
    : isReloadRequired || earlierOwnWrites === "unreadable"
      ? { kind: "reloadRequired" }
      : autosaveStatus;
  const { fieldErrors, durationMinutes } = validation;
  const attendance = useDraftAttendance(draft.sessionId, draft.participants);
  const { addApprovedParticipant, rereadParticipants } = attendance;
  const showApprovedCheckin = useCallback(
    (approvedParticipant: DraftParticipant | null) => {
      if (approvedParticipant) addApprovedParticipant(approvedParticipant);
      else void rereadParticipants();
    },
    [addApprovedParticipant, rereadParticipants],
  );
  const showAttendanceChangedElsewhere = useCallback(() => {
    void rereadParticipants();
  }, [rereadParticipants]);
  const attendingPlayerCount = attendance.participants.length;
  const readiness = setupReadiness({
    fieldErrors,
    selectedCourtCount: form.selectedCourtIds.length,
    matchFormat: form.matchFormat,
    attendingPlayerCount,
    participantForm,
    isDraftSaved: status.kind === "saved",
  });

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

  async function saveThisSetup(setupName: string) {
    if (!validation.saveInput) {
      return {
        ok: false as const,
        message: "Fix the highlighted fields first, then save the setup.",
      };
    }
    const result = await saveSetup({
      setupName,
      draft: validation.saveInput,
    }).catch(() => ({ ok: false as const, message: OFFLINE_MESSAGE }));
    if (result.ok) {
      setSavedSetups(result.savedSetups);
      setOpenSavedSetupsPanel("none");
      // It's what's on screen already: no need to offer it back.
      setIsReuseBannerDismissed(true);
      setSavedSetupMessage({ tone: "info", text: result.message });
    }
    return result;
  }

  async function applySetup(setup: SavedSetupSummary) {
    setSavedSetupMessage(null);
    // Applying replaces the form, so invalid edits (which can't be saved
    // first) would be lost without a word: refuse instead.
    if (!validation.saveInput) {
      setSavedSetupMessage({
        tone: "attention",
        text: `Fix the highlighted fields first, then use \u201c${setup.name}\u201d.`,
      });
      return;
    }
    setIsApplyingSetup(true);
    const application = saveLatestEditsThenApply(setup.setupId);
    // Recorded from the start, as one write: an editor mounted after leaving
    // mid-apply waits for all of it.
    trackOwnDraftWrite(draft.sessionId, application.then(draftWriteResultOf));
    const applied = await application;
    if (applied.stoppedAt === "savingLatestEdits") {
      const flushed = applied.result;
      setIsApplyingSetup(false);
      if (flushed.isConflict) return;
      release(null);
      setSavedSetupMessage({
        tone: "attention",
        text: `Your latest edits couldn't be saved, so \u201c${setup.name}\u201d wasn't applied. ${flushed.message}`,
      });
      return;
    }
    const result = applied.result;
    setIsApplyingSetup(false);
    if (!result.ok) {
      // Applied but not read back: keep autosave held so the stale screen
      // can't overwrite it; the message asks for a reload.
      if ("requiresReload" in result && result.requiresReload) {
        setIsReloadRequired(true);
      } else if ("isConflict" in result && result.isConflict) {
        markConflict();
        return;
      } else {
        release(null);
      }
      setSavedSetupMessage({ tone: "attention", text: result.message });
      return;
    }
    // A court added since this page loaded is still a club court: keep it
    // (its other formats aren't known here, so it offers the applied one).
    const knownCourtIds = new Set(clubCourts.map((court) => court.id));
    const newCourts: ClubCourt[] = result.draft.config.courts
      .filter((court) => !knownCourtIds.has(court.courtId))
      .map((court) => ({
        id: court.courtId,
        name: court.name,
        supportedFormats: [court.format],
      }));
    if (newCourts.length > 0) {
      setClubCourts((currentCourts) => [...currentCourts, ...newCourts]);
    }
    const appliedForm = setupFormFromDraft(
      result.draft,
      new Set([...knownCourtIds, ...newCourts.map((court) => court.id)]),
    );
    setForm(appliedForm);
    release({
      savedInput: validateSetupForm(appliedForm, draft.sessionId).saveInput,
      draftRevision: result.draft.draftRevision,
    });
    setSavedSetups(result.savedSetups);
    setAppliedSavedSetupId(setup.setupId);
    setOpenSavedSetupsPanel("none");
    setSavedSetupMessage({
      tone: result.notice ? "attention" : "info",
      text: [`Using \u201c${setup.name}\u201d.`, result.notice]
        .filter(Boolean)
        .join(" "),
    });
  }

  /**
   * The server applies on top of the saved draft, so the latest edits are
   * saved first, with autosave held so it can't write stale values meanwhile.
   */
  async function saveLatestEditsThenApply(
    setupId: string,
  ): Promise<SavedSetupApplication> {
    const flushed = await holdAndSaveLatest();
    if (!flushed.ok) return { stoppedAt: "savingLatestEdits", result: flushed };
    const result = await applySavedSetup({
      sessionId: draft.sessionId,
      setupId,
      expectedDraftRevision: draftRevisionRef.current,
    }).catch(() => ({ ok: false as const, message: OFFLINE_MESSAGE }));
    return { stoppedAt: "applying", result };
  }

  const reuseCandidate =
    savedSetups.length > 0 && !appliedSavedSetupId && !isReuseBannerDismissed
      ? savedSetups[0]
      : null;

  return (
    // Nothing is editable until this tab's earlier writes have landed.
    <fieldset
      disabled={isWaitingForEarlierWrites}
      aria-busy={isWaitingForEarlierWrites}
      className="contents"
    >
      <SetupPageHeader
        actions={
          <>
            <SaveStatusIndicator status={status} onRetry={retry} />
            <SavedSetupsButtons
              isDisabled={isApplyingSetup || status.kind === "conflict"}
              openPanel={openSavedSetupsPanel}
              onOpenPanelChange={setOpenSavedSetupsPanel}
            />
            <DiscardDraftButton
              sessionId={draft.sessionId}
              draftName={form.name}
              plannedStart={validation.plannedStart}
              plannedEnd={validation.plannedEnd}
              attendingPlayerCount={attendingPlayerCount}
              hostName={form.hostName}
              socialName={socialName}
              onAutosavePausedChange={setIsAutosavePaused}
            />
          </>
        }
      />
      {openSavedSetupsPanel === "list" && (
        <SavedSetupsList
          savedSetups={savedSetups}
          isApplying={isApplyingSetup || status.kind === "conflict"}
          onUse={(setup) => void applySetup(setup)}
        />
      )}
      {openSavedSetupsPanel === "save" && (
        <SaveSetupForm
          isDisabled={isApplyingSetup || status.kind === "conflict"}
          defaultName={form.name}
          onSave={saveThisSetup}
          onClose={() => setOpenSavedSetupsPanel("none")}
        />
      )}
      <CoHostDraftNotice />
      <div aria-live="polite" className="empty:hidden">
        {savedSetupMessage &&
          (savedSetupMessage.tone === "info" ? (
            <p className="text-[15px] text-lime-soft">
              {savedSetupMessage.text}
            </p>
          ) : (
            <AttentionMessage>{savedSetupMessage.text}</AttentionMessage>
          ))}
      </div>
      {status.kind === "conflict" && (
        <DraftConflictBanner onReload={reloadDiscardingEdits} />
      )}
      {reuseCandidate && status.kind !== "conflict" && (
        <ReuseSetupBanner
          setup={reuseCandidate}
          isApplying={isApplyingSetup}
          onUse={() => void applySetup(reuseCandidate)}
          onDismiss={() => setIsReuseBannerDismissed(true)}
        />
      )}
      <SetupStepper steps={readiness.steps} />
      <PendingCheckinTray
        onParticipantApproved={showApprovedCheckin}
        onAttendanceChangedElsewhere={showAttendanceChangedElsewhere}
      />
      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-[18px]">
          {/* Applying a setup replaces these values: no edits meanwhile. */}
          <fieldset disabled={isApplyingSetup} className="contents">
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
              attendingPlayerCount={attendingPlayerCount}
              courtsError={fieldErrors.courts}
              canAddCourts={canAddCourts}
              onChange={updateForm}
              onCourtAdded={addCourt}
            />
          </fieldset>
          <WhosPlayingCard
            attendance={attendance}
            participantForm={participantForm}
            onParticipantFormChange={setParticipantForm}
          />
          <fieldset disabled={isApplyingSetup} className="contents">
            <RotationCard
              rotation={form.rotation}
              onChange={(rotation) => updateForm({ rotation })}
            />
          </fieldset>
        </div>
        <SessionSummary
          sessionName={form.name}
          plannedStart={validation.plannedStart}
          plannedEnd={validation.plannedEnd}
          timing={timing}
          courtCount={form.selectedCourtIds.length}
          matchFormat={form.matchFormat}
          attendingPlayerCount={attendingPlayerCount}
          rotationSummary={topObjectiveSummary(form.rotation)}
          readiness={readiness}
        />
      </div>
    </fieldset>
  );
}

/** DESIGN.md "Updated by another host": settings changed by a co-host, another tab or device. */
function DraftConflictBanner({ onReload }: { onReload: () => void }) {
  return (
    <section
      aria-label="Setup changed elsewhere"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[14px] border border-orange-edge bg-orange-surface px-3.5 py-2.5"
    >
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-orange text-xs font-extrabold text-on-orange"
      >
        !
      </span>
      <p className="min-w-0 flex-[1_1_300px] text-sm text-orange-text">
        Setup was changed by another host, tab or device. Reload to see the
        latest &mdash; your unsaved changes here will be lost.
      </p>
      <button
        type="button"
        onClick={onReload}
        className={ATTENTION_OUTLINE_BUTTON_CLASS_NAME}
      >
        Reload
      </button>
    </section>
  );
}
