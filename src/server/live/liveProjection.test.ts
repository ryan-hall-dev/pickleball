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
  const view = liveProjection("session", "Social", session.state, session.now);
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
