// @vitest-environment node
import { expect, it } from "vitest";
import {
  TestSession,
  makeParticipants,
  fixtureCourtId,
  fixtureParticipantId,
} from "@/engine/session/testing/fixtures";
import { liveProjection } from "./liveProjection";

it("projects reservation identity separately from duplicate court labels", () => {
  const participants = makeParticipants(8).map((player) => ({
    ...player,
    gender: "male" as const,
  }));
  const session = TestSession.start({ participants, courts: 2 });
  session.config.policyVersion = "simple-social-v1";
  for (const court of Object.values(session.state.courts))
    court.court.name = "Same label";
  session.apply("NextGroupCalled", {
    courtId: fixtureCourtId(2),
    teamA: [1, 2].map(fixtureParticipantId),
    teamB: [3, 4].map(fixtureParticipantId),
  });
  const view = liveProjection(
    "session",
    "Social",
    session.state,
    session.now,
    session.nextMeta(),
  );
  expect(
    view.players.find(
      (player) => player.participantId === fixtureParticipantId(1),
    ),
  ).toMatchObject({
    calledCourtId: fixtureCourtId(2),
    calledCourtName: "Same label",
  });
  expect(
    view.players.find(
      (player) => player.participantId === fixtureParticipantId(5),
    ),
  ).toMatchObject({ calledCourtId: null, calledCourtName: null });
});

function recoverySession() {
  const participants = makeParticipants(8).map((player) => ({
    ...player,
    gender: "male" as const,
    skill: "intermediate" as const,
  }));
  const session = TestSession.start({ participants, courts: 1 });
  session.config.policyVersion = "simple-social-v1";
  return session;
}
function undoOptions(session: TestSession) {
  return liveProjection(
    "session",
    "Social",
    session.state,
    session.now,
    session.nextMeta(),
  ).undoOptions;
}
it("offers only engine-safe start/finish recovery and never resurfaces an older game", () => {
  const session = recoverySession();
  const matchId = session.startMatch(
    1,
    [1, 2].map(fixtureParticipantId),
    [3, 4].map(fixtureParticipantId),
  );
  expect(undoOptions(session)).toEqual([
    { courtId: fixtureCourtId(1), matchId, targetSeq: 2, kind: "start" },
  ]);
  session.apply("MatchCompleted", { matchId });
  expect(undoOptions(session)).toEqual([
    { courtId: fixtureCourtId(1), matchId, targetSeq: 3, kind: "finish" },
  ]);
  session.apply("PlayerSkipped", {
    participantId: fixtureParticipantId(1),
    returnsAt: session.now + 600_000,
  });
  expect(undoOptions(session)).toEqual([]);
  const nextMatch = session.startMatch(
    1,
    [5, 6].map(fixtureParticipantId),
    [7, 8].map(fixtureParticipantId),
  );
  const startSeq = session.state.lastSeq;
  expect(undoOptions(session)[0]).toMatchObject({
    matchId: nextMatch,
    kind: "start",
  });
  session.undo(startSeq);
  expect(undoOptions(session)).toEqual([]);
});
it("does not offer interrupt or ended-session Undo", () => {
  const session = recoverySession();
  const matchId = session.startMatch(
    1,
    [1, 2].map(fixtureParticipantId),
    [3, 4].map(fixtureParticipantId),
  );
  session.apply("MatchAbandoned", { matchId });
  expect(undoOptions(session)).toEqual([]);
  session.apply("SessionEnded", {});
  expect(undoOptions(session)).toEqual([]);
});
