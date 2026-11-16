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

// Pilot roster (2026-11-16): the first suggestion for Court 1 was Jake Hill +
// Kea Snow against Just Bing + Jess Sing. "Just Bing" and "Jess Sing" read
// almost the same on a phone and were reported as one player shown twice; the
// log held eight distinct participants, so this pins the real invariant: a
// suggested or called doubles group is four distinct participant UUIDs, shown
// as four distinct names, even when names look alike.
it("suggests and calls four distinct participants, shown with four distinct names, for look-alike names", () => {
  const roster = [
    ["Ben", "Gold", "male"],
    ["Jon", "Dirt", "male"],
    ["Jake", "Hill", "male"],
    ["Just", "Bing", "male"],
    ["Le", "Wing", "female"],
    ["Kea", "Snow", "female"],
    ["Jess", "Sing", "female"],
    ["Zoe", "Tool", "female"],
  ] as const;
  const participants = makeParticipants(roster.length).map((player, index) => ({
    ...player,
    firstName: roster[index][0],
    lastName: roster[index][1],
    gender: roster[index][2],
    skill: "intermediate" as const,
  }));
  const session = TestSession.start({ participants, courts: 2 });
  session.config.policyVersion = "simple-social-v1";
  const project = () =>
    liveProjection(
      "session",
      "Social",
      session.state,
      session.now,
      session.nextMeta(),
      fixtureCourtId(1),
    );
  const namesOf = (
    view: ReturnType<typeof project>,
    ids: readonly (string | null)[],
  ) =>
    ids.map(
      (id) => view.players.find((player) => player.participantId === id)?.name,
    );
  expect(new Set(project().players.map((player) => player.name)).size).toBe(8);

  const seatIds = (ids: readonly (string | null)[]) =>
    ids.map((id) => {
      if (id === null) throw new Error("A seat is vacant.");
      return id;
    });
  const suggestion = project().courts[0].suggestion!;
  const suggestionA = seatIds(suggestion.teamA);
  const suggestionB = seatIds(suggestion.teamB);
  const suggestedIds = [...suggestionA, ...suggestionB];
  expect(new Set(suggestedIds).size).toBe(4);
  expect(new Set(namesOf(project(), suggestedIds)).size).toBe(4);

  session.apply("NextGroupCalled", {
    courtId: fixtureCourtId(1),
    teamA: suggestionA,
    teamB: suggestionB,
  });
  const called = project().courts[0].called!;
  const calledIds = [...seatIds(called.teamA), ...seatIds(called.teamB)];
  expect(calledIds).toEqual(suggestedIds);
  expect(new Set(namesOf(project(), calledIds)).size).toBe(4);

  // A duplicated seat can never be stored, whatever a client sends.
  expect(() =>
    session.apply("NextGroupChanged", {
      calledEventId: called.calledEventId,
      teamA: [suggestedIds[0], suggestedIds[1]],
      teamB: [suggestedIds[2], suggestedIds[2]],
    }),
  ).toThrow();
});
