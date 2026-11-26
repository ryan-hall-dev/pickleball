// The host pending check-in tray on Session setup (M5 increment 3) against
// the LOCAL Supabase stack, player to host: players check in on their own
// 390 px phones (/t/<tag>), the request shows in the hosts' trays within a
// poll, Approve puts the player in Who's playing for the approving host at
// once and for a second host without a reload (and the phone shows "You're
// in"), Reject shows the phone the neutral message, a second host acting on
// a request already decided is told so. Each test has its own social;
// everything is removed after.
//
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  addHostRow,
  adminClient,
  createLogin,
  createSocial,
  deleteCreatedLogins,
  signIn,
  uniqueEmail,
  uniqueSocialName,
  // Not a React hook (a Playwright helper): renamed for the hooks lint rule.
  useRandomClientIp as giveRandomClientIp,
} from "./support/localHostSession";

test.afterAll(async () => {
  // The socials go with their draft sessions (deleteTestSocials).
  await deleteCreatedLogins();
});

test.beforeEach(() => {
  test.skip(
    test.info().project.name !== "chromium",
    "runs once: it opens its own desktop and phone contexts",
  );
});

/** Trays and phones poll every 5 s; allow two polls. */
const POLL_TIMEOUT_MS = 12_000;

interface TestSocialWithHosts {
  socialName: string;
  managerEmail: string;
  hostEmail: string;
  socialId: string;
}

/** A social with a host and a manager (host first, so cleanup never leaves a host without a manager). */
async function createSocialWithHosts(
  label: string,
): Promise<TestSocialWithHosts> {
  const socialName = uniqueSocialName(label);
  const socialId = await createSocial(socialName);
  const hostEmail = uniqueEmail(`${label}-host`);
  await addHostRow(
    await createLogin(hostEmail),
    `E2E ${label} host`,
    "host",
    socialId,
  );
  const managerEmail = uniqueEmail(`${label}-manager`);
  await addHostRow(
    await createLogin(managerEmail),
    `E2E ${label} manager`,
    "manager",
    socialId,
  );
  return { socialName, managerEmail, hostEmail, socialId };
}

async function signedInHostPage(browser: Browser, email: string) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await giveRandomClientIp(page);
  await signIn(page, email);
  return page;
}

/** Starts the social's draft from Setup and returns its name and check-in tag. */
async function startDraft(page: Page, social: TestSocialWithHosts) {
  await page.getByRole("button", { name: "Start a new session" }).click();
  await expect(
    page.getByRole("heading", { name: "A simple start" }),
  ).toBeVisible();
  const sessionName = `E2E tray ${randomUUID().slice(0, 6)}`;
  await page.getByLabel("Session name").fill(sessionName);
  await page.getByLabel("Court count").fill("1");
  await expect(page.getByRole("main").getByRole("status").first()).toHaveText(
    "Saved",
  );
  const { data, error } = await adminClient
    .from("socials")
    .select("checkin_tag, sessions(id, status)")
    .eq("id", social.socialId)
    .single();
  if (error) throw error;
  const draft = data.sessions.find((session) => session.status === "draft");
  if (!draft) throw new Error("no draft session");
  return { sessionName, sessionId: draft.id, checkinTag: data.checkin_tag };
}

/** A new phone at 390 px on its own network, on the check-in page. */
async function newPhone(browser: Browser, checkinTag: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await context.newPage();
  await giveRandomClientIp(phone);
  await phone.goto(`/t/${checkinTag}`);
  return phone;
}

async function checkInAsPlayer(
  phone: Page,
  firstName: string,
  lastName: string,
  level: "Beginner" | "Intermediate" | "Advanced",
) {
  await phone.getByRole("button", { name: "Male", exact: true }).click();
  await phone.getByRole("textbox", { name: "First name" }).fill(firstName);
  await phone.getByRole("textbox", { name: "Last name" }).fill(lastName);
  await phone
    .getByRole("group", { name: "Your level" })
    .getByRole("button", { name: level })
    .click();
  await phone.getByRole("button", { name: "Check in", exact: true }).click();
  await expectWaiting(phone);
}

async function expectWaiting(phone: Page) {
  await expect(
    phone.getByRole("heading", { name: "Waiting for the host to approve" }),
  ).toBeVisible();
}

function tray(page: Page) {
  return page.getByRole("region", { name: /^Check-ins waiting/ });
}

/** The tray row naming `fullName`. */
function trayRow(page: Page, fullName: string) {
  return tray(page)
    .getByRole("listitem")
    .filter({ has: page.getByText(fullName, { exact: true }) });
}

function sessionPlayer(page: Page, fullName: string) {
  return page
    .getByRole("region", { name: "Who's playing?" })
    .getByRole("list", { name: "Players" })
    .getByRole("listitem")
    .filter({ has: page.getByText(fullName, { exact: true }) });
}

/** Stops the page's polling (it skips while hidden) so its rows go stale. */
async function pausePolling(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
  });
}

test("players check in, hosts approve and reject from the tray, and a second host keeps up", async ({
  browser,
}) => {
  // About 6 sequential 5 s polls (~28 s idle): too close to the 30 s default.
  test.slow();
  const social = await createSocialWithHosts("tray-approve");
  const managerPage = await signedInHostPage(browser, social.managerEmail);
  const draft = await startDraft(managerPage, social);
  const hostPage = await signedInHostPage(browser, social.hostEmail);
  await expect(
    hostPage.getByRole("heading", { name: "A simple start" }),
  ).toBeVisible();

  // Nothing waiting: Setup shows no check-ins box.
  await expect(tray(managerPage)).toHaveCount(0);

  // A player submits their required level: the row shows within a poll.
  const peterPhone = await newPhone(browser, draft.checkinTag);
  await checkInAsPlayer(peterPhone, "Peter", "Lindqvist", "Intermediate");
  const peterRow = trayRow(managerPage, "Peter Lindqvist");
  await expect(peterRow).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  await expect(peterRow).toContainText("Intermediate");
  await expect(
    tray(managerPage).getByRole("heading", { name: "Check-ins waiting (1)" }),
  ).toBeVisible();
  await expect(trayRow(hostPage, "Peter Lindqvist")).toBeVisible({
    timeout: POLL_TIMEOUT_MS,
  });

  // Approve: Who's playing at once here, the phone within a poll, and the
  // other host's Who's playing without a reload.
  await managerPage
    .getByRole("button", { name: "Approve Peter Lindqvist" })
    .click();
  await expect(peterRow).toContainText("Added to Who's playing");
  await expect(sessionPlayer(managerPage, "Peter Lindqvist")).toBeVisible();
  await expect(
    peterPhone.getByRole("heading", { name: "You're in, Peter" }),
  ).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  await expect(sessionPlayer(hostPage, "Peter Lindqvist")).toBeVisible({
    timeout: POLL_TIMEOUT_MS,
  });
  await expect(trayRow(hostPage, "Peter Lindqvist")).toHaveCount(0);
  // The decided row leaves after about 4 s.
  await expect(peterRow).toHaveCount(0, { timeout: 8_000 });

  // A new player: both trays list it; the second host's tray goes stale,
  // the manager approves, then the second host's Approve is told.
  const zoePhone = await newPhone(browser, draft.checkinTag);
  await checkInAsPlayer(zoePhone, "Zoe", "Park", "Beginner");
  await expect(trayRow(managerPage, "Zoe Park")).toContainText("Beginner", {
    timeout: POLL_TIMEOUT_MS,
  });
  await expect(trayRow(hostPage, "Zoe Park")).toBeVisible({
    timeout: POLL_TIMEOUT_MS,
  });
  await pausePolling(hostPage);
  await managerPage.getByRole("button", { name: "Approve Zoe Park" }).click();
  await expect(trayRow(managerPage, "Zoe Park")).toContainText(
    "Added to Who's playing",
  );
  await hostPage.getByRole("button", { name: "Approve Zoe Park" }).click();
  await expect(trayRow(hostPage, "Zoe Park")).toContainText(
    "Already decided by another host",
  );
  // The losing host's Who's playing shows the approved player too.
  await expect(sessionPlayer(hostPage, "Zoe Park")).toBeVisible();
  await expect(
    zoePhone.getByRole("heading", { name: "You're in, Zoe" }),
  ).toBeVisible({ timeout: POLL_TIMEOUT_MS });

  // Reject: the phone shows the neutral message.
  const kaiPhone = await newPhone(browser, draft.checkinTag);
  await checkInAsPlayer(kaiPhone, "Kai", "Moreno", "Advanced");
  await managerPage
    .getByRole("button", { name: "Reject Kai Moreno" })
    .click({ timeout: POLL_TIMEOUT_MS });
  await expect(trayRow(managerPage, "Kai Moreno")).toContainText(
    'Check-in rejected. The player sees "Please speak to the host".',
  );
  await expect(
    kaiPhone.getByRole("heading", { name: "Check-in not approved" }),
  ).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  await expect(sessionPlayer(managerPage, "Kai Moreno")).toHaveCount(0);
  const { data: requests, error } = await adminClient
    .from("checkin_requests")
    .select("first_name, status")
    .eq("session_id", draft.sessionId)
    .order("created_at");
  if (error) throw error;
  expect(requests).toEqual([
    { first_name: "Peter", status: "approved" },
    { first_name: "Zoe", status: "approved" },
    { first_name: "Kai", status: "rejected" },
  ]);
});
