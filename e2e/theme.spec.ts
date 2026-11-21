import { expect, test, type Page } from "@playwright/test";
import {
  adminClient,
  deleteCreatedLogins,
  signInAsNewManager,
} from "./support/localHostSession";

// Light mode (docs/plans/light-mode.md): light by default, a host can choose
// dark (remembered on this device, no light flash on reload), and the player
// check-in page is always light.
test.afterAll(deleteCreatedLogins);

const LIGHT_PAGE_BACKGROUND = "rgb(238, 241, 244)";
const DARK_PAGE_BACKGROUND = "rgb(15, 20, 25)";

async function pageBackground(page: Page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test("light by default; dark is remembered and never flashes light; the player page stays light", async ({
  page,
}) => {
  const { socialId } = await signInAsNewManager(page, "Theme");
  await page.goto("/setup");
  expect(await pageBackground(page)).toBe(LIGHT_PAGE_BACKGROUND);

  const darkMode = page.getByRole("button", { name: "Dark mode" });
  await expect(darkMode).toHaveAttribute("aria-pressed", "false");
  await darkMode.click();
  await expect(darkMode).toHaveAttribute("aria-pressed", "true");
  expect(await pageBackground(page)).toBe(DARK_PAGE_BACKGROUND);

  // The boot script runs in <head>: dark before anything is painted.
  await page.reload({ waitUntil: "commit" });
  await page.waitForFunction(() => document.body !== null);
  expect(await pageBackground(page)).toBe(DARK_PAGE_BACKGROUND);
  await expect(darkMode).toHaveAttribute("aria-pressed", "true");

  const { data: social } = await adminClient
    .from("socials")
    .select("checkin_tag")
    .eq("id", socialId)
    .single();
  await page.goto(`/t/${social!.checkin_tag}`);
  expect(await pageBackground(page)).toBe(LIGHT_PAGE_BACKGROUND);
  await expect(page.getByRole("button", { name: "Dark mode" })).toHaveCount(0);

  await page.goto("/setup");
  await page.getByRole("button", { name: "Dark mode" }).click();
  expect(await pageBackground(page)).toBe(LIGHT_PAGE_BACKGROUND);
});
