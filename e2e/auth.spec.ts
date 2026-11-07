// Host authentication against the LOCAL Supabase stack (`pnpm db:start`).
// Sign-in codes are read from Mailpit, the local stack's email inbox.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/database.types";

const SEEDED_ADMIN_EMAIL = "host@example.test";
const CODE_EMAIL_TIMEOUT_MS = 15_000;

interface LocalStack {
  apiUrl: string;
  mailpitUrl: string;
  secretKey: string;
}

function readLocalStack(): LocalStack {
  const output = execFileSync(
    "node_modules/.bin/supabase",
    ["status", "-o", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 },
  );
  const status = JSON.parse(output.slice(output.indexOf("{"))) as Record<
    string,
    string
  >;
  if (!["127.0.0.1", "localhost"].includes(new URL(status.API_URL).hostname)) {
    throw new Error("The auth e2e tests only run against the local stack.");
  }
  return {
    apiUrl: status.API_URL,
    mailpitUrl: status.MAILPIT_URL ?? "http://127.0.0.1:54324",
    secretKey: status.SECRET_KEY,
  };
}

const localStack = readLocalStack();
const adminClient: SupabaseClient<Database> = createClient<Database>(
  localStack.apiUrl,
  localStack.secretKey,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const createdUserIds: string[] = [];

function uniqueEmail(label: string): string {
  return `e2e-${label}-${randomUUID().slice(0, 8)}@example.test`;
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  const { data, error } = await adminClient.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error) throw error;
  return data.users.find((user) => user.email === email)?.id ?? null;
}

async function createLogin(email: string): Promise<string> {
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) throw error;
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function addHostRow(
  userId: string,
  displayName: string,
  role: "admin" | "host",
) {
  const { error } = await adminClient
    .from("hosts")
    .upsert(
      { user_id: userId, display_name: displayName, role },
      { onConflict: "user_id" },
    );
  if (error) throw error;
}

function mailpitSearchUrl(email: string): string {
  return `${localStack.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`;
}

async function readNewestSignInCode(email: string): Promise<string> {
  let signInCode: string | null = null;
  await expect
    .poll(
      async () => {
        const search = (await (
          await fetch(mailpitSearchUrl(email))
        ).json()) as {
          messages: { ID: string }[];
        };
        const newest = search.messages[0];
        if (!newest) return null;
        const message = (await (
          await fetch(`${localStack.mailpitUrl}/api/v1/message/${newest.ID}`)
        ).json()) as { Text: string };
        signInCode = /\b(\d{6})\b/.exec(message.Text)?.[1] ?? null;
        return signInCode;
      },
      { timeout: CODE_EMAIL_TIMEOUT_MS, message: `sign-in code for ${email}` },
    )
    .not.toBeNull();
  return signInCode!;
}

async function requestCode(page: Page, email: string) {
  // Old emails would hold stale codes.
  await fetch(mailpitSearchUrl(email), { method: "DELETE" });
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
}

async function signIn(page: Page, email: string) {
  await requestCode(page, email);
  await page.getByLabel("6-digit code").fill(await readNewestSignInCode(email));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
}

// Each test signs in from its own client IP so the app's per-IP sign-in
// throttle (20 attempts / 10 min) doesn't trip across the suite. Locally,
// `next start` keeps an incoming x-forwarded-for (Vercel overwrites it).
test.beforeEach(async ({ page }) => {
  const randomOctets = Array.from(
    randomUUID().replace(/-/g, "").slice(0, 6).match(/../g)!,
    (hex) => parseInt(hex, 16),
  );
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.${randomOctets.join(".")}`,
  });
});

test.afterAll(async () => {
  for (const userId of createdUserIds.splice(0)) {
    const { error } = await adminClient.auth.admin.deleteUser(userId);
    // e.g. the database refuses to delete its last admin.
    if (error)
      console.warn(`Couldn't delete e2e user ${userId}: ${error.message}`);
  }
});

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

  await expect(page.getByRole("heading", { name: /^Welcome,/ })).toBeVisible();
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
  createdUserIds.push(inviteeUserId!);

  // Inviting the same person again is refused.
  await page.getByLabel("Email").fill(inviteeEmail);
  await page.getByLabel("Display name").fill(inviteeName);
  await page.getByRole("button", { name: "Invite host" }).click();
  await expect(page.getByText("That person is already a host.")).toBeVisible();
  await signOut(page);

  await signIn(page, inviteeEmail);
  await expect(
    page.getByRole("heading", { name: `Welcome, ${inviteeName}` }),
  ).toBeVisible();
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
