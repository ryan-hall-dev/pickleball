import "server-only";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { clientIpFromHeaders } from "@/server/auth/clientIp";
import { hashClientIp, hashDeviceToken } from "./clientIdentity";

// The player's phone, as the public check-in page knows it: a random device
// token in an HttpOnly cookie (acceptance criterion 17). Only its SHA-256
// reaches the database. Cookies can only be written by server actions and
// route handlers, so the page render just reads it; the first search or
// submit creates it.

const DEVICE_COOKIE_NAME = "checkin_device";
/** 32 random bytes, base64url: 43 characters. */
const DEVICE_TOKEN_BYTES = 32;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Browsers cap cookie lifetimes at 400 days. */
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

async function readDeviceToken(): Promise<string | null> {
  const deviceToken = (await cookies()).get(DEVICE_COOKIE_NAME)?.value;
  return deviceToken && DEVICE_TOKEN_PATTERN.test(deviceToken)
    ? deviceToken
    : null;
}

/** This phone's device hash, or null before its first search or submit. */
export async function readDeviceTokenHash(): Promise<string | null> {
  const deviceToken = await readDeviceToken();
  return deviceToken ? hashDeviceToken(deviceToken) : null;
}

/**
 * This phone's device hash, creating the device cookie when it is missing (or
 * malformed). Server actions only: rendering can't set cookies.
 */
export async function ensureDeviceTokenHash(): Promise<string> {
  const existingDeviceToken = await readDeviceToken();
  if (existingDeviceToken) return hashDeviceToken(existingDeviceToken);

  const deviceToken = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
  (await cookies()).set(DEVICE_COOKIE_NAME, deviceToken, {
    httpOnly: true,
    // Production serves https, so the cookie is Secure there. In development
    // phones reach the dev server over plain http on the LAN, and browsers
    // refuse to store a Secure cookie from an http origin.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    // Only the check-in page and its actions need it.
    path: "/t",
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
  return hashDeviceToken(deviceToken);
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
