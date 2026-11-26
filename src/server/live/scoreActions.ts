"use server";

import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import { checkinDatabaseTimeoutSignal } from "@/server/checkin/checkinPage";
import { en } from "@/i18n/messages/en";

// A host enters a finished game's score, or corrects it (h13; D8). Scores sit
// beside the session log, so this never conflicts with court turnover.

const inputSchema = z.object({
  matchId: z.uuid(),
  scoreTeamA: z.number().int().min(0).max(99),
  scoreTeamB: z.number().int().min(0).max(99),
});

export type SetMatchScoreResult = { ok: true } | { ok: false; message: string };

export async function setMatchScore(
  input: unknown,
): Promise<SetMatchScoreResult> {
  const authorization = await authorizeCurrentHost("host");
  if (!authorization.ok)
    return { ok: false, message: en.serverMessages.live.signInToChange };
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || parsed.data.scoreTeamA === parsed.data.scoreTeamB)
    return { ok: false, message: en.serverMessages.scores.invalid };
  try {
    const { error } = await createSupabaseAdminClient()
      .rpc("host_set_match_score", {
        p_actor_user_id: authorization.host.userId,
        p_match_id: parsed.data.matchId,
        p_score_team_a: parsed.data.scoreTeamA,
        p_score_team_b: parsed.data.scoreTeamB,
      })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) {
      if (error.message === "MATCH_NOT_FINISHED")
        return { ok: false, message: en.serverMessages.scores.notFinished };
      if (error.message === "INVALID_SCORE")
        return { ok: false, message: en.serverMessages.scores.invalid };
      throw new Error(error.message);
    }
    return { ok: true };
  } catch (error) {
    console.error("Saving a score failed", {
      actorUserId: authorization.host.userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, message: en.serverMessages.roster.couldNotSave };
  }
}
