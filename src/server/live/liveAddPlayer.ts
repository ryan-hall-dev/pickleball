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

const STALE_MESSAGE =
  "The session changed before this was saved. Nobody was added. Check the latest list, then add again.";

/**
 * Adds a session-only player to the live waiting list (one transaction:
 * snapshot row plus `PlayerJoined`). Never merges by name: a name already in
 * the session is refused by the database. A retry with the same event id
 * returns the original write instead of a second player.
 */
export async function addLivePlayer(
  input: LiveAddPlayerInput,
): Promise<LiveWriteResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok)
    return {
      ok: false,
      message: "Sign in as a host to change this session.",
      outcome: "rejected",
    };
  const parsed = liveAddPlayerSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      message: "Check the name, gender and level, then try again.",
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
    const landed = log.events.find(
      (event) => event.eventId === details.eventId,
    );
    let participantId: string = randomUUID();
    if (landed) {
      // An earlier try of this very add: let the database answer it again.
      if (landed.type !== "PlayerJoined")
        return {
          ok: false,
          message: "That action ID was already used. Refresh and try again.",
          outcome: "rejected",
        };
      participantId = landed.payload.participant.participantId;
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
        p_event_id: details.eventId,
        p_expected_last_seq: details.expectedLastSeq,
        p_occurred_at: new Date(at).toISOString(),
      })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) {
      if (error.message === "NAME_ALREADY_IN_SESSION")
        return {
          ok: false,
          message:
            "Someone with this name is already in the session. Nobody was added. Use a different spelling only if they are a different person.",
          outcome: "rejected",
        };
      if (error.message === "STALE_EXPECTED_SEQ")
        return { ok: false, message: STALE_MESSAGE, outcome: "conflict" };
      if (error.message === "SESSION_NOT_LIVE")
        return {
          ok: false,
          message: "This session is not live, so nobody can be added.",
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
      message:
        "Couldn't confirm that the player was added. Retry to check whether it was saved.",
      outcome: "unknown",
    };
  }
}
