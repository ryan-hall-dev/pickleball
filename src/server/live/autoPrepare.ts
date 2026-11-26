import "server-only";
import { createHash } from "node:crypto";
import {
  applyEvent,
  isSimpleSocialV2,
  replay,
  type SessionEvent,
  type SessionState,
} from "@/engine/session";
import { submitNonHostSessionAction } from "@/server/nonHostSessionAction";
import {
  loadSessionLog,
  SYSTEM_ACTOR_ID,
  type DatabaseClient,
} from "@/server/sessionLog";
import { submitSessionAction } from "@/server/submitSessionAction";
import { nextAutomaticAction, planAutoPreparation } from "./autoPreparePlan";

/** At most this many automatic actions per read (a full refill and every court). */
const MAX_AUTOMATIC_ACTIONS_PER_READ = 12;

/**
 * A repeatable event id for "prepare this court at this point in the log".
 * Two hosts (or a poll and its retry) planning from the same state send the
 * same id, so the database answers the second one as a duplicate.
 */
export function autoPrepareEventId(
  sessionId: string,
  expectedLastSeq: number,
  courtId: string,
): string {
  const bytes = createHash("sha256")
    .update(`auto-prepare|${sessionId}|${expectedLastSeq}|${courtId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Appends a `NextGroupCalled` for every court the planner fills, one event
 * per court, each with the expected sequence of the one before. Returns true
 * when the log changed (the caller re-reads it). It never throws: a stale
 * sequence (another host acted first), a refusal or an error leaves the log as
 * the database has it, and the next poll plans again from that.
 */
export async function autoPrepareCourts(
  client: DatabaseClient,
  sessionId: string,
  state: SessionState,
  now: number,
): Promise<boolean> {
  if (isSimpleSocialV2(state.config))
    return runAutomaticActions(sessionId, state, now);
  const plan = planAutoPreparation(state, now);
  let expectedLastSeq = state.lastSeq;
  let changed = false;
  for (const group of plan) {
    try {
      const result = await submitSessionAction(
        client,
        {
          sessionId,
          eventId: autoPrepareEventId(
            sessionId,
            expectedLastSeq,
            group.courtId,
          ),
          expectedLastSeq,
          request: {
            kind: "action",
            action: {
              type: "NextGroupCalled",
              payload: {
                courtId: group.courtId,
                teamA: group.teamA,
                teamB: group.teamB,
              },
            },
          },
        },
        { now: () => now },
      );
      if (!result.ok) {
        // A stale sequence only means another host acted first. A refusal is
        // logged by code (never names) and re-planned on the next poll.
        if (result.reason === "INVALID_ACTION")
          console.error("Preparing a court was refused", {
            sessionId,
            code: result.error.code,
          });
        break;
      }
      changed = true;
      expectedLastSeq += 1;
    } catch (error) {
      console.error("Preparing courts failed", {
        sessionId,
        cause: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return changed;
}

/** Loads and replays the log again after a preparation write. */
export async function reloadSessionState(
  client: DatabaseClient,
  sessionId: string,
): Promise<SessionState | null> {
  const log = await loadSessionLog(client, sessionId);
  if (!log) return null;
  const replayed = replay(log.events);
  return replayed.ok ? replayed.state : null;
}

/**
 * simple-social-v2: does what the app should do by itself, one action at a
 * time, recorded as the system's own (never a borrowed host or player).
 * Any reader may trigger it: a host's live screen or a player's page. Event
 * ids are repeatable, so several readers at once never duplicate an action;
 * a stale sequence or a refusal stops this round and the next read plans
 * again. Returns true when the log changed. Never throws.
 */
export async function runAutomaticActions(
  sessionId: string,
  state: SessionState,
  now: number,
): Promise<boolean> {
  let current = state;
  let changed = false;
  for (let step = 0; step < MAX_AUTOMATIC_ACTIONS_PER_READ; step += 1) {
    const next = nextAutomaticAction(current, now);
    if (!next) break;
    const eventId = autoPrepareEventId(sessionId, current.lastSeq, next.key);
    try {
      const result = await submitNonHostSessionAction(
        {
          sessionId,
          eventId,
          expectedLastSeq: current.lastSeq,
          action: next.action,
        },
        { kind: "system" },
        {
          now: () => now,
          loaded: { events: [], state: current },
        },
      );
      if (!result.ok) {
        if (result.reason === "INVALID_ACTION")
          console.error("An automatic action was refused", {
            sessionId,
            code: result.error.code,
          });
        break;
      }
      const at = Math.max(now, current.lastAt ?? 0);
      const applied = applyEvent(current, {
        seq: result.seq,
        eventId,
        at,
        actorId: SYSTEM_ACTOR_ID,
        ...next.action,
      } as SessionEvent);
      changed = true;
      if (!applied.ok || result.wasDuplicate) break;
      current = applied.state;
    } catch (error) {
      console.error("Automatic actions failed", {
        sessionId,
        cause: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return changed;
}
