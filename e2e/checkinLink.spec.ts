// The Sticker and QR page and issuing a new check-in link (M5 increment 4)
// against the LOCAL Supabase stack: an operational host opens "Show QR code"
// from the Setup tray and sees the link and QR code, opens and closes the
// full-screen QR (Esc), and prints 12 stickers; the operational host sees no
// "Issue new link" on Hosts; a manager cancels the dialog (nothing changes),
// then issues a new link: the old /t/<tag> is inactive at once and the new
// one opens the check-in page. At 390 px the page never scrolls sideways.
// Each test has its own social; everything is removed after.
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
  await deleteCreatedLogins();
});

test.beforeEach(() => {
  test.skip(
    test.info().project.name !== "chromium",
    "runs once: it opens its own desktop and phone contexts",
  );
});

interface TestSocial {
  socialId: string;
  socialName: string;
  managerEmail: string;
  hostEmail: string;
}

/** A social with an operational host and a manager. */
async function createSocialWithHosts(label: string): Promise<TestSocial> {
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
  return { socialId, socialName, managerEmail, hostEmail };
}

async function checkinTagOf(socialId: string): Promise<string> {
  const { data, error } = await adminClient
    .from("socials")
    .select("checkin_tag")
    .eq("id", socialId)
    .single();
  if (error) throw error;
  return data.checkin_tag;
}

async function signedInPage(
  browser: Browser,
  email: string,
  viewport = { width: 1280, height: 900 },
): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await giveRandomClientIp(page);
  await signIn(page, email);
  return page;
}

async function expectNoHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

test("a host opens Show QR code from the tray, goes full screen and prints 12 stickers", async ({
  browser,
}) => {
  const social = await createSocialWithHosts("qr");
  const checkinTag = await checkinTagOf(social.socialId);
  const page = await signedInPage(browser, social.hostEmail);

  await page.getByRole("button", { name: "Start a new session" }).click();
  await page.getByRole("link", { name: "Show QR code" }).click();
  await page.waitForURL("**/checkin-link");

  await expect(
    page.getByRole("heading", { name: "Sticker and QR", level: 1 }),
  ).toBeVisible();
  const link = `http://localhost:3000/t/${checkinTag}`;
  await expect(page.getByRole("textbox", { name: "Link" })).toHaveValue(link);
  await expect(
    page.getByRole("img", {
      name: `QR code for the check-in link localhost:3000/t/${checkinTag}`,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(`Scan to check in · localhost:3000/t/${checkinTag}`),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show full screen" }).click();
  const fullScreen = page.getByRole("dialog", { name: "Scan to check in" });
  await expect(fullScreen).toBeVisible();
  await expect(
    fullScreen.getByRole("button", { name: "Close full screen" }),
  ).toBeFocused();
  await expect(fullScreen.getByText(social.socialName)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(fullScreen).toBeHidden();
  await page.getByRole("button", { name: "Show full screen" }).click();
  await fullScreen.getByRole("button", { name: "Close full screen" }).click();
  await expect(fullScreen).toBeHidden();

  await page.getByRole("link", { name: "Print stickers" }).click();
  await page.waitForURL("**/checkin-link/print");
  const stickers = page
    .getByRole("list", { name: "Stickers" })
    .getByRole("listitem");
  await expect(stickers).toHaveCount(12);
  for (const sticker of await stickers.all()) {
    await expect(sticker).toContainText(social.socialName);
    await expect(sticker).toContainText("Scan to check in");
    await expect(sticker).toContainText(`localhost:3000/t/${checkinTag}`);
  }
  await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
  await page.getByRole("link", { name: "Back" }).click();
  await page.waitForURL("**/checkin-link");

  // Operational hosts see the link on Hosts, but can't issue a new one.
  await page.goto("/hosts");
  await expect(
    page.getByRole("heading", { name: "Check-in link" }),
  ).toBeVisible();
  await expect(
    page.getByText(`localhost:3000/t/${checkinTag}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Sticker and QR" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Issue new link" }),
  ).toHaveCount(0);
});

test("a manager issues a new link: Cancel changes nothing, then the old link stops working", async ({
  browser,
}) => {
  const social = await createSocialWithHosts("reissue");
  const oldTag = await checkinTagOf(social.socialId);
  const page = await signedInPage(browser, social.managerEmail);
  await page.goto("/hosts");

  const trigger = page.getByRole("button", { name: "Issue new link" });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Issue a new check-in link?",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await checkinTagOf(social.socialId)).toBe(oldTag);

  await trigger.click();
  await dialog.getByRole("button", { name: "Issue new link" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText(
      "New link issued. The old link, QR code and stickers no longer work.",
    ),
  ).toBeVisible();
  const newTag = await checkinTagOf(social.socialId);
  expect(newTag).not.toBe(oldTag);
  await expect(
    page.getByText(`localhost:3000/t/${newTag}`, { exact: true }),
  ).toBeVisible();

  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const phone = await phoneContext.newPage();
  await giveRandomClientIp(phone);
  await phone.goto(`/t/${oldTag}`);
  await expect(
    phone.getByRole("heading", { name: "This check-in link isn't active" }),
  ).toBeVisible();
  await phone.goto(`/t/${newTag}`);
  await expect(
    phone.getByRole("heading", { name: "No social open right now" }),
  ).toBeVisible();
});

test("the Sticker and QR page never scrolls sideways at 390 px", async ({
  browser,
}) => {
  const social = await createSocialWithHosts("qr-390");
  const page = await signedInPage(browser, social.hostEmail, {
    width: 390,
    height: 844,
  });
  await page.goto("/checkin-link");
  await expect(page.getByRole("textbox", { name: "Link" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByRole("button", { name: "Show full screen" }).click();
  await expect(
    page.getByRole("dialog", { name: "Scan to check in" }),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.keyboard.press("Escape");

  await page.goto("/checkin-link/print");
  await expect(
    page.getByRole("list", { name: "Stickers" }).getByRole("listitem"),
  ).toHaveCount(12);
  // The A4 sheet scrolls inside its own box; the page itself doesn't.
  await expectNoHorizontalScroll(page);
});
