import "server-only";
import { createHash, createHmac } from "node:crypto";

// Hashes the public check-in page passes to search_checkin_names / submit_checkin,
// so raw device tokens and IP addresses never reach the database or its logs.

const MIN_IP_HMAC_SECRET_LENGTH = 32;

function readIpHmacSecret(): string {
  const secret = process.env.CHECKIN_IP_HMAC_SECRET;
  if (!secret || secret.length < MIN_IP_HMAC_SECRET_LENGTH) {
    throw new Error(
      `CHECKIN_IP_HMAC_SECRET must be set to at least ${MIN_IP_HMAC_SECRET_LENGTH} random characters (server only, never NEXT_PUBLIC_). ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }
  return secret;
}

/**
 * HMAC-SHA256 of the client IP with a server secret (lowercase hex). Keyed, so
 * the stored value can't be reversed by hashing every IPv4 address.
 */
export function hashClientIp(clientIp: string): string {
  if (clientIp.trim() === "") {
    throw new Error("hashClientIp needs the client IP address.");
  }
  return createHmac("sha256", readIpHmacSecret())
    .update(clientIp.trim())
    .digest("hex");
}

/**
 * SHA-256 of the random device token from the player's cookie (lowercase hex),
 * the form stored in checkin_requests.
 */
export function hashDeviceToken(deviceToken: string): string {
  if (deviceToken === "") {
    throw new Error("hashDeviceToken needs the device token.");
  }
  return createHash("sha256").update(deviceToken, "utf8").digest("hex");
}
