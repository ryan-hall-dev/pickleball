"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  addDraftParticipant,
  readSessionDraft,
  removeDraftParticipant,
  type DraftAttendanceResult,
  type SaveSessionDraftResult,
} from "@/server/setup/setupActions";
import type { Gender } from "@/server/participantRules";
import type { SkillLevel } from "@/server/skillLevels";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import {
  applyAttendanceChange,
  pruneFailuresTouchedBy,
  type AttendanceChange,
  type AttendanceFailure,
  type QueuedAttendanceChange,
} from "./whosPlaying";
import { en } from "@/i18n/messages/en";

const OFFLINE_MESSAGE = en.serverMessages.offline;

function submitAttendanceChange(
  sessionId: string,
  change: AttendanceChange,
): Promise<DraftAttendanceResult> {
  switch (change.kind) {
    case "addParticipant":
      return addDraftParticipant({
        sessionId,
        participantId: change.participantId,
        firstName: change.participant.firstName,
        lastName: change.participant.lastName,
        skillLevel: change.participant.skillLevel,
        gender: change.participant.gender,
      });
    case "removeParticipant":
      return removeDraftParticipant({
        sessionId,
        participantId: change.participantId,
      });
  }
}

/**
 * The draft's attendee list. Each change is written straight away (not part
 * of the details autosave), one at a time in the order made, and shows at
 * once. After every write the list is replaced by the server's, so changes
 * from another tab appear too; changes still waiting are applied on top.
 * Failed changes are dropped from the screen and kept for Retry, minus
 * anything the host has changed since. Check-ins approved in the tray are
 * added at once; ones approved by another host appear when the tray asks
 * for a re-read.
 */
export function useDraftAttendance(
  sessionId: string,
  initialParticipants: DraftParticipant[],
  saveParticipantDetails?: (
    participantId: string,
    gender: Gender,
    skillLevel: SkillLevel,
  ) => Promise<SaveSessionDraftResult>,
) {
  const [savedParticipants, setSavedParticipants] =
    useState(initialParticipants);
  // The first entry is the one being written.
  const [queuedChanges, setQueuedChanges] = useState<QueuedAttendanceChange[]>(
    [],
  );
  const [failures, setFailures] = useState<AttendanceFailure[]>([]);
  /** Set when a write landed but the list couldn't be read back. */
  const [refreshProblem, setRefreshProblem] = useState<string | null>(null);
  const queuedChangesRef = useRef<QueuedAttendanceChange[]>([]);
  const isWritingRef = useRef(false);
  /** Bumped whenever the saved list changes, so an older re-read can't replace it. */
  const savedListVersionRef = useRef(0);
  /** The newest re-read started; an earlier one answering later is dropped. */
  const latestRereadRef = useRef(0);

  const writeQueuedChanges = useCallback(async () => {
    if (isWritingRef.current) return;
    isWritingRef.current = true;
    while (queuedChangesRef.current.length > 0) {
      const queued = queuedChangesRef.current[0];
      const result = await submitAttendanceChange(
        sessionId,
        queued.change,
      ).catch(() => ({ ok: false as const, message: OFFLINE_MESSAGE }));
      queuedChangesRef.current = queuedChangesRef.current.slice(1);
      setQueuedChanges(queuedChangesRef.current);
      savedListVersionRef.current += 1;
      if (!result.ok) {
        setFailures((currentFailures) => [
          ...currentFailures,
          { ...queued, message: result.message },
        ]);
      } else if (result.participants) {
        setSavedParticipants(result.participants);
        setRefreshProblem(null);
      } else {
        // Saved: keep showing it, and ask for a reload to see the real list.
        setSavedParticipants((currentParticipants) =>
          applyAttendanceChange(currentParticipants, queued.change),
        );
        setRefreshProblem(result.message);
      }
    }
    isWritingRef.current = false;
  }, [sessionId]);

  const queueChange = useCallback(
    (queued: QueuedAttendanceChange) => {
      setFailures((currentFailures) =>
        pruneFailuresTouchedBy(currentFailures, queued.change),
      );
      queuedChangesRef.current = [...queuedChangesRef.current, queued];
      setQueuedChanges(queuedChangesRef.current);
      void writeQueuedChanges();
    },
    [writeQueuedChanges],
  );

  const retryFailures = useCallback(() => {
    setFailures([]);
    for (const failure of failures) {
      queueChange({ change: failure.change, description: failure.description });
    }
  }, [failures, queueChange]);

  /** A check-in this host approved: shown at once (no-op if already listed). */
  const addApprovedParticipant = useCallback(
    (approvedParticipant: DraftParticipant) => {
      savedListVersionRef.current += 1;
      setSavedParticipants((currentParticipants) =>
        currentParticipants.some(
          (participant) =>
            participant.participantId === approvedParticipant.participantId,
        )
          ? currentParticipants
          : [...currentParticipants, approvedParticipant],
      );
    },
    [],
  );

  /**
   * Re-reads the attendee list (another host approved a check-in). Skipped
   * while a write is on its way: its answer brings the list back anyway. A
   * re-read that a write, an approval or a newer re-read overtook is
   * dropped. A failed re-read changes nothing: the tray asks again on the
   * next change it sees, and every write here returns the whole list.
   * Relies on Next running a page's server actions one at a time, in order:
   * a write's list is read after any re-read sent before it.
   */
  const rereadParticipants = useCallback(async () => {
    if (isWritingRef.current) return;
    latestRereadRef.current += 1;
    const reread = latestRereadRef.current;
    const versionAtStart = savedListVersionRef.current;
    const result = await readSessionDraft(sessionId).catch(() => null);
    if (
      !result?.ok ||
      reread !== latestRereadRef.current ||
      versionAtStart !== savedListVersionRef.current ||
      isWritingRef.current
    ) {
      return;
    }
    savedListVersionRef.current += 1;
    setSavedParticipants(result.draft.participants);
  }, [sessionId]);

  const participants = useMemo(
    () =>
      queuedChanges.reduce(
        (currentParticipants, queued) =>
          applyAttendanceChange(currentParticipants, queued.change),
        savedParticipants,
      ),
    [queuedChanges, savedParticipants],
  );

  return {
    participants,
    completeParticipantDetails: saveParticipantDetails
      ? async (
          participantId: string,
          gender: Gender,
          skillLevel: SkillLevel,
        ) => {
          if (isWritingRef.current)
            return {
              ok: false,
              message: en.serverMessages.setup.waitForAttendance,
            };
          isWritingRef.current = true;
          try {
            const result = await saveParticipantDetails(
              participantId,
              gender,
              skillLevel,
            );
            if (result.ok) {
              savedListVersionRef.current += 1;
              setSavedParticipants((current) =>
                current.map((participant) =>
                  participant.participantId === participantId
                    ? { ...participant, gender, skillLevel }
                    : participant,
                ),
              );
            }
            return result;
          } finally {
            isWritingRef.current = false;
            void writeQueuedChanges();
          }
        }
      : undefined,
    pendingChanges: queuedChanges,
    failures,
    refreshProblem,
    queueChange,
    retryFailures,
    addApprovedParticipant,
    rereadParticipants,
  };
}

export type DraftAttendance = ReturnType<typeof useDraftAttendance>;
