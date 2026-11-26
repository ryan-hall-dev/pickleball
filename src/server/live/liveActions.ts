"use server";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  findHistoryEntry,
  compensationTargetSeq,
  isSimpleSocial,
  isSimpleSocialV2,
  replay,
  SIMPLE_SOCIAL_REST_MS,
  type SessionState,
} from "@/engine/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import { loadSessionLog } from "@/server/sessionLog";
import {
  submitSessionAction,
  type NewSessionAction,
  type SubmitSessionActionInput,
} from "@/server/submitSessionAction";
import { autoPrepareCourts, reloadSessionState } from "./autoPrepare";
import { hostTapStillApplies } from "./hostTapStillApplies";
import { liveProjection } from "./liveProjection";
import { groupsBlockingUndo } from "./undoWithReleases";
import {
  liveWriteSchema,
  type LiveWriteInput,
  type LiveWriteResult,
  type ReadLiveResult,
  type LiveCommand,
} from "./liveTypes";
import { en } from "@/i18n/messages/en";

const readSchema = z.object({
  sessionId: z.uuid().optional(),
  prepareCourtId: z.uuid().optional(),
});
const UNAVAILABLE = en.serverMessages.live.couldNotRefresh;

export async function readLiveSession(
  input: { sessionId?: string; prepareCourtId?: string } = {},
): Promise<ReadLiveResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok)
    return { ok: false, message: en.serverMessages.live.signInToView };
  const parsed = readSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, message: en.serverMessages.live.reloadAndRetry };
  try {
    const client = await createSupabaseServerClient();
    let query = client
      .from("sessions")
      .select("id, name, status")
      .eq("social_id", authorization.host.socialId);
    query = parsed.data.sessionId
      ? query.eq("id", parsed.data.sessionId)
      : query.in("status", ["draft", "live", "ended"]);
    const { data: row, error } = await query
      .order("created_at", { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(10_000))
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return { ok: true, status: "empty" };
    if (row.status === "draft") return { ok: true, status: "draft" };
    const log = await loadSessionLog(client, row.id);
    if (!log) return { ok: true, status: "empty" };
    const result = replay(log.events);
    if (!result.ok)
      throw new Error(`Log replay failed at ${result.failedSeq}.`);
    if (!isSimpleSocial(result.state.config))
      return { ok: true, status: "legacy" };
    let state = result.state;
    const now = Math.max(Date.now(), state.lastAt ?? 0);
    // Normal rotation: free courts are prepared here, on the server, from the
    // log. Repeated polls and several hosts send the same event ids, so a
    // group is never prepared twice. A failure only leaves the log as it is.
    if (
      state.phase === "live" &&
      (await autoPrepareCourts(client, row.id, state, now))
    )
      state = (await reloadSessionState(client, row.id)) ?? state;
    const [phoneIds, scores] = isSimpleSocialV2(state.config)
      ? await Promise.all([
          phoneParticipantIds(client, row.id),
          sessionScores(client, row.id, state),
        ])
      : [new Set<string>(), new Map()];
    return {
      ok: true,
      status: "session",
      session: liveProjection(
        row.id,
        row.name,
        state,
        now,
        {
          seq: state.lastSeq + 1,
          at: now,
          eventId: randomUUID(),
          actorId: authorization.host.userId,
        },
        parsed.data.prepareCourtId,
        phoneIds,
        scores,
      ),
    };
  } catch (error) {
    console.error("Reading live session failed", {
      actorUserId: authorization.host.userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, message: UNAVAILABLE };
  }
}

/** A second action's id derived from the first, so a retry repeats it exactly. */
function followUpEventId(eventId: string, step: string): string {
  const bytes = createHash("sha256")
    .update(`${step}|${eventId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Host undos on the live screen: a start, a finish, or a court closing. */
const UNDO_TYPES = {
  MatchStarted: "MatchStartReverted",
  MatchCompleted: "MatchCompletionReverted",
  CourtClosed: "CourtReopened",
  CourtCloseScheduled: "CourtCloseCancelled",
} as const;

/**
 * Who checked in on a phone (a roster claim or an approved walk-in); anyone
 * else was checked in by a host and is called over in person. Read under
 * the host's RLS: only their own social's rows.
 */
async function phoneParticipantIds(
  client: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  sessionId: string,
): Promise<Set<string>> {
  const [claims, requests] = await Promise.all([
    client
      .from("session_roster_entries")
      .select("session_participant_id")
      .eq("session_id", sessionId)
      .not("claimed_device_token_hash", "is", null),
    client
      .from("checkin_requests")
      .select("session_participant_id")
      .eq("session_id", sessionId)
      .eq("status", "approved"),
  ]);
  if (claims.error) throw new Error(claims.error.message);
  if (requests.error) throw new Error(requests.error.message);
  return new Set(
    [...claims.data, ...requests.data].flatMap((row) =>
      row.session_participant_id ? [row.session_participant_id] : [],
    ),
  );
}

const MAX_WRITE_ATTEMPTS = 3;

/**
 * The close that follows "Stop game and close", with a repeatable id so a
 * retry never closes twice. Reports failure rather than leaving the court
 * open silently.
 */
async function closeAfterStop(
  client: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  sessionId: string,
  eventId: string,
  courtId: string,
): Promise<LiveWriteResult> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const log = await loadSessionLog(client, sessionId);
    if (!log) break;
    const closed = await submitSessionAction(client, {
      sessionId,
      eventId: followUpEventId(eventId, "close"),
      expectedLastSeq: log.events.at(-1)?.seq ?? 0,
      request: {
        kind: "action",
        action: { type: "CourtClosed", payload: { courtId } },
      },
    });
    if (closed.ok)
      return { ok: true, seq: closed.seq, wasDuplicate: closed.wasDuplicate };
    if (closed.reason === "INVALID_ACTION")
      return {
        ok: false,
        message: closed.error.message,
        outcome: "rejected",
        engineErrorCode: closed.error.code,
      };
  }
  return {
    ok: false,
    message: en.serverMessages.live.updatedByAnotherHost,
    outcome: "conflict",
  };
}

/** Standing scores of the session's games (host RLS: own social only). */
async function sessionScores(
  client: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  sessionId: string,
  state: SessionState,
) {
  const { data, error } = await client
    .from("match_scores")
    .select("match_id, score_team_a, score_team_b, entered_by_participant_id")
    .eq("session_id", sessionId)
    .is("voided_at", null);
  if (error) throw new Error(error.message);
  return new Map(
    data.map((row) => {
      const by = row.entered_by_participant_id
        ? state.participants[row.entered_by_participant_id]
        : undefined;
      return [
        row.match_id,
        {
          scoreTeamA: row.score_team_a,
          scoreTeamB: row.score_team_b,
          enteredByName: by
            ? `${by.participant.firstName} ${by.participant.lastName}`.trim()
            : null,
        },
      ] as const;
    }),
  );
}

function commandAction(
  command: LiveCommand,
  state: SessionState,
  at: number,
): NewSessionAction | null {
  switch (command.kind) {
    case "call":
      return {
        type: "NextGroupCalled",
        payload: {
          courtId: command.courtId,
          teamA: command.teamA,
          teamB: command.teamB,
        },
      };
    case "change":
      return {
        type: "NextGroupChanged",
        payload: {
          calledEventId: command.calledEventId,
          teamA: command.teamA,
          teamB: command.teamB,
        },
      };
    case "release":
      return {
        type: "NextGroupReleased",
        payload: { calledEventId: command.calledEventId },
      };
    case "start": {
      const called = state.courts[command.courtId]?.nextGroup;
      if (
        !called ||
        called.calledEventId !== command.calledEventId ||
        [...called.teamA, ...called.teamB].some((id) => id === null)
      )
        return null;
      return {
        type: "MatchStarted",
        payload: {
          courtId: command.courtId,
          matchId: command.matchId,
          calledEventId: command.calledEventId,
          teamA: called.teamA as string[],
          teamB: called.teamB as string[],
        },
      };
    }
    case "finish":
      return { type: "MatchCompleted", payload: { matchId: command.matchId } };
    case "replace":
      return {
        type: "PlayerReplaced",
        payload: {
          matchId: command.matchId,
          outId: command.outId,
          inId: command.inId,
          countGameForOut: false,
        },
      };
    case "interrupt":
      return { type: "MatchAbandoned", payload: { matchId: command.matchId } };
    case "undo":
      return null;
    case "rest":
      // v2: an open break until Ready; v1: the ten-minute rest.
      return isSimpleSocialV2(state.config)
        ? {
            type: "PlayerSkipped",
            payload: { participantId: command.participantId, reason: "break" },
          }
        : {
            type: "PlayerSkipped",
            payload: {
              participantId: command.participantId,
              returnsAt: at + SIMPLE_SOCIAL_REST_MS,
            },
          };
    case "pauseNoReply":
      return {
        type: "PlayerSkipped",
        payload: { participantId: command.participantId, reason: "noReply" },
      };
    case "confirm":
      return {
        type: "NextGroupSeatConfirmed",
        payload: {
          calledEventId: command.calledEventId,
          participantId: command.participantId,
        },
      };
    case "move":
      return {
        type: "NextGroupMoved",
        payload: {
          calledEventId: command.calledEventId,
          toCourtId: command.toCourtId,
        },
      };
    case "closeAfterGame":
      return {
        type: "CourtCloseScheduled",
        payload: { courtId: command.courtId },
      };
    case "closeNow":
      return { type: "CourtClosed", payload: { courtId: command.courtId } };
    case "endPair":
      return {
        type: "FriendPairEnded",
        payload: { requestSeq: command.requestSeq },
      };
    case "stopAndClose":
      // First the game ends with no credit; the close follows (writeLiveAction).
      return { type: "MatchAbandoned", payload: { matchId: command.matchId } };
    case "ready": {
      const skip = state.participants[command.participantId]?.skips.at(-1);
      if (!skip || skip.skippedBySeq !== command.targetSeq) return null;
      return {
        type: "PlayerUnskipped",
        payload: { targetSeq: command.targetSeq },
      };
    }
    case "leave":
      return {
        type: "PlayerLeft",
        payload: { participantId: command.participantId },
      };
    case "end":
      return { type: "SessionEnded", payload: {} };
  }
}

/** A small whitelist of host intents. State-derived starts cannot supply fabricated teams. */
export async function writeLiveAction(
  input: LiveWriteInput,
): Promise<LiveWriteResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok)
    return {
      ok: false,
      message: en.serverMessages.live.signInToChange,
      outcome: "rejected",
    };
  const parsed = liveWriteSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      message: en.serverMessages.live.checkAction,
      outcome: "rejected",
    };
  try {
    const client = await createSupabaseServerClient();
    // A write can land between reading the log and writing: read again and
    // decide again, a few times.
    for (let attempt = 1; ; attempt += 1) {
      const log = await loadSessionLog(client, parsed.data.sessionId);
      if (!log)
        return {
          ok: false,
          message: en.serverMessages.live.sessionNotAvailable,
          outcome: "rejected",
        };
      const replayed = replay(log.events);
      if (!replayed.ok || !isSimpleSocial(replayed.state.config))
        return {
          ok: false,
          message: en.serverMessages.live.notSimpleSession,
          outcome: "rejected",
        };
      const at = Math.max(Date.now(), replayed.state.lastAt ?? 0);
      // A consumed call/rest may no longer exist after success. Recover its original
      // event for the same intent before deriving the action, then let submit check retries.
      const landed = log.events.find(
        (event) => event.eventId === parsed.data.eventId,
      );
      const command = parsed.data.command;
      let request: SubmitSessionActionInput["request"];
      if (command.kind === "undo") {
        const target = findHistoryEntry(replayed.state, command.targetSeq);
        if (!target || !(target.event.type in UNDO_TYPES)) {
          return {
            ok: false,
            message: en.serverMessages.live.onlyStartOrFinishUndo,
            outcome: "rejected",
          };
        }
        const undoType =
          UNDO_TYPES[target.event.type as keyof typeof UNDO_TYPES];
        if (
          landed &&
          (landed.type !== undoType ||
            compensationTargetSeq(landed) !== command.targetSeq)
        ) {
          return {
            ok: false,
            message: en.serverMessages.live.actionIdUsed,
            outcome: "rejected",
          };
        }
        request = { kind: "undo", targetSeq: command.targetSeq };
      } else {
        const eventTypes = {
          call: "NextGroupCalled",
          change: "NextGroupChanged",
          release: "NextGroupReleased",
          start: "MatchStarted",
          finish: "MatchCompleted",
          replace: "PlayerReplaced",
          interrupt: "MatchAbandoned",
          rest: "PlayerSkipped",
          ready: "PlayerUnskipped",
          leave: "PlayerLeft",
          end: "SessionEnded",
          confirm: "NextGroupSeatConfirmed",
          pauseNoReply: "PlayerSkipped",
          move: "NextGroupMoved",
          closeAfterGame: "CourtCloseScheduled",
          closeNow: "CourtClosed",
          endPair: "FriendPairEnded",
          stopAndClose: "MatchAbandoned",
        } as const;
        if (landed && landed.type !== eventTypes[command.kind]) {
          return {
            ok: false,
            message: en.serverMessages.live.actionIdUsed,
            outcome: "rejected",
          };
        }
        const action = landed
          ? ({ type: landed.type, payload: landed.payload } as NewSessionAction)
          : commandAction(command, replayed.state, at);
        if (!action) {
          return {
            ok: false,
            message: en.serverMessages.live.groupOrPlayerChanged,
            outcome: "conflict",
          };
        }
        request = { kind: "action", action };
      }
      // Players' replies and the app's own actions don't make the host's tap
      // stale while what they tapped is unchanged.
      const expectedLastSeq = hostTapStillApplies(
        log.events,
        replayed.state,
        command,
        parsed.data.expectedLastSeq,
      )
        ? replayed.state.lastSeq
        : parsed.data.expectedLastSeq;
      // Undo first releases any newer Up next group in its way (v2).
      let writeSeq = expectedLastSeq;
      if (
        !landed &&
        command.kind === "undo" &&
        writeSeq === replayed.state.lastSeq
      ) {
        for (const calledEventId of groupsBlockingUndo(
          replayed.state,
          command.targetSeq,
        )) {
          const released = await submitSessionAction(
            client,
            {
              sessionId: parsed.data.sessionId,
              eventId: followUpEventId(parsed.data.eventId, calledEventId),
              expectedLastSeq: writeSeq,
              request: {
                kind: "action",
                action: {
                  type: "NextGroupReleased",
                  payload: { calledEventId },
                },
              },
            },
            { now: () => at },
          );
          if (!released.ok) break;
          writeSeq = released.seq;
        }
      }
      const result = await submitSessionAction(
        client,
        {
          sessionId: parsed.data.sessionId,
          eventId: parsed.data.eventId,
          expectedLastSeq: writeSeq,
          request,
        },
        {
          now: () => at,
          // Nothing was written since the read above: don't read it again.
          ...(writeSeq === expectedLastSeq
            ? { alreadyRead: { actorId: authorization.host.userId, log } }
            : {}),
        },
      );
      if (
        !result.ok &&
        result.reason === "UPDATED_BY_ANOTHER_HOST" &&
        expectedLastSeq !== parsed.data.expectedLastSeq &&
        attempt < MAX_WRITE_ATTEMPTS
      )
        continue;
      if (result.ok && command.kind === "stopAndClose")
        return await closeAfterStop(
          client,
          parsed.data.sessionId,
          parsed.data.eventId,
          command.courtId,
        );
      if (result.ok)
        return { ok: true, seq: result.seq, wasDuplicate: result.wasDuplicate };
      return result.reason === "UPDATED_BY_ANOTHER_HOST"
        ? {
            ok: false,
            message: en.serverMessages.live.updatedByAnotherHost,
            outcome: "conflict",
          }
        : // INVALID_ACTION: the engine refused it for good; nothing to retry.
          {
            ok: false,
            message: result.error.message,
            outcome: "rejected",
            engineErrorCode: result.error.code,
          };
    }
  } catch (error) {
    console.error("Writing live action failed", {
      actorUserId: authorization.host.userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      message: en.serverMessages.live.couldNotSave,
      // The database may or may not have saved it: keep the event id for a retry.
      outcome: "unknown",
    };
  }
}
