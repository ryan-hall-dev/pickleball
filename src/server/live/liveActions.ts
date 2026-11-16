"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  findHistoryEntry,
  compensationTargetSeq,
  isSimpleSocial,
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
import { liveProjection } from "./liveProjection";
import {
  liveWriteSchema,
  type LiveWriteInput,
  type LiveWriteResult,
  type ReadLiveResult,
  type LiveCommand,
} from "./liveTypes";

const readSchema = z.object({
  sessionId: z.uuid().optional(),
  prepareCourtId: z.uuid().optional(),
});
const UNAVAILABLE =
  "Couldn't refresh the session. Check your connection and retry.";

export async function readLiveSession(
  input: { sessionId?: string; prepareCourtId?: string } = {},
): Promise<ReadLiveResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok)
    return { ok: false, message: "Sign in as a host to view this session." };
  const parsed = readSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, message: "Reload the session and try again." };
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
    const now = Math.max(Date.now(), result.state.lastAt ?? 0);
    return {
      ok: true,
      status: "session",
      session: liveProjection(
        row.id,
        row.name,
        result.state,
        now,
        {
          seq: result.state.lastSeq + 1,
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
      return {
        type: "PlayerSkipped",
        payload: {
          participantId: command.participantId,
          returnsAt: at + SIMPLE_SOCIAL_REST_MS,
        },
      };
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
      message: "Sign in as a host to change this session.",
      outcome: "rejected",
    };
  const parsed = liveWriteSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      message: "Check the action and retry.",
      outcome: "rejected",
    };
  try {
    const client = await createSupabaseServerClient();
    const log = await loadSessionLog(client, parsed.data.sessionId);
    if (!log)
      return {
        ok: false,
        message: "This session is not available.",
        outcome: "rejected",
      };
    const replayed = replay(log.events);
    if (!replayed.ok || !isSimpleSocial(replayed.state.config))
      return {
        ok: false,
        message: "This session cannot use the simple live controls.",
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
      if (
        !target ||
        (target.event.type !== "MatchStarted" &&
          target.event.type !== "MatchCompleted")
      ) {
        return {
          ok: false,
          message: "Only a game start or finish can be undone here.",
          outcome: "rejected",
        };
      }
      const undoType =
        target.event.type === "MatchStarted"
          ? "MatchStartReverted"
          : "MatchCompletionReverted";
      if (
        landed &&
        (landed.type !== undoType ||
          compensationTargetSeq(landed) !== command.targetSeq)
      ) {
        return {
          ok: false,
          message: "That action ID was already used. Refresh and try again.",
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
      } as const;
      if (landed && landed.type !== eventTypes[command.kind]) {
        return {
          ok: false,
          message: "That action ID was already used. Refresh and try again.",
          outcome: "rejected",
        };
      }
      const action = landed
        ? ({ type: landed.type, payload: landed.payload } as NewSessionAction)
        : commandAction(command, replayed.state, at);
      if (!action) {
        return {
          ok: false,
          message: "The group or player changed. Refresh before trying again.",
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
          message: "Updated by another host. Review the refreshed session.",
          outcome: "conflict",
        }
      : // INVALID_ACTION: the engine refused it for good; nothing to retry.
        { ok: false, message: result.error.message, outcome: "rejected" };
  } catch (error) {
    console.error("Writing live action failed", {
      actorUserId: authorization.host.userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      message:
        "Couldn't save that action. Retry it after checking your connection.",
      // The database may or may not have saved it: keep the event id for a retry.
      outcome: "unknown",
    };
  }
}
