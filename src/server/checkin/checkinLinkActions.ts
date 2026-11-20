"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import {
  HOST_ACCESS_DENIAL_MESSAGES,
  type HostAccessDenial,
} from "@/server/auth/hostAccess";
import { checkinDatabaseTimeoutSignal } from "./checkinPage";
import { en } from "@/i18n/messages/en";

// Issuing a new check-in link (a new socials.checkin_tag) is manager-only
// (M5 plan). The caller is verified as their social's manager with getUser()
// first; then reissue_checkin_tag (service_role only, decision 0002) derives
// the social from p_actor_user_id and checks the role again itself.

export type ReissueCheckinLinkResult =
  { ok: true } | { ok: false; message: string };

const SOMETHING_WENT_WRONG = en.serverMessages.somethingWentWrong;

/** Every page that shows the link (the QR and stickers encode it). */
const PATHS_SHOWING_THE_CHECKIN_LINK = [
  "/hosts",
  "/checkin-link",
  "/checkin-link/print",
];

/** The database's refusals that mean the same as a failed host check. */
function accessDenialFromError(error: {
  message: string;
}): HostAccessDenial | null {
  return error.message === "NOT_A_MANAGER" || error.message === "NOT_A_HOST"
    ? error.message
    : null;
}

/**
 * Replaces the social's check-in tag. The old /t/<tag> link, its QR code and
 * every sticker stop working at once; requests already sent belong to their
 * session and are untouched.
 */
export async function reissueCheckinLink(): Promise<ReissueCheckinLinkResult> {
  const authorization = await authorizeCurrentHost("manager");
  if (!authorization.ok) {
    return {
      ok: false,
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }
  const { host } = authorization;

  try {
    const { data: newCheckinTag, error } = await createSupabaseAdminClient()
      .rpc("reissue_checkin_tag", { p_actor_user_id: host.userId })
      .abortSignal(checkinDatabaseTimeoutSignal());
    if (error) {
      const denial = accessDenialFromError(error);
      if (denial)
        return { ok: false, message: HOST_ACCESS_DENIAL_MESSAGES[denial] };
      throw new Error(`reissue_checkin_tag failed: ${error.message}`);
    }
    if (typeof newCheckinTag !== "string" || newCheckinTag === "") {
      throw new Error("reissue_checkin_tag returned no tag.");
    }
  } catch (error) {
    // Ids only: the tag itself is never logged.
    console.error("Issuing a new check-in link failed", {
      actorUserId: host.userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, message: SOMETHING_WENT_WRONG };
  }

  for (const path of PATHS_SHOWING_THE_CHECKIN_LINK) revalidatePath(path);
  return { ok: true };
}
