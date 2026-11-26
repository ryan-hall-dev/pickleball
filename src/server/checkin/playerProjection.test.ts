// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  fixtureCourtId,
  makeConfig,
  makeParticipants,
  MINUTE_MS,
  TestSession,
} from "@/engine/session/testing/fixtures";
import type { Participant } from "@/engine/session";
import { playerProjection, readyFriendMatches } from "./playerProjection";

function v2() {
  const participants: Participant[] = makeParticipants(12).map((p, i) => ({
    ...p,
    skill: "intermediate",
    gender: i < 8 ? "male" : "female",
  }));
  const session = new TestSession();
  session.apply("SessionStarted", {
    config: {
      ...makeConfig({ participants, courts: 2 }),
      policyVersion: "simple-social-v2",
    },
    initialAttendeeIds: participants.map((p) => p.participantId),
  });
  return { session, ids: participants.map((p) => p.participantId) };
}

describe("playerProjection", () => {
  it("walks a player from Ready through Up next to Head to court and playing", () => {
    const { session, ids } = v2();
    session.advanceMinutes(4);
    const view = () => playerProjection(session.state, ids[0], session.now);
    expect(view()).toMatchObject({ status: "ready", waitMs: 4 * MINUTE_MS });
    const called = session.apply("NextGroupCalled", {
      courtId: fixtureCourtId(1),
      teamA: [ids[0], ids[1]],
      teamB: [ids[2], ids[3]],
    });
    expect(view()).toMatchObject({
      status: "upNext",
      group: {
        courtName: expect.any(String),
        yourTeam: [{ isYou: true }, { isYou: false, isConfirmed: false }],
      },
    });
    session.apply("NextGroupSeatConfirmed", {
      calledEventId: called.eventId,
      participantId: ids[0],
    });
    expect(view().status).toBe("confirmed");
    for (const id of ids.slice(1, 4))
      session.apply("NextGroupSeatConfirmed", {
        calledEventId: called.eventId,
        participantId: id,
      });
    expect(view().status).toBe("headToCourt");
    session.apply("MatchStarted", {
      matchId: "m1",
      courtId: fixtureCourtId(1),
      teamA: [ids[0], ids[1]],
      teamB: [ids[2], ids[3]],
      calledEventId: called.eventId,
    });
    expect(view()).toMatchObject({
      status: "playing",
      gameStartedAt: session.now,
    });
  });

  it("names only the player's own group", () => {
    const { session, ids } = v2();
    session.apply("NextGroupCalled", {
      courtId: fixtureCourtId(1),
      teamA: [ids[0], ids[1]],
      teamB: [ids[2], ids[3]],
    });
    const json = JSON.stringify(
      playerProjection(session.state, ids[0], session.now),
    );
    const outsider = session.state.participants[ids[5]].participant.firstName;
    expect(json).not.toContain(outsider);
    expect(
      JSON.stringify(playerProjection(session.state, ids[5], session.now)),
    ).not.toContain(session.state.participants[ids[1]].participant.lastName);
  });

  it("shows a break with its frozen wait, and a friend request both ways", () => {
    const { session, ids } = v2();
    session.advanceMinutes(3);
    session.apply("PlayerSkipped", {
      participantId: ids[0],
      reason: "noReply",
    });
    session.advanceMinutes(12);
    expect(playerProjection(session.state, ids[0], session.now)).toMatchObject({
      status: "onBreak",
      breakReason: "noReply",
      waitMs: 3 * MINUTE_MS,
    });
    session.apply("FriendPairRequested", {
      participantId: ids[4],
      friendId: ids[8],
    });
    expect(
      playerProjection(session.state, ids[8], session.now).friend,
    ).toMatchObject({ status: "askedYou" });
    expect(
      playerProjection(session.state, ids[4], session.now).friend,
    ).toMatchObject({ status: "youAsked" });
  });

  it("friend search: from 2 letters, Ready players only, never yourself", () => {
    const { session, ids } = v2();
    const name = session.state.participants[ids[6]].participant.firstName;
    expect(
      readyFriendMatches(session.state, ids[0], name[0], session.now),
    ).toEqual([]);
    expect(
      readyFriendMatches(session.state, ids[6], name, session.now).map(
        (match) => match.participantId,
      ),
    ).not.toContain(ids[6]);
    session.apply("PlayerSkipped", { participantId: ids[6], reason: "break" });
    expect(
      readyFriendMatches(session.state, ids[0], name, session.now).map(
        (match) => match.participantId,
      ),
    ).not.toContain(ids[6]);
  });
});
