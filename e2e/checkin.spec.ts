// The public player check-in page (/t/<tag>, M5 increment 2) at 390 px
// against the LOCAL Supabase stack: a new phone finds its name and waits,
// a host's approval (approve_checkin with the secret key; the host tray's own
// journey is checkinTray.spec.ts) switches it to "You're in" within a poll, a reload keeps
// the state, the approved phone is recognised next time, the required form's
// errors, a rejection with Try again, an inactive link and a social with
// nothing open. Each test has its own social; everything is removed after.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  addHostRow,
  adminClient,
  createLogin,
  createSocial,
  deleteCreatedLogins,
  uniqueEmail,
  uniqueSocialName,
  useRandomClientIp,
} from "./support/localHostSession";

test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  // Each test is its own network for the per-IP check-in limits.
  await useRandomClientIp(page);
});

test.afterAll(async () => {
  await deleteCreatedLogins();
});

/** The waiting screen polls every 5 s; allow two polls. */
const POLL_TIMEOUT_MS = 12_000;

interface OpenSocial {
  socialId: string;
  checkinTag: string;
  socialName: string;
  sessionId: string;
  sessionName: string;
  managerUserId: string;
}

/**
 * A social with a manager and an open draft session (2 courts).
 */
async function createSocialWithOpenSession(label: string): Promise<OpenSocial> {
  const socialName = uniqueSocialName(label);
  const socialId = await createSocial(socialName);
  const managerUserId = await createLogin(uniqueEmail(label));
  await addHostRow(managerUserId, `E2E ${label}`, "manager", socialId);

  const sessionName = `E2E check-in ${randomUUID().slice(0, 6)}`;
  const plannedStart = new Date(Date.now() + 20 * 60_000);
  const { data: session, error: sessionError } = await adminClient
    .from("sessions")
    .insert({
      social_id: socialId,
      host_id: managerUserId,
      name: sessionName,
      host_name: `E2E ${label}`,
      planned_start: plannedStart.toISOString(),
      planned_end: new Date(
        plannedStart.getTime() + 120 * 60_000,
      ).toISOString(),
      config_snapshot: {
        courts: [{ courtId: randomUUID() }, { courtId: randomUUID() }],
      },
    })
    .select("id")
    .single();
  if (sessionError) throw sessionError;

  const { data: social, error: socialError } = await adminClient
    .from("socials")
    .select("checkin_tag")
    .eq("id", socialId)
    .single();
  if (socialError) throw socialError;
  return {
    socialId,
    checkinTag: social.checkin_tag,
    socialName,
    sessionId: session.id,
    sessionName,
    managerUserId,
  };
}

async function pendingRequestId(social: OpenSocial): Promise<string> {
  const { data, error } = await adminClient
    .from("checkin_requests")
    .select("id")
    .eq("session_id", social.sessionId)
    .eq("status", "pending")
    .single();
  if (error) throw error;
  return data.id;
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function fillCheckin(page: Page, firstName: string, lastName: string) {
  await page.getByRole("textbox", { name: "First name" }).fill(firstName);
  await page.getByRole("textbox", { name: "Last name" }).fill(lastName);
  await page
    .getByRole("group", { name: "Your level" })
    .getByRole("button", { name: "Intermediate" })
    .click();
}

test("a player submits fresh details, reloads pending, and receives approval within a poll", async ({
  page,
}) => {
  const social = await createSocialWithOpenSession("checkin-player");
  await page.goto(`/t/${social.checkinTag}`);
  await expect(
    page.getByRole("heading", { name: social.sessionName }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: `Welcome to ${social.socialName}` }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await fillCheckin(page, "Grace", "Kim");
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Waiting for the host to approve" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Waiting for the host to approve" }),
  ).toBeVisible();
  const { error } = await adminClient.rpc("approve_checkin", {
    p_actor_user_id: social.managerUserId,
    p_checkin_request_id: await pendingRequestId(social),
    p_session_participant_id: randomUUID(),
  });
  if (error) throw error;
  await expect(
    page.getByRole("heading", { name: "You're in, Grace" }),
  ).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "You're in, Grace" }),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);
  // The same phone must enter everything again for the next session.
  const cancelled = await adminClient
    .from("sessions")
    .update({ status: "cancelled" })
    .eq("id", social.sessionId);
  if (cancelled.error) throw cancelled.error;
  const { data: nextSession, error: nextError } = await adminClient
    .from("sessions")
    .insert({
      social_id: social.socialId,
      host_id: social.managerUserId,
      host_name: "E2E manager",
      name: "Next session",
      planned_start: new Date().toISOString(),
      planned_end: new Date(Date.now() + 7200000).toISOString(),
    })
    .select("id")
    .single();
  if (nextError) throw nextError;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Next session", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "First name" })).toHaveValue(
    "",
  );
  await expect(page.getByRole("textbox", { name: "Last name" })).toHaveValue(
    "",
  );
  await expect(
    page.getByRole("button", { name: "Intermediate", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await fillCheckin(page, "Grace", "Kim");
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Waiting for the host to approve" }),
  ).toBeVisible();
  const nextRequest = await adminClient
    .from("checkin_requests")
    .select("id")
    .eq("session_id", nextSession.id);
  if (nextRequest.error) throw nextRequest.error;
  expect(nextRequest.data).toHaveLength(1);
});

test("the required form shows its errors after Check in, survives a lost submit, then sends the request", async ({
  page,
  context,
}) => {
  const social = await createSocialWithOpenSession("checkin-guest");
  await page.goto(`/t/${social.checkinTag}`);
  // A new phone gets its device cookie as the page opens, before any submit,
  // so a retried submit is the same phone (and the same request).
  await expect
    .poll(async () =>
      (await context.cookies()).some(
        (cookie) =>
          cookie.name === `checkin_session_${social.sessionId}` &&
          cookie.httpOnly,
      ),
    )
    .toBe(true);
  // No errors before pressing Check in.
  await expect(page.getByText("Enter your first name")).toHaveCount(0);
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  const firstName = page.getByRole("textbox", { name: "First name" });
  await expect(firstName).toHaveAttribute("aria-invalid", "true");
  await expect(firstName).toBeFocused();
  await expect(page.getByText("Enter your first name")).toBeVisible();
  await expect(page.getByText("Enter your last name")).toBeVisible();
  await expect(page.getByText("Choose your level")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Errors follow the edits once shown.
  await firstName.fill("Kai");
  await expect(page.getByText("Enter your first name")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Last name" }).fill("Moreno");
  await page
    .getByRole("group", { name: "Your level" })
    .getByRole("button", { name: "Advanced" })
    .click();

  // The connection drops on submit: P13, then Try again returns to the form
  // with what was typed.
  await page.route("**/t/**", (route) =>
    route.request().method() === "POST" ? route.abort() : route.continue(),
  );
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Something went wrong" }),
  ).toBeVisible();
  await page.unroute("**/t/**");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: `Welcome to ${social.socialName}` }),
  ).toBeVisible();
  await expect(firstName).toHaveValue("Kai");
  await expect(page.getByRole("textbox", { name: "Last name" })).toHaveValue(
    "Moreno",
  );
  await expect(
    page
      .getByRole("group", { name: "Your level" })
      .getByRole("button", { name: "Advanced" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Waiting for the host to approve" }),
  ).toBeVisible();

  const { data, error } = await adminClient
    .from("checkin_requests")
    .select("first_name, last_name, skill_level, status")
    .eq("session_id", social.sessionId)
    .single();
  if (error) throw error;
  expect(data).toEqual({
    first_name: "Kai",
    last_name: "Moreno",
    skill_level: "advanced",
    status: "pending",
  });
});

test("a rejected request shows the neutral message, and Try again starts over", async ({
  page,
}) => {
  const social = await createSocialWithOpenSession("checkin-reject");
  await page.goto(`/t/${social.checkinTag}`);
  await fillCheckin(page, "Grace", "Kim");
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Waiting for the host to approve" }),
  ).toBeVisible();

  const { error } = await adminClient.rpc("reject_checkin", {
    p_actor_user_id: social.managerUserId,
    p_checkin_request_id: await pendingRequestId(social),
  });
  if (error) throw error;
  await expect(
    page.getByRole("heading", { name: "Check-in not approved" }),
  ).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  await expect(
    page.getByText(
      "The host didn't approve this check-in. Please speak to the host.",
    ),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: `Welcome to ${social.socialName}` }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "First name" })).toHaveValue(
    "",
  );
  await expect(page.getByRole("textbox", { name: "Last name" })).toHaveValue(
    "",
  );
  await fillCheckin(page, "Grace", "Kim B");
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Waiting for the host to approve" }),
  ).toBeVisible();
});

test("an unknown link and a social with nothing open each get their own screen", async ({
  page,
}) => {
  await page.goto(`/t/${randomUUID().replace(/-/g, "")}`);
  await expect(
    page.getByRole("heading", { name: "This check-in link isn't active" }),
  ).toBeVisible();
  await expect(page.getByText("Pickleball Social Manager")).toBeVisible();
  await expect(
    page.getByText("Ask a host at the courts for the current QR code."),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);

  const socialName = uniqueSocialName("checkin-quiet");
  const socialId = await createSocial(socialName);
  const { data, error } = await adminClient
    .from("socials")
    .select("checkin_tag")
    .eq("id", socialId)
    .single();
  if (error) throw error;
  await page.goto(`/t/${data.checkin_tag}`);
  await expect(
    page.getByRole("heading", { name: "No social open right now" }),
  ).toBeVisible();
  await expect(page.getByText(socialName)).toBeVisible();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(
    page.getByRole("heading", { name: "No social open right now" }),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);
  // No host chrome on the public page.
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
});
