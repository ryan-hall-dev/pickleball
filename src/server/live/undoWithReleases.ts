import {
  calledSeats,
  compensate,
  applyEvent,
  isSimpleSocialV2,
  type EventMeta,
  type SessionState,
} from "@/engine/session";

// simple-social-v2 lines up a court's next four as soon as its game starts,
// so an accidental Start or Finish almost always has a newer Up next group in
// its way. Undo releases just those groups first; the app lines up again by
// itself afterwards.

/** Called groups that must go before `targetSeq` can be undone. */
export function groupsBlockingUndo(
  state: SessionState,
  targetSeq: number,
): string[] {
  if (!isSimpleSocialV2(state.config)) return [];
  const target = state.history.find((entry) => entry.event.seq === targetSeq);
  if (!target) return [];
  const match = Object.values(state.matches).find((candidate) =>
    target.event.type === "MatchStarted"
      ? candidate.startedBySeq === targetSeq
      : candidate.endedBySeq === targetSeq,
  );
  if (!match) return [];
  const players = new Set(match.segments.map((seat) => seat.participantId));
  return Object.values(state.courts).flatMap((court) => {
    const group = court.nextGroup;
    if (!group) return [];
    const blocks =
      // A start's undo brings its own group back to that court.
      (target.event.type === "MatchStarted" &&
        court.court.courtId === match.courtId) ||
      calledSeats(group).some((id) => id !== null && players.has(id));
    return blocks ? [group.calledEventId] : [];
  });
}

/** Whether Undo would work once the blocking groups are released. */
export function canUndoAfterReleases(
  state: SessionState,
  targetSeq: number,
  probe: EventMeta,
): boolean {
  let current = state;
  let seq = probe.seq;
  for (const calledEventId of groupsBlockingUndo(state, targetSeq)) {
    const released = applyEvent(current, {
      ...probe,
      seq,
      eventId: `${probe.eventId}-${seq}`,
      type: "NextGroupReleased",
      payload: { calledEventId },
    });
    if (!released.ok) return false;
    current = released.state;
    seq += 1;
  }
  return compensate(current, targetSeq, { ...probe, seq }).ok;
}
