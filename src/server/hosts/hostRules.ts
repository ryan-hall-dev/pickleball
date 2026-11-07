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
  "CANNOT_REMOVE_SELF" | "HOST_NOT_FOUND" | "LAST_ADMIN";

export interface HostRemovalCheckInput {
  actorUserId: string;
  /** Null when the target is not on the hosts list. */
  targetHost: { userId: string; role: HostRole } | null;
  adminCount: number;
}

/**
 * An admin may remove any other host, but never themselves, and never the last
 * admin (the database trigger is the final guard against concurrent removals).
 */
export function checkHostRemoval({
  actorUserId,
  targetHost,
  adminCount,
}: HostRemovalCheckInput):
  { ok: true } | { ok: false; reason: HostRemovalDenial } {
  if (!targetHost) return { ok: false, reason: "HOST_NOT_FOUND" };
  if (targetHost.userId === actorUserId) {
    return { ok: false, reason: "CANNOT_REMOVE_SELF" };
  }
  if (targetHost.role === "admin" && adminCount <= 1) {
    return { ok: false, reason: "LAST_ADMIN" };
  }
  return { ok: true };
}

export const HOST_REMOVAL_DENIAL_MESSAGES: Record<HostRemovalDenial, string> = {
  CANNOT_REMOVE_SELF: "You can't remove yourself. Ask another admin to do it.",
  HOST_NOT_FOUND: "That host has already been removed.",
  LAST_ADMIN:
    "The club needs at least one admin, so this one can't be removed.",
};
