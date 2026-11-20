import "server-only";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE_NAME, pickLocale, type Locale } from "./locales";
import { MESSAGES, type Messages } from "./messages";

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

/** The interface text in this browser's language, for server components. */
export async function getMessages(): Promise<Messages> {
  return MESSAGES[await getLocale()];
}

/** "Live courts · Pickleball Social Manager", in this browser's language. */
export async function hostPageTitle(
  page: keyof Messages["host"]["titles"],
): Promise<string> {
  const messages = await getMessages();
  return `${messages.host.titles[page]} · ${messages.appName}`;
}
