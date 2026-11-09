// Shared e2e helpers for signing hosts in against the LOCAL Supabase stack
// (`pnpm db:start`). Sign-in codes are read from Mailpit, the local inbox.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/lib/database.types";
import { deleteTestSocials } from "../../src/server/testing/deleteTestSocials";

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
    throw new Error("The e2e tests only run against the local stack.");
  }
  return {
    apiUrl: status.API_URL,
    mailpitUrl: status.MAILPIT_URL ?? "http://127.0.0.1:54324",
    secretKey: status.SECRET_KEY,
  };
}

const localStack = readLocalStack();

/** Secret-key client for test setup and cleanup only. */
export const adminClient: SupabaseClient<Database> = createClient<Database>(
  localStack.apiUrl,
  localStack.secretKey,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const createdUserIds: string[] = [];
const createdSocialIds: string[] = [];

/** Remembers a login so `deleteCreatedLogins` removes it after the tests. */
export function trackCreatedLogin(userId: string) {
  createdUserIds.push(userId);
}

/**
 * Deletes the tracked logins (and so their hosts rows), then their socials one
 * at a time with their courts and members. Delete sessions that reference a
 * social's members first.
 */
export async function deleteCreatedLogins() {
  for (const userId of createdUserIds.splice(0)) {
    const { error } = await adminClient.auth.admin.deleteUser(userId);
    // e.g. the database refuses to leave a social with hosts but no manager.
    if (error)
      console.warn(`Couldn't delete e2e user ${userId}: ${error.message}`);
  }
  await deleteTestSocials(adminClient, createdSocialIds.splice(0));
}

/** A new social, removed by `deleteCreatedLogins` after the tests. */
export async function createSocial(name: string): Promise<string> {
  const { data, error } = await adminClient
    .from("socials")
    .insert({ name })
    .select("id")
    .single();
  if (error) throw error;
  createdSocialIds.push(data.id);
  return data.id;
}

export function uniqueEmail(label: string): string {
  return `e2e-${label}-${randomUUID().slice(0, 8)}@example.test`;
}

export async function findUserIdByEmail(email: string): Promise<string | null> {
  const { data, error } = await adminClient.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error) throw error;
  return data.users.find((user) => user.email === email)?.id ?? null;
}

export async function createLogin(email: string): Promise<string> {
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) throw error;
  trackCreatedLogin(data.user.id);
  return data.user.id;
}

export async function addHostRow(
  userId: string,
  displayName: string,
  role: "manager" | "host",
  socialId: string,
) {
  const { error } = await adminClient.from("hosts").insert({
    user_id: userId,
    display_name: displayName,
    role,
    social_id: socialId,
  });
  if (error) throw error;
}

export function mailpitSearchUrl(email: string): string {
  return `${localStack.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`;
}

export async function readNewestSignInCode(email: string): Promise<string> {
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

export async function requestCode(page: Page, email: string) {
  // Old emails would hold stale codes.
  await fetch(mailpitSearchUrl(email), { method: "DELETE" });
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
}

export async function signIn(page: Page, email: string) {
  await requestCode(page, email);
  await page.getByLabel("6-digit code").fill(await readNewestSignInCode(email));
  await page.getByRole("button", { name: "Sign in" }).click();
  // "/" redirects to Session setup, where the host area starts.
  await page.waitForURL((url) => url.pathname === "/setup");
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
}

/**
 * Each test signs in from its own client IP so the app's per-IP sign-in
 * throttle (20 attempts / 10 min) doesn't trip across the suite. Locally,
 * `next start` keeps an incoming x-forwarded-for (Vercel overwrites it).
 * Use in `test.beforeEach`.
 */
export async function useRandomClientIp(page: Page) {
  const randomOctets = Array.from(
    randomUUID().replace(/-/g, "").slice(0, 6).match(/../g)!,
    (hex) => parseInt(hex, 16),
  );
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.${randomOctets.join(".")}`,
  });
}

/** Social names for e2e socials, unique per run so tests can tell them apart. */
export function uniqueSocialName(label: string): string {
  return `E2E ${label} social ${randomUUID().slice(0, 6)}`;
}

/**
 * Creates a social of its own with a new manager login and signs it in.
 * `prepareSocial` runs before signing in, e.g. to add the social's courts or
 * members so the first page already shows them.
 * Returns the manager's email and the social's id and name.
 */
export async function signInAsNewManager(
  page: Page,
  label: string,
  prepareSocial?: (socialId: string) => Promise<void>,
) {
  const email = uniqueEmail(label);
  const socialName = uniqueSocialName(label);
  const socialId = await createSocial(socialName);
  await addHostRow(
    await createLogin(email),
    `E2E ${label}`,
    "manager",
    socialId,
  );
  await prepareSocial?.(socialId);
  await signIn(page, email);
  return { email, socialId, socialName };
}
