"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  LOCALE_COOKIE_NAME,
  type Locale,
} from "./locales";
import { MESSAGES, type Messages } from "./messages";

interface LocaleContextValue {
  locale: Locale;
  messages: Messages;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/** Saves the choice in this browser only (no sign-in, no server write). */
function saveLocaleCookie(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/**
 * Gives client components the chosen language. `initialLocale` comes from the
 * server (cookie or Accept-Language), so the first paint is already right.
 * Switching saves the cookie and re-renders here at once; state held in
 * client components (typed fields) is kept. The switch also refreshes server
 * components.
 */
export function LocaleProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState(initialLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((next: Locale) => {
    saveLocaleCookie(next);
    setLocaleState(next);
  }, []);
  const value = useMemo(
    () => ({ locale, messages: MESSAGES[locale], setLocale }),
    [locale, setLocale],
  );
  return (
    <LocaleContext value={value}>
      {/* `lang` here is right from the first paint; Vietnamese text uses a font with its tone marks. */}
      <div
        lang={locale}
        className={`contents ${locale === "vi" ? "font-vietnamese" : ""}`}
      >
        {children}
      </div>
    </LocaleContext>
  );
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale needs a LocaleProvider above it.");
  return value;
}

export function useMessages(): Messages {
  return useLocale().messages;
}
