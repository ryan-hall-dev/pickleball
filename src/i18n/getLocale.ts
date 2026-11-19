import "server-only";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE_NAME, pickLocale, type Locale } from "./locales";

/** This browser's language: its saved choice, else its Accept-Language. */
export async function getLocale(): Promise<Locale> {
  const [cookieStore, requestHeaders] = await Promise.all([
    cookies(),
    headers(),
  ]);
  return pickLocale(
    cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    requestHeaders.get("accept-language"),
  );
}
