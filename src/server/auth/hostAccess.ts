import type { Database } from "@/lib/database.types";

export type HostRole = Database["public"]["Enums"]["host_role"];

export interface SignedInHost {
  userId: string;
  email: string | null;
  displayName: string;
  role: HostRole;
}

/** Who is making this request, as far as the host area is concerned. */
export type HostAccess =
  | { status: "signed_out" }
  /** Signed in, but not on the hosts allow-list (never invited, or removed). */
  | { status: "not_a_host"; email: string | null }
  | { status: "host"; host: SignedInHost };

export type HostAccessDenial = "SIGNED_OUT" | "NOT_A_HOST" | "NOT_AN_ADMIN";

export type HostAuthorization =
  { ok: true; host: SignedInHost } | { ok: false; reason: HostAccessDenial };

/** Decides whether `access` may do something that needs `requiredRole`. */
export function authorizeHostAccess(
  access: HostAccess,
  requiredRole: HostRole,
): HostAuthorization {
  if (access.status === "signed_out")
    return { ok: false, reason: "SIGNED_OUT" };
  if (access.status === "not_a_host")
    return { ok: false, reason: "NOT_A_HOST" };
  if (requiredRole === "admin" && access.host.role !== "admin") {
    return { ok: false, reason: "NOT_AN_ADMIN" };
  }
  return { ok: true, host: access.host };
}

export const HOST_ACCESS_DENIAL_MESSAGES: Record<HostAccessDenial, string> = {
  SIGNED_OUT: "Your session has ended. Sign in again.",
  NOT_A_HOST: "You're not a host here. Ask an admin for an invite.",
  NOT_AN_ADMIN: "Only admins can manage hosts.",
};
