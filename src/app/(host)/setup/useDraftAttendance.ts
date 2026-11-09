"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { ActiveMemberChoice } from "@/server/members/memberDirectory";
import {
  addDraftGuest,
  removeDraftGuest,
  setDraftMemberAttendance,
  type DraftAttendanceResult,
} from "@/server/setup/setupActions";
import type { DraftParticipant } from "@/server/setup/setupDraft";
import {
  applyAttendanceChange,
  pruneFailuresTouchedBy,
  type AttendanceChange,
  type AttendanceFailure,
  type QueuedAttendanceChange,
} from "./whosPlaying";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection.";

function submitAttendanceChange(
  sessionId: string,
  change: AttendanceChange,
): Promise<DraftAttendanceResult> {
  switch (change.kind) {
    case "setMembers":
      return setDraftMemberAttendance({
        sessionId,
        memberIds: change.memberIds,
        attending: change.attending,
      });
    case "addGuest":
      return addDraftGuest({
        sessionId,
        participantId: change.participantId,
        firstName: change.guest.firstName,
        lastName: change.guest.lastName,
        skillLevel: change.guest.skillLevel ?? "",
      });
    case "removeGuest":
      return removeDraftGuest({
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
 * anything the host has changed since.
 */
export function useDraftAttendance(
  sessionId: string,
  initialParticipants: DraftParticipant[],
  activeMembers: readonly ActiveMemberChoice[],
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

  const activeMembersById = useMemo(
    () => new Map(activeMembers.map((member) => [member.id, member])),
    [activeMembers],
  );

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
          applyAttendanceChange(
            currentParticipants,
            queued.change,
            activeMembersById,
          ),
        );
        setRefreshProblem(result.message);
      }
    }
    isWritingRef.current = false;
  }, [sessionId, activeMembersById]);

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

  const participants = useMemo(
    () =>
      queuedChanges.reduce(
        (currentParticipants, queued) =>
          applyAttendanceChange(
            currentParticipants,
            queued.change,
            activeMembersById,
          ),
        savedParticipants,
      ),
    [queuedChanges, savedParticipants, activeMembersById],
  );

  return {
    participants,
    pendingChanges: queuedChanges,
    failures,
    refreshProblem,
    queueChange,
    retryFailures,
  };
}

export type DraftAttendance = ReturnType<typeof useDraftAttendance>;
