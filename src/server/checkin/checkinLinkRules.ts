// The social's public check-in link (/t/<tag>), as hosts see, copy, print
// and encode it in the QR code. Pure: the request headers are passed in.

/** The public check-in page's path prefix (src/app/t/[tag]). */
export const CHECKIN_PAGE_PATH_PREFIX = "/t/";

// A host name with an optional port: letters, digits, dots and hyphens only,
// so nothing odd from a header ends up in a printed link.
const HOST_WITH_OPTIONAL_PORT = /^[a-z0-9.-]+(:\d{1,5})?$/i;
const LOCAL_HOST_NAMES = new Set(["localhost", "127.0.0.1"]);

function firstHeaderValue(
  requestHeaders: Headers,
  headerName: string,
): string | null {
  const value = requestHeaders.get(headerName)?.split(",")[0]?.trim();
  return value || null;
}

/**
 * The configured public origin (`PUBLIC_APP_ORIGIN`), or null when unset.
 * Production sets it so printed stickers and QR codes carry the real
 * address whatever host name a request arrived on. Throws on anything but a
 * bare http(s) origin (no path, query, credentials or trailing slash), so a
 * typo can't end up on printed stickers.
 */
export function publicOriginFromSetting(
  configuredOrigin: string | undefined,
): string | null {
  if (configuredOrigin === undefined || configuredOrigin.trim() === "") {
    return null;
  }
  const invalid = new Error(
    `PUBLIC_APP_ORIGIN must be an http or https origin such as https://social.example.com, with no path or trailing slash (got "${configuredOrigin}").`,
  );
  let url: URL;
  try {
    url = new URL(configuredOrigin);
  } catch {
    throw invalid;
  }
  const isBareOrigin =
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.origin.toLowerCase() === configuredOrigin.toLowerCase();
  if (!isBareOrigin) throw invalid;
  return url.origin;
}

/**
 * The origin players reach this app on, from the request the host made:
 * the fallback when PUBLIC_APP_ORIGIN isn't set (local development). A
 * host opens these pages on the same public address players use. The host platform's proxy (Vercel, `next start`) sets
 * `x-forwarded-host` / `x-forwarded-proto`; `host` is the fallback. Throws
 * when there is no usable host, rather than printing a broken link.
 */
export function publicOriginFromHeaders(requestHeaders: Headers): string {
  const host =
    firstHeaderValue(requestHeaders, "x-forwarded-host") ??
    firstHeaderValue(requestHeaders, "host");
  if (!host || !HOST_WITH_OPTIONAL_PORT.test(host)) {
    throw new Error(
      "The request has no usable host header, so the check-in link can't be built.",
    );
  }
  const forwardedProtocol = firstHeaderValue(
    requestHeaders,
    "x-forwarded-proto",
  );
  const hostName = host.replace(/:\d+$/, "").toLowerCase();
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : LOCAL_HOST_NAMES.has(hostName)
        ? "http"
        : "https";
  return `${protocol}://${host.toLowerCase()}`;
}

/** The full check-in link, e.g. https://pickleball.example/t/<tag>. */
export function checkinLinkFromOrigin(
  publicOrigin: string,
  checkinTag: string,
): string {
  return `${publicOrigin}${CHECKIN_PAGE_PATH_PREFIX}${checkinTag}`;
}

/** The link without its scheme, for printing under the QR code. */
export function shortCheckinLink(checkinLink: string): string {
  return checkinLink.replace(/^https?:\/\//, "");
}
