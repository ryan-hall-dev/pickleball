"use client";

import { useRouter } from "next/navigation";
import { useLocale } from "@/i18n/LocaleProvider";
import { LOCALES, type Locale } from "@/i18n/locales";

const LOCALE_NAMES: Record<Locale, { short: string; full: string }> = {
  en: { short: "EN", full: "English" },
  vi: { short: "VN", full: "Tiếng Việt" },
};

/**
 * EN | VN (the label most Vietnamese sites use; the language code stays `vi`): two 44px pressable buttons; each names its language in that language.
 * `compactBelowDesktop` (host header): drawn 32px high below 1024px, still a 44px tap area.
 */
export function LanguageSwitch({
  compactBelowDesktop = false,
}: {
  compactBelowDesktop?: boolean;
}) {
  const { locale, messages, setLocale } = useLocale();
  const router = useRouter();
  return (
    <div
      role="group"
      aria-label={messages.languageSwitch.label}
      className={`inline-flex shrink-0 rounded-[14px] border border-inner-border bg-inner p-0.5 ${compactBelowDesktop ? "compact:rounded-[10px]" : ""}`}
    >
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          aria-label={LOCALE_NAMES[option].full}
          aria-pressed={locale === option}
          onClick={() => {
            if (option === locale) return;
            setLocale(option);
            // Server-rendered text follows on the next render.
            router.refresh();
          }}
          className={`h-11 min-w-11 rounded-xl px-3 text-sm font-bold ${
            locale === option ? "bg-text text-bg" : "text-muted"
          } ${compactBelowDesktop ? "compact:tap-area-44 compact:h-8 compact:rounded-lg compact:px-2 compact:text-xs" : ""}`}
        >
          {LOCALE_NAMES[option].short}
        </button>
      ))}
    </div>
  );
}
