"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authorizeCurrentHost } from "@/server/auth/currentHost";
import { HOST_ACCESS_DENIAL_MESSAGES } from "@/server/auth/hostAccess";
import { findOrCreateAuthUser } from "./authUsers";
import {
  checkHostRemoval,
  HOST_REMOVAL_DENIAL_MESSAGES,
  inviteHostInputSchema,
} from "./hostRules";

// Writes use the service-role client, always after the caller is verified as an
// admin with getUser() (docs/decisions/0002-server-only-writes.md).

export type InviteHostFormState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | {
      status: "error";
      message: string;
      fieldErrors: { email?: string; displayName?: string };
      submittedValues: { email: string; displayName: string };
    };

export type RemoveHostFormState =
  { status: "idle" } | { status: "error"; message: string };

const POSTGRES_UNIQUE_VIOLATION = "23505";
const HOSTS_PATH = "/hosts";
const SOMETHING_WENT_WRONG = "Something went wrong. Try again in a moment.";

function formText(formData: FormData, fieldName: string): string {
  const value = formData.get(fieldName);
  return typeof value === "string" ? value : "";
}

export async function inviteHost(
  _previousState: InviteHostFormState,
  formData: FormData,
): Promise<InviteHostFormState> {
  const submittedValues = {
    email: formText(formData, "email"),
    displayName: formText(formData, "displayName"),
  };
  const formError = (
    message: string,
    fieldErrors: { email?: string; displayName?: string } = {},
  ): InviteHostFormState => ({
    status: "error",
    message,
    fieldErrors,
    submittedValues,
  });

  const authorization = await authorizeCurrentHost("admin");
  if (!authorization.ok) {
    return formError(HOST_ACCESS_DENIAL_MESSAGES[authorization.reason]);
  }

  const parsed = inviteHostInputSchema.safeParse(submittedValues);
  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors;
    return formError("Fix the highlighted fields.", {
      email: fieldErrors.email?.[0],
      displayName: fieldErrors.displayName?.[0],
    });
  }
  const { email, displayName } = parsed.data;

  try {
    const adminClient = createSupabaseAdminClient();
    const invitedUserId = await findOrCreateAuthUser(adminClient, email);
    // checkin_tag is left to the database default: 122 random bits.
    const { error } = await adminClient.from("hosts").insert({
      user_id: invitedUserId,
      display_name: displayName,
      role: "host",
    });
    if (error?.code === POSTGRES_UNIQUE_VIOLATION) {
      return formError("That person is already a host.", {
        email: "Already on the hosts list.",
      });
    }
    if (error) throw new Error(`Adding the host failed: ${error.message}`);
  } catch (error) {
    console.error("Inviting a host failed", {
      actorUserId: authorization.host.userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return formError(SOMETHING_WENT_WRONG);
  }

  revalidatePath(HOSTS_PATH);
  return {
    status: "success",
    message: `${displayName} is now a host. They sign in on the login page with ${email}.`,
  };
}

export async function removeHost(
  _previousState: RemoveHostFormState,
  formData: FormData,
): Promise<RemoveHostFormState> {
  const authorization = await authorizeCurrentHost("admin");
  if (!authorization.ok) {
    return {
      status: "error",
      message: HOST_ACCESS_DENIAL_MESSAGES[authorization.reason],
    };
  }

  const parsedUserId = z.uuid().safeParse(formText(formData, "hostUserId"));
  if (!parsedUserId.success) {
    return {
      status: "error",
      message: HOST_REMOVAL_DENIAL_MESSAGES.HOST_NOT_FOUND,
    };
  }
  const targetUserId = parsedUserId.data;

  try {
    const adminClient = createSupabaseAdminClient();
    const [targetResult, adminCountResult] = await Promise.all([
      adminClient
        .from("hosts")
        .select("user_id, role")
        .eq("user_id", targetUserId)
        .maybeSingle(),
      adminClient
        .from("hosts")
        .select("user_id", { count: "exact", head: true })
        .eq("role", "admin"),
    ]);
    if (targetResult.error || adminCountResult.error) {
      throw new Error(
        `Reading hosts failed: ${targetResult.error?.message ?? adminCountResult.error?.message}`,
      );
    }

    const removalCheck = checkHostRemoval({
      actorUserId: authorization.host.userId,
      targetHost: targetResult.data
        ? { userId: targetResult.data.user_id, role: targetResult.data.role }
        : null,
      adminCount: adminCountResult.count ?? 0,
    });
    if (!removalCheck.ok) {
      return {
        status: "error",
        message: HOST_REMOVAL_DENIAL_MESSAGES[removalCheck.reason],
      };
    }

    // Removing the hosts row revokes access at once (RLS). It goes first so the
    // database's last-admin guard can refuse it with a clear error.
    const { error: deleteHostError } = await adminClient
      .from("hosts")
      .delete()
      .eq("user_id", targetUserId);
    if (deleteHostError?.message.includes("LAST_ADMIN")) {
      return {
        status: "error",
        message: HOST_REMOVAL_DENIAL_MESSAGES.LAST_ADMIN,
      };
    }
    if (deleteHostError) {
      throw new Error(
        `Deleting the host row failed: ${deleteHostError.message}`,
      );
    }

    // Then delete the login itself, so a removed host can't get a session at all.
    const { error: deleteUserError } =
      await adminClient.auth.admin.deleteUser(targetUserId);
    if (deleteUserError && deleteUserError.status !== 404) {
      // Access is already revoked; a re-invite reuses the leftover login.
      console.error("Deleting a removed host's login failed", {
        targetUserId,
        cause: deleteUserError.message,
      });
    }
  } catch (error) {
    console.error("Removing a host failed", {
      actorUserId: authorization.host.userId,
      targetUserId,
      cause: error instanceof Error ? error.message : String(error),
    });
    return { status: "error", message: SOMETHING_WENT_WRONG };
  }

  revalidatePath(HOSTS_PATH);
  return { status: "idle" };
}
