import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { LocaleProvider } from "./LocaleProvider";
import type { Locale } from "./locales";

/** Test helper: renders `ui` with the language a page would provide. */
export function withLocale(ui: ReactNode, locale: Locale = "en") {
  return <LocaleProvider initialLocale={locale}>{ui}</LocaleProvider>;
}

/** `render` inside a LocaleProvider that stays in place across `rerender`. */
export function renderWithLocale(
  ui: ReactElement,
  options: Omit<RenderOptions, "wrapper"> & { locale?: Locale } = {},
) {
  const { locale = "en", ...renderOptions } = options;
  return render(ui, {
    ...renderOptions,
    wrapper: ({ children }) => withLocale(children, locale),
  });
}
