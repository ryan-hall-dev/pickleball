import { z } from "zod";
import type { HostRole } from "@/server/auth/hostAccess";
import { en } from "@/i18n/messages/en";

/** Mirrors the `short_label` domain: trimmed, 1-80 characters, no control characters. */
export const HOST_DISPLAY_NAME_MAX_LENGTH = 80;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const inviteHostInputSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: en.validation.validEmail }).max(254)),
  displayName: z
    .string()
    .trim()
    .min(1, { error: en.validation.displayNameRequired })
    .max(HOST_DISPLAY_NAME_MAX_LENGTH, {
      error: en.validation.nameTooLong(HOST_DISPLAY_NAME_MAX_LENGTH),
    })
    .refine((name) => !CONTROL_CHARACTERS.test(name), {
      error: en.validation.nameHasControlCharacters,
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
  CANNOT_REMOVE_SELF: en.serverMessages.hosts.cannotRemoveSelf,
  HOST_NOT_FOUND: en.serverMessages.hosts.alreadyRemoved,
  CANNOT_REMOVE_MANAGER: en.serverMessages.hosts.cannotRemoveManager,
};
