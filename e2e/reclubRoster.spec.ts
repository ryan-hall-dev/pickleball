// Reclub roster to arrival (docs/plans/reclub-to-court-v1.md, Phase 1) at
// 390 px against the LOCAL Supabase stack: the host pastes the Reclub list on
// Arrivals; a player finds their numbered name and is straight in; a second
// phone asks "That's my name" and the host moves it; the host checks in a
// player with no phone; closed walk-ins turn away "My name isn't here".
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

/** Pages poll every 5 s; allow two polls. */
const POLL_TIMEOUT_MS = 12_000;

const RECLUB_PASTE = `🏓 Thursday Social
📅 Thu 27 Nov · 18:30
Confirmed (6/16)
1. An Vo
2. Duy Ha (+1)
3. Minh Nguyen
4. Minh Nguyen
5. Sunny (Host)
6. Lan Dinh

Waitlist (1)
1. Oscar Bell`;

async function newPhone(browser: Browser, checkinTag: string): Promise<Page> {
  // Each phone is its own network, as in checkin.spec.ts.
  const octets = randomUUID().replace(/-/g, "").slice(0, 6).match(/../g)!;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: {
      "x-forwarded-for": `10.${octets.map((hex) => parseInt(hex, 16)).join(".")}`,
    },
  });
  const phone = await context.newPage();
  await phone.goto(`/t/${checkinTag}`);
  await expect(
    phone.getByRole("heading", { name: "Find your name" }),
  ).toBeVisible();
  return phone;
}

async function searchFor(phone: Page, query: string) {
  await phone.getByLabel("Your name").fill(query);
  await expect(
    phone.getByRole("list", { name: "Matching names" }),
  ).toBeVisible();
}

test("a host pastes the Reclub list and listed players check themselves in", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one phone-width run");
  test.setTimeout(120_000);
  await useRandomClientIp(page);
  const { socialId } = await signInAsNewManager(page, "reclub-roster");
  await page.getByRole("button", { name: "Start a new session" }).click();
  await page.getByLabel("Session name").fill("Roster browser journey");
  await page.getByLabel("Court count").fill("2");
  await page.getByLabel("Session duration (minutes)").fill("120");
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Saved");
  const { data: social, error } = await adminClient
    .from("socials")
    .select("checkin_tag")
    .eq("id", socialId)
    .single();
  if (error) throw error;

  // Host: paste, check, add.
  await page.goto("/arrivals");
  await page.getByLabel("Reclub list").fill(RECLUB_PASTE);
  await page.getByRole("button", { name: "Check names" }).click();
  await expect(page.getByText("7 new names found")).toBeVisible();
  await expect(page.getByText("Guest of Duy Ha")).toBeVisible();
  await expect(page.getByText("Waitlist names left out: 1.")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("h2-preview.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Add 7 players" }).click();
  await expect(page.getByText("Added 7 players.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Not arrived (7)" }),
  ).toBeVisible();

  // Player 1 claims Minh Nguyen (1).
  const minh = await newPhone(browser, social.checkin_tag);
  await searchFor(minh, "minh");
  await minh.screenshot({
    path: testInfo.outputPath("p1-search.png"),
    fullPage: true,
  });
  await minh.getByRole("button", { name: "Minh Nguyen (1)" }).click();
  await expect(
    minh.getByRole("heading", { name: "Hi, Minh Nguyen (1)" }),
  ).toBeVisible();
  await minh.getByRole("button", { name: "Male", exact: true }).click();
  await minh.getByRole("button", { name: "Intermediate" }).click();
  await minh.getByRole("button", { name: "I'm here" }).click();
  await expect(
    minh.getByRole("heading", { name: "You're in, Minh" }),
  ).toBeVisible();

  // Player 2: Minh Nguyen (1) is in use; "That's my name" asks the host.
  const otherMinh = await newPhone(browser, social.checkin_tag);
  await searchFor(otherMinh, "minh");
  await expect(
    otherMinh.getByRole("button", { name: /Minh Nguyen \(1\)\s*In use/ }),
  ).toBeVisible();
  await otherMinh.getByRole("button", { name: /Minh Nguyen \(1\)/ }).click();
  await expect(
    otherMinh.getByRole("heading", { name: "This name is in use" }),
  ).toBeVisible();
  await otherMinh.getByRole("button", { name: "That's my name" }).click();
  await expect(
    otherMinh.getByRole("heading", { name: "Waiting for the host" }),
  ).toBeVisible();

  // Host moves it; the second phone is in, within a poll.
  const request = page.getByText("“That's my name”: Minh Nguyen (1)");
  await expect(request).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  await page.screenshot({
    path: testInfo.outputPath("h5-arrivals.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Move to new phone" }).click();
  await expect(
    otherMinh.getByRole("heading", { name: "You're in, Minh" }),
  ).toBeVisible({ timeout: POLL_TIMEOUT_MS });

  // Host checks in Lan Dinh, who has no phone.
  const lanRow = page.getByRole("listitem").filter({ hasText: "Lan Dinh" });
  await lanRow.getByRole("button", { name: "Check in" }).click();
  await lanRow.getByRole("button", { name: "Female" }).click();
  await lanRow.getByRole("button", { name: "Beginner" }).click();
  await lanRow.getByRole("button", { name: "Check in" }).click();
  await expect(
    page.getByRole("heading", { name: "Not arrived (5)" }),
  ).toBeVisible();
  await expect(page.getByText("2 of 7 arrived")).toBeVisible();

  // Walk-ins closed: "My name isn't here" is turned away.
  await page.getByRole("button", { name: "Close walk-ins" }).click();
  await expect(page.getByText("Walk-ins are closed")).toBeVisible();
  const walkIn = await newPhone(browser, social.checkin_tag);
  await walkIn.getByRole("button", { name: "My name isn't here" }).click();
  await expect(
    walkIn.getByRole("heading", { name: "Walk-ins are closed" }),
  ).toBeVisible();
});
