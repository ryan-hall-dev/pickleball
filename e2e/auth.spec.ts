// Host authentication against the LOCAL Supabase stack (`pnpm db:start`).
// Sign-in codes are read from Mailpit, the local stack's email inbox.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  addHostRow,
  createLogin,
  deleteCreatedLogins,
  findUserIdByEmail,
  mailpitSearchUrl,
  readNewestSignInCode,
  requestCode,
  signIn,
  signOut,
  trackCreatedLogin,
  uniqueEmail,
  useRandomClientIp,
} from "./support/localHostSession";

const SEEDED_ADMIN_EMAIL = "host@example.test";

test.beforeEach(async ({ page }) => {
  await useRandomClientIp(page);
});

test.afterAll(deleteCreatedLogins);

test("signed-out visitors are sent to the login page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/hosts");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Host sign in" }),
  ).toBeVisible();
});

test("the public check-in path is not gated by login", async ({ page }) => {
  await page.goto("/t/some-sticker-tag-1234");
  await expect(page).toHaveURL(/\/t\/some-sticker-tag-1234$/);
});

test("the seeded admin signs in with an emailed code", async ({
  page,
}, testInfo) => {
  // One project only: parallel code requests for the same email replace each other's codes.
  test.skip(testInfo.project.name !== "chromium", "runs once, on desktop");
  const seededAdminId = await findUserIdByEmail(SEEDED_ADMIN_EMAIL);
  test.skip(!seededAdminId, "run `pnpm seed` to create the local admin");

  await signIn(page, SEEDED_ADMIN_EMAIL);

  await expect(
    page.getByRole("heading", { name: "Set up a session" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Hosts", exact: true }).first().click();
  await expect(
    page.getByRole("heading", { name: "Invite a host" }),
  ).toBeVisible();
  await signOut(page);
  await page.goto("/hosts");
  await expect(page).toHaveURL(/\/login$/);
});

test("a wrong code shows a clear error", async ({ page }) => {
  const email = uniqueEmail("wrong-code");
  await createLogin(email);

  await requestCode(page, email);
  const realCode = await readNewestSignInCode(email);
  const wrongCode = realCode === "000000" ? "111111" : "000000";
  await page.getByLabel("6-digit code").fill(wrongCode);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText(/wrong or has expired/)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("an uninvited email gets the same response and no email", async ({
  page,
}) => {
  const email = uniqueEmail("uninvited");

  await requestCode(page, email);

  const search = (await (await fetch(mailpitSearchUrl(email))).json()) as {
    messages: unknown[];
  };
  expect(search.messages).toHaveLength(0);
  expect(await findUserIdByEmail(email)).toBeNull();
});

test("a signed-in non-host is told to ask for an invite", async ({ page }) => {
  const email = uniqueEmail("non-host");
  await createLogin(email);

  await signIn(page, email);

  await expect(
    page.getByRole("heading", { name: "You're not a host here" }),
  ).toBeVisible();
  await expect(page.getByText("Ask an admin for an invite.")).toBeVisible();
  await page.goto("/hosts");
  await expect(
    page.getByRole("heading", { name: "You're not a host here" }),
  ).toBeVisible();
  await signOut(page);
});

test("an admin invites a host, who can then sign in, and removes them", async ({
  page,
}) => {
  const adminEmail = uniqueEmail("admin");
  await addHostRow(await createLogin(adminEmail), "E2E Admin", "admin");
  const inviteeEmail = uniqueEmail("invitee");
  const inviteeName = `Invitee ${randomUUID().slice(0, 6)}`;

  await signIn(page, adminEmail);
  await page.goto("/hosts");
  // An admin can't remove themselves.
  await expect(
    page.getByRole("button", { name: "Remove E2E Admin" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Invite host" }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();

  await page.getByLabel("Email").fill(inviteeEmail.toUpperCase());
  await page.getByLabel("Display name").fill(inviteeName);
  await page.getByRole("button", { name: "Invite host" }).click();
  await expect(page.getByText(`${inviteeName} is now a host.`)).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: inviteeName }),
  ).toBeVisible();
  const inviteeUserId = await findUserIdByEmail(inviteeEmail);
  expect(inviteeUserId).not.toBeNull();
  trackCreatedLogin(inviteeUserId!);

  // Inviting the same person again is refused.
  await page.getByLabel("Email").fill(inviteeEmail);
  await page.getByLabel("Display name").fill(inviteeName);
  await page.getByRole("button", { name: "Invite host" }).click();
  await expect(page.getByText("That person is already a host.")).toBeVisible();
  await signOut(page);

  await signIn(page, inviteeEmail);
  await expect(page.getByRole("banner")).toContainText(`Host · ${inviteeName}`);
  await page.goto("/hosts");
  await expect(
    page.getByText("Only admins can invite or remove hosts."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await signOut(page);

  await signIn(page, adminEmail);
  await page.goto("/hosts");
  await page.getByRole("button", { name: `Remove ${inviteeName}` }).click();
  await page
    .getByRole("button", { name: `Confirm remove ${inviteeName}` })
    .click();
  await expect(
    page.getByRole("listitem").filter({ hasText: inviteeName }),
  ).toHaveCount(0);
  await expect.poll(() => findUserIdByEmail(inviteeEmail)).toBeNull();
});

test("code requests are throttled per email, the same for uninvited emails", async ({
  page,
}) => {
  // Uninvited, so this also shows the throttle doesn't reveal who is invited.
  const email = uniqueEmail("throttled");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await requestCode(page, email);
  }
  await page.getByRole("button", { name: "Use a different email" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();

  await expect(page.getByText(/Too many sign-in attempts/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Host sign in" }),
  ).toBeVisible();
});
