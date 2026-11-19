import type { ReactNode } from "react";
import { LocaleProvider } from "./LocaleProvider";
import type { Locale } from "./locales";

/** Test helper: renders `ui` with the language a page would provide. */
export function withLocale(ui: ReactNode, locale: Locale = "en") {
  return <LocaleProvider initialLocale={locale}>{ui}</LocaleProvider>;
}
