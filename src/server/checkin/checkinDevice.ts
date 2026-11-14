import "server-only";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { clientIpFromHeaders } from "@/server/auth/clientIp";
import { hashClientIp, hashDeviceToken } from "./clientIdentity";

// Independent random tokens per session. Never read the legacy universal cookie.
const DEVICE_TOKEN_BYTES = 32;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

function cookieName(sessionId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      sessionId,
    )
  ) {
    throw new Error("A valid session ID is required for a check-in cookie.");
  }
  return `checkin_session_${sessionId}`;
}

async function readDeviceToken(sessionId: string): Promise<string | null> {
  const token = (await cookies()).get(cookieName(sessionId))?.value;
  return token && DEVICE_TOKEN_PATTERN.test(token) ? token : null;
}

export async function readDeviceTokenHash(
  sessionId: string,
): Promise<string | null> {
  const token = await readDeviceToken(sessionId);
  return token ? hashDeviceToken(token) : null;
}

/** Called before enabling submit, so a lost submit response can be retried. */
export async function ensureDeviceTokenHash(
  sessionId: string,
  checkinTag: string,
): Promise<string> {
  const existingToken = await readDeviceToken(sessionId);
  if (existingToken) return hashDeviceToken(existingToken);
  const token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
  (await cookies()).set(cookieName(sessionId), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/t/${checkinTag}`,
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
  return hashDeviceToken(token);
}

/** HMAC of the visitor's IP, for the per-network rate limits. */
export async function readClientIpHash(): Promise<string> {
  const clientIp = clientIpFromHeaders(await headers());
  if (!clientIp) {
    throw new Error(
      "No client IP: x-forwarded-for is missing, so check-in rate limits can't key on the network.",
    );
  }
  return hashClientIp(clientIp);
}
