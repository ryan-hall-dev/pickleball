"use server";

import { randomUUID } from "node:crypto";
import { applyEvent, isSimpleSocial, replay } from "@/engine/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import { checkinDatabaseTimeoutSignal } from "@/server/checkin/checkinPage";
import { loadSessionLog } from "@/server/sessionLog";
import {
  liveAddPlayerSchema,
  type LiveAddPlayerInput,
  type LiveWriteResult,
} from "./liveTypes";
import { en } from "@/i18n/messages/en";

const STALE_MESSAGE = en.serverMessages.addPlayer.sessionChanged;

/**
 * Adds a session-only player to the live waiting list (one transaction:
 * snapshot row plus `PlayerJoined`). Two different people may share a name:
 * they are told apart by UUID and a double submit is stopped by the event id,
 * never by the name. A retry with the same event id returns the original
 * write instead of a second player; a different player under a used event id
 * is refused.
 */
export async function addLivePlayer(
  input: LiveAddPlayerInput,
): Promise<LiveWriteResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok)
    return {
      ok: false,
      message: en.serverMessages.live.signInToChange,
      outcome: "rejected",
    };
  const parsed = liveAddPlayerSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      message: en.serverMessages.addPlayer.checkDetails,
      outcome: "rejected",
    };
  const { host } = authorization;
  const details = parsed.data;
  try {
    const log = await loadSessionLog(
      await createSupabaseServerClient(),
      details.sessionId,
    );
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
    const landed = log.events.find(
      (event) => event.eventId === details.eventId,
    );
    let participantId: string = randomUUID();
    if (landed) {
      // An earlier try of this very add: let the database answer it again.
      if (landed.type !== "PlayerJoined")
        return {
          ok: false,
          message: en.serverMessages.live.actionIdUsed,
          outcome: "rejected",
        };
      // The retry must be the same person: a different name or details under
      // a used event id is a new add and needs its own id.
      const same = (left: string | undefined, right: string) =>
        left?.trim().replace(/\s+/g, " ").toLowerCase() ===
        right.trim().replace(/\s+/g, " ").toLowerCase();
      const earlier = landed.payload.participant;
      if (
        !same(earlier.firstName, details.firstName) ||
        !same(earlier.lastName, details.lastName) ||
        earlier.skill !== details.skillLevel ||
        earlier.gender !== details.gender
      )
        return {
          ok: false,
          message: en.serverMessages.addPlayer.actionIdUsedForOther,
          outcome: "rejected",
        };
      participantId = earlier.participantId;
    } else {
      if (replayed.state.lastSeq !== details.expectedLastSeq)
        return { ok: false, message: STALE_MESSAGE, outcome: "conflict" };
      const checked = applyEvent(replayed.state, {
        type: "PlayerJoined",
        seq: replayed.state.lastSeq + 1,
        eventId: details.eventId,
        at,
        actorId: host.userId,
        payload: {
          participant: {
            participantId: participantId as ReturnType<typeof randomUUID>,
            firstName: details.firstName,
            lastName: details.lastName,
            skill: details.skillLevel,
            gender: details.gender,
          },
        },
      });
      if (!checked.ok)
        return {
          ok: false,
          message: checked.error.message,
          outcome: "rejected",
          engineErrorCode: checked.error.code,
        };
    }
    const { data, error } = await createSupabaseAdminClient()
      .rpc("add_participant_mid_session", {
        p_actor_user_id: host.userId,
        p_session_id: details.sessionId,
        p_session_participant_id: participantId,
        p_first_name: details.firstName,
        p_last_name: details.lastName,
        p_skill_level: details.skillLevel,
        p_gender: details.gender,
        // People are told apart by UUID; the event id stops a double add.
        p_allows_same_name: true,
        p_event_id: details.eventId,
        p_expected_last_seq: details.expectedLastSeq,
        p_occurred_at: new Date(at).toISOString(),
      })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) {
      if (error.message === "STALE_EXPECTED_SEQ")
        return { ok: false, message: STALE_MESSAGE, outcome: "conflict" };
      if (error.message === "SESSION_NOT_LIVE")
        return {
          ok: false,
          message: en.serverMessages.addPlayer.notLive,
          outcome: "rejected",
        };
      throw new Error(`add_participant_mid_session failed: ${error.message}`);
    }
    const result = data as { status?: string; seq?: number } | null;
    // Never report success without the database's own confirmation.
    if (typeof result?.seq !== "number")
      throw new Error("add_participant_mid_session returned no sequence");
    return {
      ok: true,
      seq: result.seq,
      wasDuplicate: result.status === "duplicate",
    };
  } catch (error) {
    console.error("Adding a live player failed", {
      actorUserId: host.userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      message: en.serverMessages.addPlayer.couldNotConfirm,
      outcome: "unknown",
    };
  }
}
