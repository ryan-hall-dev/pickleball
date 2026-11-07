/**
 * The visitor's IP as reported by the host platform's proxy. Vercel (and
 * `next start` itself) set `x-forwarded-for`, overwriting any value the client
 * sent; its first entry is the original client. Null when no header is present.
 */
export function clientIpFromHeaders(requestHeaders: Headers): string | null {
  const forwardedFor = requestHeaders
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  if (forwardedFor) return forwardedFor;
  const realIp = requestHeaders.get("x-real-ip")?.trim();
  return realIp || null;
}
