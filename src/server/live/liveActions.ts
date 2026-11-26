"use server";

import { randomUUID } from "node:crypto";
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
import { liveProjection } from "./liveProjection";
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

/** Host undos on the live screen: a start, a finish, or a court closing. */
const UNDO_TYPES = {
  MatchStarted: "MatchStartReverted",
  MatchCompleted: "MatchCompletionReverted",
  CourtClosed: "CourtReopened",
  CourtCloseScheduled: "CourtCloseCancelled",
} as const;

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
      const undoType = UNDO_TYPES[target.event.type as keyof typeof UNDO_TYPES];
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
    const result = await submitSessionAction(
      client,
      {
        sessionId: parsed.data.sessionId,
        eventId: parsed.data.eventId,
        expectedLastSeq: parsed.data.expectedLastSeq,
        request,
      },
      { now: () => at },
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
