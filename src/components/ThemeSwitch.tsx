"use client";

import { useSyncExternalStore } from "react";
import { useMessages } from "@/i18n/LocaleProvider";
import { THEME_CHANGE_EVENT, THEME_STORAGE_KEY } from "./themeScript";

type Theme = "light" | "dark";

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function chooseTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private window): the choice lasts for this page only.
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/**
 * Dark mode on/off for the host screens (docs/plans/light-mode.md). Light is
 * the default; this device remembers the choice. One 44px pressable button;
 * `compactBelowDesktop` (host header) draws it 32px below 1024px with a 44px
 * tap area, matching EN | VN.
 */
export function ThemeSwitch({
  compactBelowDesktop = false,
}: {
  compactBelowDesktop?: boolean;
}) {
  const text = useMessages().themeSwitch;
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light");
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      aria-label={text.darkMode}
      aria-pressed={isDark}
      onClick={() => chooseTheme(isDark ? "light" : "dark")}
      className={`flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-inner-border bg-inner text-text ${
        compactBelowDesktop
          ? "compact:tap-area-44 compact:size-8 compact:rounded-[10px]"
          : ""
      }`}
    >
      <svg
        aria-hidden="true"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={compactBelowDesktop ? "compact:size-4" : ""}
      >
        {isDark ? (
          // Sun: press to go back to light.
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          // Moon: press for dark.
          <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
        )}
      </svg>
    </button>
  );
}
