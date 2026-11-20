import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  adminClient,
  deleteCreatedLogins,
  signInAsNewManager,
  useRandomClientIp,
  // Not a React hook (a Playwright helper): renamed for the hooks lint rule.
  useRandomClientIp as giveRandomClientIp,
} from "./support/localHostSession";

// The compact phone layout (docs/plans/mobile-compact-ui.md) at 390 px:
// nothing scrolls sideways and everything tappable answers a 44px finger.
// Set PHONE_SCREENSHOT_DIR to also save a screenshot of each step.
const PHONE_WIDTH = 390;
test.use({ viewport: { width: PHONE_WIDTH, height: 844 } });
test.afterAll(deleteCreatedLogins);

const SCREENSHOT_DIR = process.env.PHONE_SCREENSHOT_DIR;

async function capture(page: Page, name: string, fullPage = true) {
  if (!SCREENSHOT_DIR) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage,
  });
}

/** No sideways scroll, and no visible control with a tap area under 44px. */
async function expectPhoneFriendly(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(PHONE_WIDTH);
  const smallTargets = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "a[href], button, select, input:not([type=hidden]), summary",
      ),
    ]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        // Hidden, or visually hidden (sr-only).
        if (box.width <= 1 || box.height <= 1) return false;
        const after = getComputedStyle(element, "::after");
        const tapHeight = Math.max(
          box.height,
          after.position === "absolute" ? parseFloat(after.height) || 0 : 0,
        );
        return tapHeight < 43.5;
      })
      .map((element) => element.outerHTML.slice(0, 160)),
  );
  expect(smallTargets).toEqual([]);
}

async function checkInFromAPhone(
  browser: Browser,
  checkinTag: string,
  firstName: string,
) {
  const context = await browser.newContext({
    viewport: { width: PHONE_WIDTH, height: 844 },
  });
  const phone = await context.newPage();
  await giveRandomClientIp(phone);
  await phone.goto(`/t/${checkinTag}`);
  await phone.getByRole("button", { name: "Female", exact: true }).click();
  await phone.getByRole("textbox", { name: "First name" }).fill(firstName);
  await phone.getByRole("textbox", { name: "Last name" }).fill("Tran");
  await phone
    .getByRole("group", { name: "Your level" })
    .getByRole("button", { name: "Beginner" })
    .click();
  await phone.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(
    phone.getByRole("heading", { name: "Waiting for the host to approve" }),
  ).toBeVisible();
  await context.close();
}

test("the host screens fit a 390 px phone in both languages", async ({
  page,
  browser,
}, testInfo) => {
  // The mobile project runs it already at phone width.
  test.skip(testInfo.project.name !== "mobile", "phone-only layout");
  test.setTimeout(120_000);
  await useRandomClientIp(page);
  const { socialId } = await signInAsNewManager(page, "phone-layout");

  // Setup.
  await page.getByRole("button", { name: "Start a new session" }).click();
  await page.getByLabel("Session name").fill("Friday social");
  await page.getByLabel("Court count").fill("2");
  await page.getByLabel("Session duration (minutes)").fill("90");
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Saved");
  const playerForm = page.getByRole("form", { name: "Add a player" });
  for (const [firstName, lastName] of [
    ["Kea", "Mac"],
    ["Wee", "Long"],
    ["Nguyen", "Wee"],
    ["Jack", "Welong"],
    ["Ryan", "Haa"],
    ["Bartholomew", "Featherstonehaugh"],
  ]) {
    await playerForm.getByLabel("First name").fill(firstName);
    await playerForm.getByLabel("Last name").fill(lastName);
    await playerForm.getByLabel("Gender", { exact: true }).selectOption("male");
    await playerForm
      .getByLabel("Skill", { exact: true })
      .selectOption("intermediate");
    await playerForm
      .getByRole("button", { name: "Add player", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: `Remove ${firstName} ${lastName}` }),
    ).toBeEnabled();
  }
  await expectPhoneFriendly(page);
  await capture(page, "01-setup");
  await page.getByRole("button", { name: "Tiếng Việt" }).click();
  await expect(
    page.getByRole("button", { name: "Bắt đầu buổi chơi", exact: true }),
  ).toBeVisible();
  await expectPhoneFriendly(page);
  await capture(page, "01b-setup-vietnamese");
  await page.getByRole("button", { name: "English" }).click();

  // The ☰ menu holds the host nav and Sign out.
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expectPhoneFriendly(page);
  await capture(page, "02-menu", false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();

  // Live: courts come first on phones.
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Start Friday social?" })
    .getByRole("button", { name: "Confirm start" })
    .click();
  await expect(page).toHaveURL(/\/live$/);
  const court1 = page.getByRole("article", { name: "Court 1", exact: true });
  await expect(
    court1.getByRole("heading", { name: "Ready to start" }),
  ).toBeVisible();
  const courtsTop = (await page
    .getByRole("heading", { name: "Courts & Up next" })
    .boundingBox())!.y;
  const waitingTop = (await page
    .getByRole("region", { name: /^Waiting/ })
    .boundingBox())!.y;
  const checkinsTop = (await page
    .getByRole("region", { name: /^Check-ins waiting/ })
    .boundingBox())!.y;
  expect(courtsTop).toBeLessThan(waitingTop);
  expect(waitingTop).toBeLessThan(checkinsTop);
  await expect(
    page
      .getByRole("navigation", { name: "Live sections" })
      .getByRole("link", { name: "Waiting 6" }),
  ).toBeVisible();
  await expectPhoneFriendly(page);
  await capture(page, "03-live-ready");

  // A player checks in from their phone: the Check-ins link counts them.
  const { data: social, error } = await adminClient
    .from("socials")
    .select("checkin_tag")
    .eq("id", socialId)
    .single();
  if (error) throw error;
  await checkInFromAPhone(browser, social.checkin_tag, "Linh");
  await expect(
    page
      .getByRole("navigation", { name: "Live sections" })
      .getByRole("link", { name: "Check-ins 1" }),
  ).toBeVisible({ timeout: 15_000 });
  await expectPhoneFriendly(page);
  await capture(page, "04-live-checkin");

  // A game in progress, and a resting player.
  await court1.getByRole("button", { name: "Start game" }).click();
  await expect(court1.getByText(/^Playing · \d+ min$/)).toBeVisible();
  // Which four were called varies: rest whoever waits first.
  await page
    .getByRole("region", { name: /^Waiting/ })
    .getByRole("button", { name: /^Rest / })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: /^Ready now / }).first(),
  ).toBeVisible();
  await court1.getByText("Court options").click();
  await expectPhoneFriendly(page);
  await capture(page, "05-live-playing");

  // The + opens Add player as a sheet.
  await page.getByRole("button", { name: "Add player", exact: true }).click();
  const sheet = page.getByRole("form", { name: "Add player" });
  await expect(sheet.getByLabel("First name")).toBeFocused();
  await expectPhoneFriendly(page);
  await capture(page, "06-add-player-sheet", false);
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();

  // Vietnamese.
  await page.getByRole("button", { name: "Tiếng Việt" }).click();
  await expect(page.getByRole("article", { name: "Sân 1" })).toBeVisible();
  await expectPhoneFriendly(page);
  await capture(page, "07-live-vietnamese");
  await page.getByRole("button", { name: "English" }).click();

  // Ending: the confirmation dialog.
  await court1.getByRole("button", { name: "Game finished" }).click();
  await page.getByRole("button", { name: "End session" }).first().click();
  await expect(
    page.getByRole("dialog", { name: "End this session?" }),
  ).toBeVisible();
  await capture(page, "08-end-dialog", false);
  await page.getByRole("button", { name: "Keep session open" }).click();

  // The other host pages.
  await page.goto("/hosts");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectPhoneFriendly(page);
  await capture(page, "09-hosts");
  await page.goto("/checkin-link");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectPhoneFriendly(page);
  await capture(page, "10-sticker-and-qr");
});
