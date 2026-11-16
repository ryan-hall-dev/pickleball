"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import { AttentionMessage } from "@/components/AttentionMessage";
import {
  ATTENTION_OUTLINE_BUTTON_CLASS_NAME,
  CARD_CLASS_NAME,
  LINK_BUTTON_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import {
  readSessionDraft,
  saveSimpleSessionDraft,
  setDraftParticipantDetails,
  type SaveSessionDraftResult,
} from "@/server/setup/setupActions";
import { startSimpleSession } from "@/server/setup/startSimpleSession";
import type { DraftParticipant, SessionDraft } from "@/server/setup/setupDraft";
import {
  saveSimpleSessionDraftInputSchema,
  type SaveSimpleSessionDraftInput,
} from "@/server/setup/setupRules";
import { CoHostDraftNotice } from "./CoHostDraftNotice";
import { DiscardDraftButton } from "./DiscardDraftButton";
import { PendingCheckinTray } from "./PendingCheckinTray";
import {
  forgetShownConflict,
  ownDraftWritesNotYetLoaded,
  trackOwnDraftWrite,
} from "./ownDraftWrites";
import { SetupPageHeader } from "./SetupPageHeader";
import {
  isParticipantFormUnfinished,
  unfinishedParticipantFormMessage,
} from "./setupReadiness";
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
  saveInput: SaveSimpleSessionDraftInput | null;
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
  const queuedSaveInputRef = useRef<SaveSimpleSessionDraftInput | null>(null);
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
    (input: SaveSimpleSessionDraftInput): Promise<SaveSessionDraftResult> => {
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
          result = await saveSimpleSessionDraft(
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
        savedInput: SaveSimpleSessionDraftInput | null;
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

interface SessionSetupFormProps {
  draft: SessionDraft;
  socialName: string;
}

function SessionSetupForm({
  draft,
  socialName,
  earlierOwnWrites,
}: SessionSetupFormProps & { earlierOwnWrites: EarlierOwnWrites }) {
  const router = useRouter();
  const [form, setForm] = useState(() => ({
    name: draft.name,
    courtCount: String(draft.config.courts.length),
    durationMinutes: String(
      (Date.parse(draft.plannedEnd) - Date.parse(draft.plannedStart)) / 60_000,
    ),
  }));
  const [participantForm, setParticipantForm] = useState<ParticipantForm>(
    EMPTY_PARTICIPANT_FORM,
  );
  const [isAutosavePaused, setIsAutosavePaused] = useState(false);
  const [isCompletingParticipantDetails, setIsCompletingParticipantDetails] =
    useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [hasAttemptedStart, setHasAttemptedStart] = useState(false);
  const startEventIdRef = useRef<string | null>(null);
  const startDialogRef = useRef<HTMLDialogElement>(null);
  const isWaitingForEarlierWrites = earlierOwnWrites === "pending";
  const validation = useMemo(() => {
    const parsed = saveSimpleSessionDraftInputSchema.safeParse({
      sessionId: draft.sessionId,
      name: form.name,
      courtCount: /^\d+$/.test(form.courtCount.trim())
        ? Number(form.courtCount)
        : NaN,
      durationMinutes: /^\d+$/.test(form.durationMinutes.trim())
        ? Number(form.durationMinutes)
        : NaN,
    });
    const fieldErrors: Record<string, string> = {};
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        fieldErrors[String(issue.path[0])] ??= issue.message;
    return { saveInput: parsed.success ? parsed.data : null, fieldErrors };
  }, [draft.sessionId, form]);
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
    : earlierOwnWrites === "unreadable"
      ? { kind: "reloadRequired" }
      : autosaveStatus;
  const attendance = useDraftAttendance(
    draft.sessionId,
    draft.participants,
    async (participantId, gender, skillLevel) => {
      setIsCompletingParticipantDetails(true);
      const write = (async (): Promise<SaveSessionDraftResult> => {
        const saved = await holdAndSaveLatest();
        if (!saved.ok) {
          if (!saved.isConflict) release(null);
          return saved;
        }
        const result = await setDraftParticipantDetails({
          sessionId: draft.sessionId,
          participantId,
          gender,
          skillLevel,
          expectedDraftRevision: draftRevisionRef.current,
        }).catch(() => ({ ok: false as const, message: OFFLINE_MESSAGE }));
        if (result.ok)
          release({ savedInput: null, draftRevision: result.draftRevision });
        else if ("isConflict" in result && result.isConflict) markConflict();
        else release(null);
        return result;
      })();
      trackOwnDraftWrite(draft.sessionId, write);
      return write.finally(() => setIsCompletingParticipantDetails(false));
    },
  );
  const { addApprovedParticipant, rereadParticipants } = attendance;
  const showApprovedCheckin = useCallback(
    (approved: DraftParticipant | null) => {
      if (approved) addApprovedParticipant(approved);
      else void rereadParticipants();
    },
    [addApprovedParticipant, rereadParticipants],
  );
  const showAttendanceChangedElsewhere = useCallback(() => {
    void rereadParticipants();
  }, [rereadParticipants]);
  const unfinishedParticipant = isParticipantFormUnfinished(participantForm);
  const missingDetails = attendance.participants.some(
    (player) => player.gender === null || player.skillLevel === null,
  );
  const attendanceBusy =
    attendance.pendingChanges.length > 0 ||
    attendance.failures.length > 0 ||
    attendance.refreshProblem !== null;
  const ready =
    validation.saveInput !== null &&
    attendance.participants.length >= 4 &&
    !unfinishedParticipant &&
    !missingDetails &&
    !attendanceBusy &&
    !isCompletingParticipantDetails &&
    status.kind === "saved";

  function openStartDialog() {
    if (!ready) return;
    setStartError(null);
    setHasAttemptedStart(false);
    startEventIdRef.current = crypto.randomUUID();
    startDialogRef.current?.showModal();
  }
  async function confirmStart() {
    if (isStarting) return;
    setIsStarting(true);
    setStartError(null);
    const saved = await holdAndSaveLatest();
    if (!saved.ok) {
      setStartError(saved.message);
      if (!saved.isConflict) release(null);
      setIsStarting(false);
      return;
    }
    setHasAttemptedStart(true);
    const result = await startSimpleSession({
      sessionId: draft.sessionId,
      eventId: startEventIdRef.current!,
      expectedDraftRevision: draftRevisionRef.current,
    }).catch(() => ({
      ok: false as const,
      message:
        "Couldn't confirm whether the session started. Retry with the same action, or reload.",
    }));
    if (result.ok) {
      // Cached routes retain the dialog; release its modal inertness before leaving.
      startDialogRef.current?.close();
      router.push("/live");
      router.refresh();
      return;
    }
    setStartError(result.message);
    setIsStarting(false);
    if ("isConflict" in result && result.isConflict) markConflict();
  }
  function closeStartDialog() {
    if (isStarting || hasAttemptedStart) return;
    startDialogRef.current?.close();
  }
  const blocked =
    isWaitingForEarlierWrites ||
    isCompletingParticipantDetails ||
    isStarting ||
    hasAttemptedStart;
  return (
    <>
      <fieldset
        disabled={blocked}
        aria-busy={
          isWaitingForEarlierWrites ||
          isCompletingParticipantDetails ||
          isStarting
        }
        className="contents"
      >
        <SetupPageHeader
          actions={
            <>
              <SaveStatusIndicator status={status} onRetry={retry} />
              <DiscardDraftButton
                sessionId={draft.sessionId}
                draftName={form.name}
                plannedStart={null}
                plannedEnd={null}
                attendingPlayerCount={attendance.participants.length}
                hostName=""
                socialName={socialName}
                onAutosavePausedChange={setIsAutosavePaused}
              />
            </>
          }
        />
        <CoHostDraftNotice />
        {status.kind === "conflict" && (
          <DraftConflictBanner onReload={reloadDiscardingEdits} />
        )}
        <section
          aria-labelledby="short-setup-heading"
          className={`${CARD_CLASS_NAME} flex flex-col gap-4`}
        >
          <h2 id="short-setup-heading" className="text-xl font-bold">
            A simple start
          </h2>
          <p className="text-sm text-muted">
            Set the space and session length. Players check in for today.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                { key: "name", label: "Session name", type: "text" },
                { key: "courtCount", label: "Court count", type: "number" },
                {
                  key: "durationMinutes",
                  label: "Session duration (minutes)",
                  type: "number",
                },
              ] as const
            ).map(({ key, label, type }) => (
              <label
                key={key}
                className={`flex flex-col gap-1.5 text-sm text-muted ${key === "name" ? "sm:col-span-2" : ""}`}
              >
                {label}
                <input
                  type={type}
                  value={form[key]}
                  min={type === "number" ? 1 : undefined}
                  max={
                    key === "courtCount"
                      ? 1000
                      : key === "durationMinutes"
                        ? 720
                        : undefined
                  }
                  step={type === "number" ? 1 : undefined}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                  aria-invalid={Boolean(validation.fieldErrors[key])}
                  aria-describedby={
                    validation.fieldErrors[key]
                      ? `setup-error-${key}`
                      : undefined
                  }
                  className="h-12 min-w-0 rounded-[14px] border border-inner-border bg-inner px-3.5 text-base text-text"
                />
                {validation.fieldErrors[key] && (
                  <span
                    id={`setup-error-${key}`}
                    className="text-xs text-orange-text"
                  >
                    {validation.fieldErrors[key]}
                  </span>
                )}
              </label>
            ))}
          </div>
          <p className="text-sm text-muted">
            Courts are numbered automatically. The duration begins when you
            start the session.
          </p>
          <div className="rounded-2xl border border-inner-border bg-inner p-4">
            <h3 className="font-bold">Doubles, every game</h3>
            <p className="mt-1 text-sm text-muted">
              Four men, four women, or mixed with one man and one woman on each
              team.
            </p>
          </div>
        </section>
        <PendingCheckinTray
          onParticipantApproved={showApprovedCheckin}
          onAttendanceChangedElsewhere={showAttendanceChangedElsewhere}
        />
        <WhosPlayingCard
          attendance={attendance}
          participantForm={participantForm}
          onParticipantFormChange={setParticipantForm}
        />
        <section
          aria-label="Start session"
          className={`${CARD_CLASS_NAME} flex flex-col gap-3`}
        >
          <p className="text-sm text-muted">
            {attendance.participants.length} players approved ·{" "}
            {form.courtCount || "0"} courts · {form.durationMinutes || "0"}{" "}
            minutes
          </p>
          {unfinishedParticipant && (
            <p className="text-sm text-orange-text">
              {unfinishedParticipantFormMessage(participantForm)}
            </p>
          )}
          {attendance.participants.length < 4 && (
            <p className="text-sm text-orange-text">
              Approve or add at least four players before starting.
            </p>
          )}
          {missingDetails && (
            <p className="text-sm text-orange-text">
              Complete every player&apos;s gender and level before starting.
            </p>
          )}
          {attendanceBusy && (
            <p className="text-sm text-orange-text">
              Wait for player changes to save and resolve any errors.
            </p>
          )}
          <button
            type="button"
            disabled={!ready}
            onClick={openStartDialog}
            className={`${PRIMARY_BUTTON_CLASS_NAME} w-full`}
          >
            Start session
          </button>
        </section>
      </fieldset>
      <dialog
        ref={startDialogRef}
        aria-labelledby="confirm-start-heading"
        onCancel={(event) => {
          event.preventDefault();
          closeStartDialog();
        }}
        className="m-auto w-[calc(100%-32px)] max-w-[560px] rounded-[28px] border border-card-border bg-card p-6 text-text shadow-[0_24px_64px_rgba(0,0,0,0.5)] backdrop:bg-bg-backdrop/90"
      >
        <h2 id="confirm-start-heading" className="text-[26px] font-extrabold">
          Start {form.name.trim()}?
        </h2>
        <p className="mt-3 text-muted">
          {attendance.participants.length} players · {form.courtCount} courts ·{" "}
          {form.durationMinutes} minutes. The session clock starts now.
          You&apos;ll call and start games from the live screen.
        </p>
        {startError && (
          <div role="alert" className="mt-3">
            <AttentionMessage>{startError}</AttentionMessage>
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          {hasAttemptedStart ? (
            <button
              type="button"
              disabled={isStarting}
              className={OUTLINE_BUTTON_CLASS_NAME}
              onClick={reloadDiscardingEdits}
            >
              Reload session
            </button>
          ) : (
            <button
              type="button"
              disabled={isStarting}
              className={OUTLINE_BUTTON_CLASS_NAME}
              onClick={closeStartDialog}
            >
              Keep editing
            </button>
          )}
          <button
            type="button"
            disabled={isStarting || status.kind === "conflict"}
            className={PRIMARY_BUTTON_CLASS_NAME}
            onClick={() => void confirmStart()}
          >
            {isStarting
              ? "Starting…"
              : hasAttemptedStart
                ? "Retry start"
                : "Confirm start"}
          </button>
        </div>
      </dialog>
    </>
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
