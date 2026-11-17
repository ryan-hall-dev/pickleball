import "server-only";
import { createHash } from "node:crypto";
import { replay, type SessionState } from "@/engine/session";
import { loadSessionLog, type DatabaseClient } from "@/server/sessionLog";
import { submitSessionAction } from "@/server/submitSessionAction";
import { planAutoPreparation } from "./autoPreparePlan";

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
