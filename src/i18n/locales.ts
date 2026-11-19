// Pure locale rules shared by the server (first render) and the browser (the
// switch). No server-only or React imports.

export const LOCALES = ["en", "vi"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** The browser's own choice: no personal data, no sign-in, one year. */
export const LOCALE_COOKIE_NAME = "pickleball_locale";
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Formatting locales for dates and times (24-hour clock in both). */
export const INTL_LOCALES: Record<Locale, string> = {
  en: "en-GB",
  vi: "vi-VN",
};

export function isLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale);
}

/**
 * The supported language the browser ranks highest in Accept-Language
 * ("vi-VN,vi;q=0.9,en;q=0.8" is Vietnamese), English when it names neither.
 */
export function localeFromAcceptLanguage(
  acceptLanguage: string | null | undefined,
): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .map((entry, position) => {
      const [tag, ...parameters] = entry.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="));
      const weight = quality ? Number(quality.slice(2)) : 1;
      return {
        language: tag.trim().toLowerCase().split("-")[0],
        weight: Number.isFinite(weight) ? weight : 0,
        position,
      };
    })
    .filter((entry) => entry.weight > 0 && isLocale(entry.language))
    .sort(
      (left, right) =>
        right.weight - left.weight || left.position - right.position,
    );
  return (ranked[0]?.language as Locale | undefined) ?? DEFAULT_LOCALE;
}

/** A saved choice wins; a first visit follows the browser's languages. */
export function pickLocale(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  return isLocale(cookieValue)
    ? cookieValue
    : localeFromAcceptLanguage(acceptLanguage);
}
