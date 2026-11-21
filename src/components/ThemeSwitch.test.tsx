import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderWithLocale as render } from "@/i18n/testing";
import { ThemeSwitch } from "./ThemeSwitch";
import { THEME_BOOT_SCRIPT, THEME_STORAGE_KEY } from "./themeScript";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function runBootScript() {
  new Function(THEME_BOOT_SCRIPT)();
}

it("starts light and switches to dark, saving the choice on this device", () => {
  render(<ThemeSwitch />);
  const button = screen.getByRole("button", { name: "Dark mode" });
  expect(button).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

  fireEvent.click(button);
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
});

it("is labelled in Vietnamese", () => {
  render(<ThemeSwitch />, { locale: "vi" });
  expect(screen.getByRole("button", { name: "Chế độ tối" })).toBeVisible();
});

it("boot script: light by default, dark when saved, always light on the player page", () => {
  runBootScript();
  expect(document.documentElement.dataset.theme).toBe("light");

  window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
  runBootScript();
  expect(document.documentElement.dataset.theme).toBe("dark");

  window.history.replaceState(null, "", "/t/some-tag");
  runBootScript();
  expect(document.documentElement.dataset.theme).toBe("light");
});
