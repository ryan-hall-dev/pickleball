"use server";

import { z } from "zod";
import {
  isSimpleSocialV2,
  participantName,
  type SessionState,
} from "@/engine/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runAutomaticActions } from "@/server/live/autoPrepare";
import {
  loadReplayedState,
  submitNonHostSessionAction,
} from "@/server/nonHostSessionAction";
import { planPlayerAction } from "./playerActionPlan";
import {
  playerProjection,
  readyFriendMatches,
  type PlayerView,
  type StoredScore,
} from "./playerProjection";
import { readClientIpHash, readDeviceTokenHash } from "./checkinDevice";
import { checkinDatabaseTimeoutSignal, logCheckinFailure } from "./checkinPage";
import { checkinTagSchema } from "./checkinRules";

// A checked-in player's own actions from the check-in page
// (docs/plans/reclub-to-court-v1.md, Phase 2; screens p5-p9, p15). The phone
// sends only what it means ("I'm ready"); the server works out the action
// from the current log, so a player never needs sequence numbers or ids of
// groups. The phone's check-in cookie identifies the player; the database
// checks again that a player acts only for themselves.

const inputSchema = z.object({
  sessionId: z.uuid(),
  /** New per tap; a retry of the same tap reuses it. */
  eventId: z.uuid(),
  intent: z.enum([
    "confirm",
    "takeBreak",
    "readyAgain",
    "leave",
    "gameStarted",
    "askFriend",
    "acceptFriend",
    "endFriend",
  ]),
  /** For askFriend: the participant asked. */
  friendId: z.uuid().nullable().default(null),
});

export type PlayerActionResult =
  | { ok: true }
  | {
      ok: false;
      failure:
        /** This phone hasn't checked in to this session. */
        | "not_checked_in"
        /** The action no longer fits: not in an Up next group, not all ready, etc. */
        | "no_longer_possible"
        /** The page showed another session. */
        | "session_changed"
        | "unavailable";
    };

/** Tries again from the newer log when another write lands first. */
const MAX_ATTEMPTS = 3;

/** The participant this phone checked in as in `sessionId`, or null. */
async function checkedInParticipantId(
  checkinTag: string,
  sessionId: string,
): Promise<string | null | "session_changed"> {
  const deviceHash = await readDeviceTokenHash(sessionId);
  if (!deviceHash) return null;
  const { data, error } = await createSupabaseAdminClient()
    .rpc("get_checkin_participant", {
      p_checkin_tag: checkinTag,
      p_expected_session_id: sessionId,
      p_device_token_hash: deviceHash,
    })
    .abortSignal(checkinDatabaseTimeoutSignal());
  if (error) {
    if (error.message === "SESSION_CHANGED") return "session_changed";
    throw new Error(`get_checkin_participant failed: ${error.message}`);
  }
  return (data as string | null) ?? null;
}

/**
 * Does what the player means, then lets the app react (refill a seat given
 * up, ask the next four). A repeat tap is answered as done.
 */
export async function submitPlayerAction(
  checkinTag: unknown,
  input: unknown,
): Promise<PlayerActionResult> {
  const parsedTag = checkinTagSchema.safeParse(checkinTag);
  const parsed = inputSchema.safeParse(input);
  if (!parsedTag.success || !parsed.success)
    return { ok: false, failure: "no_longer_possible" };
  const { sessionId, eventId, intent, friendId } = parsed.data;
  try {
    const participantId = await checkedInParticipantId(
      parsedTag.data,
      sessionId,
    );
    if (participantId === "session_changed")
      return { ok: false, failure: "session_changed" };
    if (!participantId) return { ok: false, failure: "not_checked_in" };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const loaded = await loadReplayedState(sessionId);
      if (!loaded || !isSimpleSocialV2(loaded.state.config))
        return { ok: false, failure: "no_longer_possible" };
      if (loaded.events.some((event) => event.eventId === eventId))
        return { ok: true };
      const planned = planPlayerAction(
        loaded.state,
        participantId,
        intent,
        eventId,
        friendId,
      );
      if (planned.kind === "nothing") return { ok: true };
      if (planned.kind === "impossible")
        return { ok: false, failure: "no_longer_possible" };
      const now = Date.now();
      const result = await submitNonHostSessionAction(
        {
          sessionId,
          eventId: planned.eventId,
          expectedLastSeq: loaded.state.lastSeq,
          action: planned.action,
        },
        { kind: "player", participantId },
        { now: () => now, loaded },
      );
      if (result.ok) {
        const after = await loadReplayedState(sessionId);
        if (after) await runAutomaticActions(sessionId, after.state, now);
        return { ok: true };
      }
      if (result.reason === "INVALID_ACTION")
        return { ok: false, failure: "no_longer_possible" };
      // Another write landed first: plan again from the newer log.
    }
    return { ok: false, failure: "unavailable" };
  } catch (error) {
    logCheckinFailure("A player action failed", error);
    return { ok: false, failure: "unavailable" };
  }
}

export type ReadPlayerSessionResult =
  | { ok: true; view: PlayerView }
  | {
      ok: false;
      failure: "not_checked_in" | "session_changed" | "unavailable";
    };

const sessionInputSchema = z.object({ sessionId: z.uuid() });

/**
 * The player's own live view, polled every 5 s while the page is visible.
 * A player's page read also lets the app do what is due (ask the next four,
 * refill a seat), so nothing waits for a host's screen to be open (Phase 0
 * finding 6). Only this player's own group and friend are named.
 */
export async function readPlayerSession(
  checkinTag: unknown,
  input: unknown,
): Promise<ReadPlayerSessionResult> {
  const parsedTag = checkinTagSchema.safeParse(checkinTag);
  const parsed = sessionInputSchema.safeParse(input);
  if (!parsedTag.success || !parsed.success)
    return { ok: false, failure: "unavailable" };
  try {
    const participantId = await checkedInParticipantId(
      parsedTag.data,
      parsed.data.sessionId,
    );
    if (participantId === "session_changed")
      return { ok: false, failure: "session_changed" };
    if (!participantId) return { ok: false, failure: "not_checked_in" };
    let loaded = await loadReplayedState(parsed.data.sessionId);
    if (!loaded) return { ok: false, failure: "session_changed" };
    const now = Math.max(Date.now(), loaded.state.lastAt ?? 0);
    if (
      isSimpleSocialV2(loaded.state.config) &&
      (await runAutomaticActions(parsed.data.sessionId, loaded.state, now))
    )
      loaded = (await loadReplayedState(parsed.data.sessionId)) ?? loaded;
    const lastMatchId =
      loaded.state.participants[participantId]?.matchIds.at(-1) ?? null;
    return {
      ok: true,
      view: playerProjection(
        loaded.state,
        participantId,
        now,
        lastMatchId
          ? await storedScores(
              parsed.data.sessionId,
              [lastMatchId],
              loaded.state,
            )
          : new Map(),
      ),
    };
  } catch (error) {
    logCheckinFailure("Reading a player's session failed", error);
    return { ok: false, failure: "unavailable" };
  }
}

const friendSearchSchema = z.object({
  sessionId: z.uuid(),
  query: z.string().max(100),
});

/** "Play with a friend": at most 5 Ready players by name (p12). */
export async function searchReadyFriends(
  checkinTag: unknown,
  input: unknown,
): Promise<
  | { ok: true; friends: Array<{ participantId: string; name: string }> }
  | { ok: false }
> {
  const parsedTag = checkinTagSchema.safeParse(checkinTag);
  const parsed = friendSearchSchema.safeParse(input);
  if (!parsedTag.success || !parsed.success) return { ok: false };
  try {
    const participantId = await checkedInParticipantId(
      parsedTag.data,
      parsed.data.sessionId,
    );
    if (!participantId || participantId === "session_changed")
      return { ok: false };
    const loaded = await loadReplayedState(parsed.data.sessionId);
    if (!loaded || !isSimpleSocialV2(loaded.state.config)) return { ok: false };
    return {
      ok: true,
      friends: readyFriendMatches(
        loaded.state,
        participantId,
        parsed.data.query,
        Date.now(),
      ),
    };
  } catch (error) {
    logCheckinFailure("Friend search failed", error);
    return { ok: false };
  }
}

/** Standing scores of these games, with who entered each (a player's name, or null for a host). */
async function storedScores(
  sessionId: string,
  matchIds: readonly string[],
  state: SessionState,
): Promise<Map<string, StoredScore>> {
  const { data, error } = await createSupabaseAdminClient()
    .from("match_scores")
    .select("match_id, score_team_a, score_team_b, entered_by_participant_id")
    .eq("session_id", sessionId)
    .in("match_id", [...matchIds])
    .is("voided_at", null)
    .abortSignal(checkinDatabaseTimeoutSignal());
  if (error) throw new Error(`Reading scores failed: ${error.message}`);
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
          enteredByName: by ? participantName(by.participant) : null,
        },
      ];
    }),
  );
}

const scoreInputSchema = z.object({
  sessionId: z.uuid(),
  matchId: z.uuid(),
  yourScore: z.number().int().min(0).max(99),
  theirScore: z.number().int().min(0).max(99),
});

export type SubmitScoreResult =
  | { ok: true; outcome: "recorded" | "already_same" }
  | {
      ok: false;
      failure: "already_recorded" | "invalid" | "not_your_game" | "unavailable";
    };

/**
 * p16: a player enters their last game's score as "your team / their team";
 * the server turns that into team A / team B from the game itself. The first
 * score stands; a different one is answered "already recorded" (p17).
 */
export async function submitScore(
  checkinTag: unknown,
  input: unknown,
): Promise<SubmitScoreResult> {
  const parsedTag = checkinTagSchema.safeParse(checkinTag);
  const parsed = scoreInputSchema.safeParse(input);
  if (!parsedTag.success || !parsed.success)
    return { ok: false, failure: "invalid" };
  const { sessionId, matchId, yourScore, theirScore } = parsed.data;
  if (yourScore === theirScore) return { ok: false, failure: "invalid" };
  try {
    const participantId = await checkedInParticipantId(
      parsedTag.data,
      sessionId,
    );
    if (!participantId || participantId === "session_changed")
      return { ok: false, failure: "not_your_game" };
    const loaded = await loadReplayedState(sessionId);
    const match = loaded?.state.matches[matchId];
    const seat = match?.segments.find(
      (segment) =>
        segment.participantId === participantId &&
        segment.endedMidMatchBySeq === null,
    );
    if (!match || !seat) return { ok: false, failure: "not_your_game" };
    const deviceHash = await readDeviceTokenHash(sessionId);
    if (!deviceHash) return { ok: false, failure: "not_your_game" };
    const { data, error } = await createSupabaseAdminClient()
      .rpc("submit_player_score", {
        p_checkin_tag: parsedTag.data,
        p_expected_session_id: sessionId,
        p_device_token_hash: deviceHash,
        p_ip_hash: await readClientIpHash(),
        p_match_id: matchId,
        p_score_team_a: seat.team === "A" ? yourScore : theirScore,
        p_score_team_b: seat.team === "A" ? theirScore : yourScore,
      })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) {
      if (
        error.message === "NOT_IN_MATCH" ||
        error.message === "MATCH_NOT_FINISHED"
      )
        return { ok: false, failure: "not_your_game" };
      if (error.message === "INVALID_SCORE")
        return { ok: false, failure: "invalid" };
      throw new Error(`submit_player_score failed: ${error.message}`);
    }
    const status = (data as { status: string }).status;
    if (status === "already_recorded")
      return { ok: false, failure: "already_recorded" };
    return {
      ok: true,
      outcome: status === "already_same" ? "already_same" : "recorded",
    };
  } catch (error) {
    logCheckinFailure("Entering a score failed", error);
    return { ok: false, failure: "unavailable" };
  }
}
