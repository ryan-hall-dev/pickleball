import { z } from "zod";
import type { HostRole } from "@/server/auth/hostAccess";

/** Mirrors the `short_label` domain: trimmed, 1-80 characters, no control characters. */
export const HOST_DISPLAY_NAME_MAX_LENGTH = 80;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const inviteHostInputSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: "Enter a valid email address." }).max(254)),
  displayName: z
    .string()
    .trim()
    .min(1, { error: "Enter a display name." })
    .max(HOST_DISPLAY_NAME_MAX_LENGTH, {
      error: `Use at most ${HOST_DISPLAY_NAME_MAX_LENGTH} characters.`,
    })
    .refine((name) => !CONTROL_CHARACTERS.test(name), {
      error: "Remove special characters.",
    }),
});

export type InviteHostInput = z.infer<typeof inviteHostInputSchema>;

export type HostRemovalDenial =
  "CANNOT_REMOVE_SELF" | "HOST_NOT_FOUND" | "CANNOT_REMOVE_MANAGER";

export interface HostRemovalCheckInput {
  actorUserId: string;
  /** Null when the target is not on the hosts list of the actor's social. */
  targetHost: { userId: string; role: HostRole } | null;
}

/**
 * A social manager may remove another host of their social, but never
 * themselves and never a manager: only the operator removes managers, with
 * the script (decision D3 in docs/plans/socials.md).
 */
export function checkHostRemoval({
  actorUserId,
  targetHost,
}: HostRemovalCheckInput):
  { ok: true } | { ok: false; reason: HostRemovalDenial } {
  if (!targetHost) return { ok: false, reason: "HOST_NOT_FOUND" };
  if (targetHost.userId === actorUserId) {
    return { ok: false, reason: "CANNOT_REMOVE_SELF" };
  }
  if (targetHost.role === "manager") {
    return { ok: false, reason: "CANNOT_REMOVE_MANAGER" };
  }
  return { ok: true };
}

export const HOST_REMOVAL_DENIAL_MESSAGES: Record<HostRemovalDenial, string> = {
  CANNOT_REMOVE_SELF: "You can't remove yourself.",
  HOST_NOT_FOUND: "That host has already been removed.",
  CANNOT_REMOVE_MANAGER: "Only the operator can remove a social manager.",
};
