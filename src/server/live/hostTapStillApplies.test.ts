// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@/engine/session";
import {
  fixtureCourtId,
  makeConfig,
  makeParticipants,
  TestSession,
} from "@/engine/session/testing/fixtures";
import { hostTapStillApplies } from "./hostTapStillApplies";

function calledGroup() {
  const participants = makeParticipants(8).map((participant) => ({
    ...participant,
    skill: "intermediate" as const,
    gender: "male" as const,
  }));
  const session = new TestSession();
  session.apply("SessionStarted", {
    config: {
      ...makeConfig({ participants, courts: 1 }),
      policyVersion: "simple-social-v2",
    },
    initialAttendeeIds: participants.map((p) => p.participantId),
  });
  const ids = participants.map((p) => p.participantId);
  const called = session.apply("NextGroupCalled", {
    courtId: fixtureCourtId(1),
    teamA: ids.slice(0, 2),
    teamB: ids.slice(2, 4),
  });
  return { session, ids, calledEventId: called.eventId };
}

/** The log with events after `seenSeq` recorded as this actor's. */
const actedBy = (
  events: readonly SessionEvent[],
  seenSeq: number,
  actorId: string,
) =>
  events.map((event) => (event.seq > seenSeq ? { ...event, actorId } : event));

describe("hostTapStillApplies", () => {
  it("carries a tap over another player's reply, but not over a change to what was tapped", () => {
    const { session, ids, calledEventId } = calledGroup();
    const seen = session.state.lastSeq;
    session.apply("NextGroupSeatConfirmed", {
      calledEventId,
      participantId: ids[0],
    });
    const events = actedBy(session.events, seen, "player:x");
    const applies = (command: Parameters<typeof hostTapStillApplies>[2]) =>
      hostTapStillApplies(events, session.state, command, seen);
    expect(
      applies({ kind: "confirm", calledEventId, participantId: ids[1] }),
    ).toBe(true);
    expect(
      applies({
        kind: "start",
        courtId: fixtureCourtId(1),
        calledEventId,
        matchId: "m",
      }),
    ).toBe(true);
    // Whoever has since replied is no longer "not replying".
    expect(applies({ kind: "pauseNoReply", participantId: ids[0] })).toBe(
      false,
    );
    expect(applies({ kind: "undo", targetSeq: 1 })).toBe(false);
  });

  it("refuses a group whose lineup changed, and anything after another host acted", () => {
    const { session, ids, calledEventId } = calledGroup();
    const seen = session.state.lastSeq;
    session.apply("PlayerSkipped", { participantId: ids[0], reason: "break" });
    const start = {
      kind: "release" as const,
      calledEventId,
    };
    expect(
      hostTapStillApplies(
        actedBy(session.events, seen, "player:x"),
        session.state,
        start,
        seen,
      ),
    ).toBe(false);
    expect(
      hostTapStillApplies(
        actedBy(session.events, seen, "another-host"),
        session.state,
        { kind: "leave", participantId: ids[5] },
        seen,
      ),
    ).toBe(false);
  });
});
