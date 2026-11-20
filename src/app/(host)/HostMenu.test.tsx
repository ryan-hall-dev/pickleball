import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithLocale as render } from "@/i18n/testing";
import { HostMenu } from "./HostMenu";

let pathname = "/live";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

afterEach(() => {
  cleanup();
  pathname = "/live";
});

function renderMenu() {
  return render(
    <HostMenu>
      <a href="/setup">Session setup</a>
    </HostMenu>,
  );
}

it("opens and closes with the ☰ button and closes on Escape, returning focus", () => {
  renderMenu();
  const button = screen.getByRole("button", { name: "Menu" });
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("link", { name: "Session setup" })).toBeNull();

  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("link", { name: "Session setup" })).toBeVisible();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("link", { name: "Session setup" })).toBeNull();
  expect(button).toHaveFocus();
});

it("closes on a press outside it", () => {
  renderMenu();
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("link", { name: "Session setup" })).toBeNull();
});

it("closes when the page changes", () => {
  const { rerender } = renderMenu();
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  pathname = "/setup";
  rerender(
    <HostMenu>
      <a href="/setup">Session setup</a>
    </HostMenu>,
  );
  expect(screen.queryByRole("link", { name: "Session setup" })).toBeNull();
});

it("is labelled in Vietnamese too", () => {
  render(
    <HostMenu>
      <span />
    </HostMenu>,
    { locale: "vi" },
  );
  expect(screen.getByRole("button", { name: "Menu" })).toBeVisible();
});
