"use server";

import { z } from "zod";
import {
  DEFAULT_UP_NEXT_AFTER_MINUTES,
  type Participant,
  type SessionEventPayloads,
} from "@/engine/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import { HOST_ACCESS_DENIAL_MESSAGES } from "@/server/auth/hostAccess";
import { submitSessionAction } from "@/server/submitSessionAction";
import { listDraftParticipants } from "./setupDraft";
import {
  MAX_SESSION_DURATION_MINUTES,
  parseSessionDraftConfig,
} from "./setupRules";
import { en } from "@/i18n/messages/en";

const inputSchema = z.object({
  sessionId: z.uuid(),
  eventId: z.uuid(),
  expectedDraftRevision: z.number().int().nonnegative(),
});

type StartSimpleSessionInput = z.infer<typeof inputSchema>;
type StartSimpleSessionResult =
  | { ok: true; seq: number; occurredAt: number; wasDuplicate: boolean }
  | { ok: false; message: string; isConflict?: true };

/** Server-only preparation for the future short Setup; all start data comes from the draft. */
export async function startSimpleSession(
  input: StartSimpleSessionInput,
): Promise<StartSimpleSessionResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, message: en.serverMessages.start.reloadSetupAndRetry };
  const { host } = authorization;
  try {
    const client = await createSupabaseServerClient();
    const { data: session, error } = await client
      .from("sessions")
      .select(
        "status, config_snapshot, draft_revision, planned_start, planned_end",
      )
      .eq("id", parsed.data.sessionId)
      .eq("social_id", host.socialId)
      .maybeSingle();
    if (error) throw new Error(`Reading the draft failed: ${error.message}`);
    if (!session)
      return {
        ok: false,
        message: en.serverMessages.start.sessionNotAvailable,
      };

    // Recover the original payload before inspecting draft status: a successful
    // start changes both status and config, but a retry must return that start.
    const { data: landed, error: eventError } = await client
      .from("session_events")
      .select("type, payload")
      .eq("session_id", parsed.data.sessionId)
      .eq("event_id", parsed.data.eventId)
      .maybeSingle();
    if (eventError)
      throw new Error(`Reading the start failed: ${eventError.message}`);
    let payload: SessionEventPayloads["SessionStarted"];
    if (landed) {
      if (landed.type !== "SessionStarted") {
        return {
          ok: false,
          message: en.serverMessages.start.actionIdUsed,
        };
      }
      payload =
        landed.payload as unknown as SessionEventPayloads["SessionStarted"];
      if (
        payload.config.policyVersion !== "simple-social-v1" &&
        payload.config.policyVersion !== "simple-social-v2"
      ) {
        return {
          ok: false,
          message: en.serverMessages.start.actionIdUsed,
        };
      }
    } else {
      if (session.status !== "draft")
        return {
          ok: false,
          message: en.serverMessages.start.noLongerDraft,
        };
      if (session.draft_revision !== parsed.data.expectedDraftRevision) {
        return {
          ok: false,
          message: en.serverMessages.start.changedElsewhere,
          isConflict: true,
        };
      }
      const config = parseSessionDraftConfig(session.config_snapshot);
      if (
        config.courts.length === 0 ||
        config.courts.some((court) => court.format !== "doubles")
      ) {
        return {
          ok: false,
          message: en.serverMessages.start.chooseDoublesCourt,
        };
      }
      const duration =
        (Date.parse(session.planned_end) - Date.parse(session.planned_start)) /
        60_000;
      if (
        !Number.isInteger(duration) ||
        duration < 1 ||
        duration > MAX_SESSION_DURATION_MINUTES
      ) {
        return {
          ok: false,
          message: en.serverMessages.start.chooseDuration,
        };
      }
      const roster = await listDraftParticipants(
        client,
        host.socialId,
        parsed.data.sessionId,
      );
      const participants: Participant[] = [];
      for (const player of roster) {
        if (player.gender === null || player.skillLevel === null) {
          return {
            ok: false,
            message: en.serverMessages.start.completeDetails,
          };
        }
        participants.push({
          participantId: player.participantId,
          firstName: player.firstName,
          lastName: player.lastName,
          gender: player.gender,
          skill: player.skillLevel,
        });
      }
      payload = {
        config: {
          // New sessions use v2: Up next confirmations and the timer
          // (docs/plans/reclub-to-court-v1.md). v1 sessions replay as before.
          policyVersion: "simple-social-v2",
          upNextAfterMinutes: DEFAULT_UP_NEXT_AFTER_MINUTES,
          courts: config.courts,
          targetMatchMinutes: config.targetMatchMinutes,
          changeoverMinutes: config.changeoverMinutes,
          rotation: config.rotation,
          plannedDurationMinutes: duration,
          participants,
        },
        initialAttendeeIds: participants.map((player) => player.participantId),
        initialMatches: [],
      };
    }
    const result = await submitSessionAction(client, {
      sessionId: parsed.data.sessionId,
      eventId: parsed.data.eventId,
      expectedLastSeq: 0,
      expectedDraftRevision: parsed.data.expectedDraftRevision,
      request: { kind: "action", action: { type: "SessionStarted", payload } },
    });
    if (result.ok) return result;
    if (result.reason === "UPDATED_BY_ANOTHER_HOST") {
      return {
        ok: false,
        message: en.serverMessages.start.playersChangedElsewhere,
        isConflict: true,
      };
    }
    return { ok: false, message: result.error.message };
  } catch (error) {
    console.error("Starting a simple session failed", {
      actorUserId: host.userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      message: en.serverMessages.start.couldNotStart,
    };
  }
}
