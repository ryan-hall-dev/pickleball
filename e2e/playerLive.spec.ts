// A player's live page (docs/plans/reclub-to-court-v1.md, Phase 3) at 390 px
// against the LOCAL Supabase stack: four listed players check in on their
// phones, the host starts the social, the app asks the four for the free
// court, each confirms on their phone, all see Head to court, and one tap of
// Game started puts all four in the game.
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  adminClient,
  deleteCreatedLogins,
  signInAsNewManager,
  useRandomClientIp,
} from "./support/localHostSession";

test.use({ viewport: { width: 390, height: 844 } });
test.afterAll(async () => {
  await deleteCreatedLogins();
});

/** Phones poll every 5 s (15 s before the start); allow for both. */
const POLL_TIMEOUT_MS = 20_000;
const NAMES = ["An Vo", "Bao Truong", "Duy Ha", "Khoa Mai"];

async function phoneFor(browser: Browser, checkinTag: string, name: string) {
  const octets = randomUUID().replace(/-/g, "").slice(0, 6).match(/../g)!;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: {
      "x-forwarded-for": `10.${octets.map((hex) => parseInt(hex, 16)).join(".")}`,
    },
  });
  const phone = await context.newPage();
  await phone.goto(`/t/${checkinTag}`);
  await phone.getByLabel("Your name").fill(name.split(" ")[0]);
  await phone.getByRole("button", { name }).click();
  await phone.getByRole("button", { name: "Male", exact: true }).click();
  await phone.getByRole("button", { name: "Intermediate" }).click();
  await phone.getByRole("button", { name: "I'm here" }).click();
  await expect(
    phone.getByRole("heading", { name: `You're in, ${name.split(" ")[0]}` }),
  ).toBeVisible();
  return phone;
}

test("players confirm on their phones, head to court and start their own game", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one phone-width run");
  test.setTimeout(150_000);
  await useRandomClientIp(page);
  const { socialId } = await signInAsNewManager(page, "player-live");
  await page.getByRole("button", { name: "Start a new session" }).click();
  await page.getByLabel("Session name").fill("Player live journey");
  await page.getByLabel("Court count").fill("1");
  await page.getByLabel("Session duration (minutes)").fill("90");
  // The venue's own label, and the host's "ask the next four" minutes (h4).
  await page.getByLabel("Name of court 1").fill("Court 7");
  await page.getByRole("button", { name: "More minutes" }).click();
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Saved");
  const { data: social, error } = await adminClient
    .from("socials")
    .select("checkin_tag")
    .eq("id", socialId)
    .single();
  if (error) throw error;

  await page.goto("/arrivals");
  await page.getByLabel("Reclub list").fill(NAMES.join("\n"));
  await page.getByRole("button", { name: "Check names" }).click();
  await page.getByRole("button", { name: "Add 4 players" }).click();
  await expect(page.getByText("Added 4 players.")).toBeVisible();

  const phones: Page[] = [];
  for (const name of NAMES)
    phones.push(await phoneFor(browser, social.checkin_tag, name));

  await page.goto("/setup");
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Start Player live journey?" })
    .getByRole("button", { name: "Confirm start" })
    .click();
  await expect(page).toHaveURL(/\/live$/);
  const { data: started } = await adminClient
    .from("sessions")
    .select("config_snapshot")
    .eq("social_id", socialId)
    .eq("status", "live")
    .single();
  expect(started!.config_snapshot).toMatchObject({
    upNextAfterMinutes: 7,
    courts: [{ name: "Court 7" }],
  });

  for (const phone of phones) {
    await phone.reload();
    await expect(
      phone.getByRole("heading", { name: "You're up next on Court 7" }),
    ).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  }
  await phones[0].screenshot({
    path: testInfo.outputPath("p6-up-next.png"),
    fullPage: true,
  });
  for (const phone of phones.slice(0, 2))
    await phone.getByRole("button", { name: "I'm ready" }).click();
  // Host: the Up next group shows who has confirmed, with options per seat.
  await page.reload();
  await expect(page.getByText("2 of 4 confirmed")).toBeVisible();
  await expect(
    page.getByRole("group").or(page.locator("details")).first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("h7-host-confirmations.png"),
    fullPage: true,
  });
  for (const phone of phones.slice(2))
    await phone.getByRole("button", { name: "I'm ready" }).click();
  await expect(
    phones[0].getByRole("heading", { name: "Head to Court 7" }),
  ).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  await phones[0].screenshot({
    path: testInfo.outputPath("p9-head-to-court.png"),
    fullPage: true,
  });
  await phones[1].reload();
  await expect(
    phones[1].getByRole("heading", { name: "Head to Court 7" }),
  ).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  await phones[1].getByRole("button", { name: "Game started" }).click();
  await expect(phones[1].getByText(/^Playing · \d+ min$/)).toBeVisible();
  await expect(phones[3].getByText(/^Playing · \d+ min$/)).toBeVisible({
    timeout: POLL_TIMEOUT_MS,
  });
  await phones[3].screenshot({
    path: testInfo.outputPath("p16-playing.png"),
    fullPage: true,
  });

  // The host finishes; a phone adds the score; the host sees it (h13).
  await page.reload();
  await page.getByRole("button", { name: "Game finished" }).click();
  await expect(
    phones[3].getByText("Add the score for your last game"),
  ).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  const scoreInputs = phones[3].getByRole("textbox");
  await scoreInputs.nth(0).fill("11");
  await scoreInputs.nth(1).fill("8");
  await phones[3].screenshot({
    path: testInfo.outputPath("p16-score.png"),
    fullPage: true,
  });
  await phones[3].getByRole("button", { name: "Save score" }).click();
  await expect(phones[3].getByText("Already recorded")).toBeVisible({
    timeout: POLL_TIMEOUT_MS,
  });
  await page.reload();
  const recent = page.getByRole("region", { name: "Recent games" });
  await expect(recent.getByText(/^(11–8|8–11)$/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("h13-recent-games.png"),
    fullPage: true,
  });
});
