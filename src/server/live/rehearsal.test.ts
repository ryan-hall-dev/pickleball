// @vitest-environment node
// A simulated social (docs/plans/reclub-to-court-v1.md, Phase 4) on the real
// v2 rules: 42 players, 5 courts, 3 hours of virtual time, with slow and
// missing replies, breaks, departures, friend pairs and a court closing.
// REHEARSAL_REPORT=1 prints the measurements.
import { describe, expect, it } from "vitest";
import {
  calledSeats,
  isPresent,
  isSkipped,
  isUpNextReadyToPlay,
  playerMetrics,
  friendPairOf,
  type Participant,
} from "@/engine/session";
import {
  createSeededRandom,
  fixtureCourtId,
  makeConfig,
  makeParticipants,
  TestSession,
} from "@/engine/session/testing/fixtures";
import { nextAutomaticAction } from "./autoPreparePlan";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const STEP = 5 * SECOND;

function simulate(seed: number) {
  const random = createSeededRandom(seed);
  const between = (low: number, high: number) => low + random() * (high - low);
  const participants: Participant[] = makeParticipants(42, seed).map(
    (participant, index) => ({
      ...participant,
      skill: "intermediate",
      gender: index % 5 < 3 ? "male" : "female",
    }),
  );
  const session = new TestSession();
  session.apply("SessionStarted", {
    config: {
      ...makeConfig({ participants, courts: 5 }),
      policyVersion: "simple-social-v2",
      upNextAfterMinutes: 6,
      plannedDurationMinutes: 180,
    },
    initialAttendeeIds: participants.map((p) => p.participantId),
  });
  const start = session.now;
  const replyAt = new Map<string, number>();
  const startAt = new Map<string, number>();
  const finishAt = new Map<string, number>();
  const backAt = new Map<string, number>();
  const freeSince = new Map<string, number>(
    [1, 2, 3, 4, 5].map((n) => [fixtureCourtId(n), start]),
  );
  const idleMs: number[] = [];
  let hostTaps = 0;
  let matches = 0;
  let closed = false;
  let slowestPlanMs = 0;
  let longestWaitMs = 0;

  for (let t = start; t < start + 175 * MINUTE; t += STEP) {
    session.now = t;
    // The app's own actions.
    for (let i = 0; i < 12; i += 1) {
      const before = performance.now();
      const next = nextAutomaticAction(session.state, t);
      slowestPlanMs = Math.max(slowestPlanMs, performance.now() - before);
      if (!next) break;
      session.apply(next.action.type, next.action.payload);
    }
    // Up next: replies, no-replies, starts.
    for (const court of Object.values(session.state.courts)) {
      const group = session.state.courts[court.court.courtId].nextGroup;
      if (!group) continue;
      for (const id of calledSeats(group)) {
        if (!id || group.confirmedIds?.includes(id)) continue;
        const key = `${group.calledEventId}|${id}`;
        if (!replyAt.has(key))
          // 6% never reply: the host steps in after about two minutes.
          replyAt.set(
            key,
            random() < 0.06 ? -(t + 2 * MINUTE) : t + between(5, 75) * SECOND,
          );
        const due = replyAt.get(key)!;
        if (t < Math.abs(due)) continue;
        if (due < 0) hostTaps += 1;
        if (due < 0 && random() < 0.5)
          session.apply("PlayerSkipped", {
            participantId: id,
            reason: "noReply",
          });
        else
          session.apply("NextGroupSeatConfirmed", {
            calledEventId: group.calledEventId,
            participantId: id,
          });
        if (due < 0) backAt.set(id, t + between(5, 15) * MINUTE);
      }
      const courtId = court.court.courtId;
      if (isUpNextReadyToPlay(session.state, courtId)) {
        if (!startAt.has(group.calledEventId))
          startAt.set(group.calledEventId, t + between(20, 90) * SECOND);
        if (t >= startAt.get(group.calledEventId)!) {
          const matchId = `match-${(matches += 1)}`;
          session.apply("MatchStarted", {
            matchId,
            courtId,
            calledEventId: group.calledEventId,
            teamA: group.teamA as string[],
            teamB: group.teamB as string[],
          });
          idleMs.push(t - freeSince.get(courtId)!);
          finishAt.set(matchId, t + between(9, 15) * MINUTE);
        }
      }
    }
    // The host finishes games; some players then take a break or leave.
    for (const match of Object.values(session.state.matches)) {
      if (match.status !== "active" || t < finishAt.get(match.matchId)!)
        continue;
      session.apply("MatchCompleted", { matchId: match.matchId });
      hostTaps += 1;
      freeSince.set(match.courtId, t);
      for (const { participantId } of match.segments) {
        const roll = random();
        if (roll < 0.02) session.apply("PlayerLeft", { participantId });
        else if (roll < 0.07) {
          session.apply("PlayerSkipped", { participantId, reason: "break" });
          backAt.set(participantId, t + between(3, 12) * MINUTE);
        }
      }
    }
    // Breaks end.
    for (const [id, at] of backAt) {
      const participant = session.state.participants[id];
      if (t < at) continue;
      backAt.delete(id);
      const skip = participant.skips.at(-1);
      if (isPresent(participant) && skip && skip.to === null)
        session.apply("PlayerUnskipped", { targetSeq: skip.skippedBySeq });
    }
    // Now and then two ready friends team up.
    if (random() < 0.01) {
      const reserved = new Set(
        Object.values(session.state.courts).flatMap((court) =>
          court.nextGroup ? calledSeats(court.nextGroup) : [],
        ),
      );
      const ready = Object.values(session.state.participants).filter(
        (p) =>
          isPresent(p) &&
          p.activeMatchId === null &&
          !isSkipped(p, t) &&
          !reserved.has(p.participant.participantId) &&
          !friendPairOf(session.state, p.participant.participantId),
      );
      if (ready.length >= 2) {
        const a = ready[Math.floor(random() * ready.length)];
        const b = ready.find((p) => p !== a)!;
        const asked = session.apply("FriendPairRequested", {
          participantId: a.participant.participantId,
          friendId: b.participant.participantId,
        });
        session.apply("FriendPairAccepted", { requestSeq: asked.seq });
      }
    }
    // At 90 minutes the venue takes a court back.
    if (!closed && t >= start + 90 * MINUTE) {
      closed = true;
      hostTaps += 1;
      const court = session.state.courts[fixtureCourtId(5)];
      session.apply(
        court.activeMatchId ? "CourtCloseScheduled" : "CourtClosed",
        {
          courtId: fixtureCourtId(5),
        },
      );
    }
    if (t % MINUTE === start % MINUTE)
      for (const player of playerMetrics(session.state, t))
        if (player.status === "waiting")
          longestWaitMs = Math.max(longestWaitMs, player.currentWaitMs ?? 0);
  }
  idleMs.sort((a, b) => a - b);
  const games = playerMetrics(session.state, session.now)
    .filter((p) => p.status !== "away")
    .map((p) => p.gamesCompleted);
  return {
    matches,
    events: session.events.length,
    courtIdleMedianSeconds: Math.round(idleMs[idleMs.length >> 1] / SECOND),
    courtIdle90thSeconds: Math.round(
      idleMs[Math.floor(idleMs.length * 0.9)] / SECOND,
    ),
    longestWaitMinutes: Math.round(longestWaitMs / MINUTE),
    gamesPerPlayer: `${Math.min(...games)}-${Math.max(...games)}`,
    hostTaps,
    slowestPlanMs: Math.round(slowestPlanMs),
  };
}

describe("a simulated 42-player, 5-court social", () => {
  it("keeps courts turning over and plans quickly", () => {
    const runs = [1, 2, 3].map(simulate);
    if (process.env.REHEARSAL_REPORT)
      process.stdout.write(JSON.stringify(runs));
    for (const run of runs) {
      expect(run.matches).toBeGreaterThan(55);
      expect(run.slowestPlanMs).toBeLessThan(1_000);
    }
  }, 600_000);
});
