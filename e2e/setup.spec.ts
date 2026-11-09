// Session setup (/setup) against the LOCAL Supabase stack: Session details,
// Courts, Who's playing and the Session summary. Runs on desktop and on a
// phone (the `mobile` project). Test courts and members carry a unique token
// in their name; test sessions belong to the test's own host. Everything is
// removed afterwards.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  addHostRow,
  adminClient,
  createLogin,
  deleteCreatedLogins,
  findUserIdByEmail,
  signIn,
  signInAsNewAdmin,
  uniqueEmail,
  useRandomClientIp,
} from "./support/localHostSession";

const courtNameTokens: string[] = [];
const memberNameTokens: string[] = [];
const testHostUserIds: string[] = [];

function uniqueCourtToken(): string {
  const token = `Zqcourt${randomUUID().slice(0, 8)}`;
  courtNameTokens.push(token);
  return token;
}

test.beforeEach(async ({ page }) => {
  await useRandomClientIp(page);
});

test.afterAll(async () => {
  // Test-only cleanup with the secret key; the app never deletes sessions or courts.
  for (const hostUserId of testHostUserIds.splice(0)) {
    const { data: sessions } = await adminClient
      .from("sessions")
      .select("id, status")
      .eq("host_id", hostUserId);
    for (const session of sessions ?? []) {
      // Participants can only be removed while the session is a draft.
      if (session.status === "draft") {
        await adminClient
          .from("session_participants")
          .delete()
          .eq("session_id", session.id);
      }
      const { error } = await adminClient
        .from("sessions")
        .delete()
        .eq("id", session.id);
      if (error) {
        console.warn(
          `Couldn't delete e2e session ${session.id}: ${error.message}`,
        );
      }
    }
  }
  for (const token of courtNameTokens.splice(0)) {
    await adminClient.from("courts").delete().like("name", `${token}%`);
  }
  // After the sessions, whose attendee rows point at the members.
  for (const token of memberNameTokens.splice(0)) {
    await adminClient.from("members").delete().eq("last_name", token);
  }
  await deleteCreatedLogins();
});

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectSaved(page: Page) {
  await expect(page.getByRole("status")).toHaveText("Saved");
}

async function openDraftSessionId(hostUserId: string): Promise<string> {
  const { data, error } = await adminClient
    .from("sessions")
    .select("id")
    .eq("host_id", hostUserId)
    .eq("status", "draft")
    .single();
  if (error) throw error;
  return data.id;
}

test("a host sets up a draft's details and courts, sees the summary, reloads and discards it", async ({
  page,
}) => {
  const courtToken = uniqueCourtToken();
  const { error: courtsError } = await adminClient.from("courts").insert([
    { name: `${courtToken} A`, sort_order: 900_001 },
    { name: `${courtToken} B`, sort_order: 900_002 },
  ]);
  if (courtsError) throw courtsError;
  const email = await signInAsNewAdmin(page, "setup");
  const hostUserId = (await findUserIdByEmail(email))!;
  testHostUserIds.push(hostUserId);

  // Open Session setup from the nav: no draft yet.
  const setupNavLink = page
    .getByRole("navigation", { name: "Host" })
    .getByRole("link", { name: "Session setup" });
  await setupNavLink.click();
  await expect(
    page.getByRole("heading", { name: "Set up a session" }),
  ).toBeVisible();
  await expect(setupNavLink).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "No session in progress" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start a new session" }).click();
  await expect(
    page.getByRole("heading", { name: "Session details" }),
  ).toBeVisible();
  await expectSaved(page);

  // Session details: name, date, times and duration chips.
  await page.getByLabel("Session name").fill("E2E Saturday social");
  await page.getByLabel("Date").fill("2026-12-05");
  await page.getByLabel("Start time").fill("18:00");
  await page.getByRole("button", { name: "90 min" }).click();
  await expect(page.getByLabel("End time")).toHaveValue("19:30");
  await expect(page.getByRole("button", { name: "90 min" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByText("· 90 minutes, calculated from start and end"),
  ).toBeVisible();
  // An earlier end time is the next day: fine up to 12 hours, refused beyond.
  const endTimeInput = page.getByLabel("End time");
  await endTimeInput.fill("01:00");
  await expect(page.getByText("(next day)")).toBeVisible();
  await expect(endTimeInput).not.toHaveAttribute("aria-invalid");
  await endTimeInput.fill("17:00");
  await expect(endTimeInput).toHaveAttribute("aria-invalid", "true");
  await expect(endTimeInput).toHaveAccessibleDescription(
    "(next day) A session can last at most 12 hours.",
  );
  await expect(page.getByRole("status")).toContainText("Not saved");
  await page.getByLabel("End time").fill("19:30");
  await page.getByLabel("Location (optional)").fill("Riverside courts");
  await expectSaved(page);

  // Courts: pick the two test courts, add one through "Add court", choose singles.
  const courtA = page.getByRole("button", {
    name: new RegExp(`${courtToken} A`),
  });
  const courtB = page.getByRole("button", {
    name: new RegExp(`${courtToken} B`),
  });
  await courtA.click();
  await courtB.click();
  await expect(courtA).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("8 on court")).toBeVisible();
  await page.getByRole("button", { name: "Singles · 1 v 1" }).click();
  await expect(
    page.getByRole("button", { name: "Singles · 1 v 1" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("4 on court")).toBeVisible();
  // A new singles-only court is selected straight away, and then doubles is
  // unavailable until it's removed again.
  await page.getByRole("button", { name: "Add court", exact: true }).click();
  await page.getByLabel("Court name").fill(`${courtToken} C`);
  await page.getByRole("button", { name: "Doubles", exact: true }).click();
  await page.getByRole("button", { name: "Add court", exact: true }).click();
  const courtC = page.getByRole("button", {
    name: new RegExp(`${courtToken} C`),
  });
  await expect(courtC).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Doubles · 2 v 2" }),
  ).toBeDisabled();
  await expect(page.getByText("6 on court")).toBeVisible();
  await expectSaved(page);

  const summary = page.getByRole("complementary", {
    name: "Session summary and start",
  });
  await expect(summary).toContainText("E2E Saturday social");
  await expect(summary).toContainText("Sat 5 Dec · 18:00 – 19:30");
  await expect(summary).toContainText("90 min");
  await expect(summary).toContainText("3 · singles");
  await expect(summary).toContainText(
    "Not enough players: a court needs 2 and 0 are attending.",
  );
  await expect(
    summary.getByRole("button", { name: /start pickleball session/i }),
  ).toBeDisabled();
  await expectNoHorizontalScroll(page);

  // Players arrive in a later step; add ten guests directly to see the estimate.
  const sessionId = await openDraftSessionId(hostUserId);
  const { error: guestsError } = await adminClient
    .from("session_participants")
    .insert(
      Array.from({ length: 10 }, (_, index) => ({
        session_id: sessionId,
        is_guest: true,
        first_name: `Guest${index}`,
        last_name: courtToken,
      })),
    );
  if (guestsError) throw guestsError;

  // Reload: everything persisted.
  await page.reload();
  await expect(page.getByLabel("Session name")).toHaveValue(
    "E2E Saturday social",
  );
  await expect(page.getByLabel("Date")).toHaveValue("2026-12-05");
  await expect(page.getByLabel("Start time")).toHaveValue("18:00");
  await expect(page.getByLabel("End time")).toHaveValue("19:30");
  await expect(page.getByLabel("Location (optional)")).toHaveValue(
    "Riverside courts",
  );
  await expect(courtA).toHaveAttribute("aria-pressed", "true");
  await expect(courtC).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Singles · 1 v 1" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(summary).toContainText("10 (0 members + 10 guests)");
  await expect(
    summary.getByRole("img", {
      name: "Capacity: 3 courts of 2 players, 6 on court, 4 waiting",
    }),
  ).toBeVisible();
  // 90 min of 15 + 2 min slots = 5 rounds; 6 seats for 10 players = 3 games each.
  await expect(summary).toContainText(
    "About 5 rounds fit in 90 min, so expect 3 games per player.",
  );
  await expect(
    page.getByText("10 players → 4 waiting at the start"),
  ).toBeVisible();

  // Removing a court updates the estimate and re-enables doubles.
  await page.getByRole("button", { name: "Remove a court" }).click();
  await expect(courtC).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Doubles · 2 v 2" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Doubles · 2 v 2" }).click();
  await expect(summary).toContainText(
    "About 5 rounds fit in 90 min, so expect 4 games per player.",
  );
  await expectSaved(page);
  await expectNoHorizontalScroll(page);

  // Discard (after removing the test guests, which only a draft allows).
  await adminClient
    .from("session_participants")
    .delete()
    .eq("session_id", sessionId);
  await page.getByRole("button", { name: "Discard draft" }).click();
  await page.getByRole("button", { name: "Yes, discard" }).click();
  await expect(
    page.getByRole("heading", { name: "No session in progress" }),
  ).toBeVisible();
  const { data: discarded } = await adminClient
    .from("sessions")
    .select("status")
    .eq("id", sessionId)
    .single();
  expect(discarded?.status).toBe("cancelled");
});

test("setup works from the keyboard with a visible focus ring", async ({
  page,
}) => {
  const email = await signInAsNewAdmin(page, "setup-keys");
  testHostUserIds.push((await findUserIdByEmail(email))!);
  await page.goto("/setup");
  await page.getByRole("button", { name: "Start a new session" }).click();
  await expect(
    page.getByRole("heading", { name: "Session details" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "60 min" }).focus();
  await page.keyboard.press("Tab");
  const chip90 = page.getByRole("button", { name: "90 min" });
  await expect(chip90).toBeFocused();
  await expect(chip90).toHaveCSS("outline-style", "solid");
  await expect(chip90).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Space");
  await expect(chip90).toHaveAttribute("aria-pressed", "true");
  // "Custom…" moves focus to the end time, where a custom length is typed.
  await page.getByRole("button", { name: "Custom…" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("End time")).toBeFocused();
  await expectSaved(page);
  await expectNoHorizontalScroll(page);
});

async function startNewDraft(page: Page) {
  await page.goto("/setup");
  await page.getByRole("button", { name: "Start a new session" }).click();
  await expect(
    page.getByRole("heading", { name: "Who's playing?" }),
  ).toBeVisible();
}

async function expectAttendanceSaved(page: Page) {
  await expect(page.getByText("Saving attendance…")).toHaveCount(0);
  await expect(page.getByText(/not saved/i)).toHaveCount(0);
}

test("a host picks members and guests for a draft, and they persist", async ({
  page,
}) => {
  const memberToken = `Zqmember${randomUUID().slice(0, 8)}`;
  memberNameTokens.push(memberToken);
  const { error: membersError } = await adminClient.from("members").insert([
    { first_name: "Grace", last_name: memberToken, skill_level: "advanced" },
    { first_name: "Kofi", last_name: memberToken },
  ]);
  if (membersError) throw membersError;
  const email = await signInAsNewAdmin(page, "setup-players");
  testHostUserIds.push((await findUserIdByEmail(email))!);
  await startNewDraft(page);

  const card = page.getByRole("region", { name: "Who's playing?" });
  const summary = page.getByRole("complementary", {
    name: "Session summary and start",
  });
  await card.getByLabel("Search members by name").fill(memberToken);
  await expect(card.getByText("Showing 2 of 2 matching members")).toBeVisible();
  const grace = card.getByRole("button", {
    name: new RegExp(`^Grace ${memberToken}`),
  });
  await grace.click();
  await expect(grace).toHaveAttribute("aria-pressed", "true");
  await expect(grace).toContainText("Attending");

  // A guest: the last name is required.
  await card.getByLabel("First name").fill("Kai");
  await card.getByRole("button", { name: "Add guest" }).click();
  await expect(card.getByLabel("Last name")).toHaveAccessibleDescription(
    "Enter a last name.",
  );
  await card.getByLabel("Last name").fill(memberToken);
  await card.getByLabel("Skill (optional)").selectOption("beginner");
  await card.getByRole("button", { name: "Add guest" }).click();
  const removeKai = card.getByRole("button", {
    name: `Remove guest Kai ${memberToken}`,
  });
  await expect(removeKai).toBeEnabled();
  await expect(card.getByText("Guest · Beginner")).toBeVisible();
  await expectAttendanceSaved(page);
  await expect(summary).toContainText("2 (1 member + 1 guest)");

  // Reload: both persisted, and the summary counts them.
  await page.reload();
  await card.getByLabel("Search members by name").fill(memberToken);
  await expect(grace).toHaveAttribute("aria-pressed", "true");
  await expect(removeKai).toBeVisible();
  await expect(summary).toContainText("2 (1 member + 1 guest)");
  await expect(card.getByText("1 attending", { exact: true })).toBeVisible();
  await expect(card.getByText(/^\d+ registered$/)).toBeVisible();
  await expect(card.getByText(/^\d+ not attending$/)).toBeVisible();
  await expect(card.getByText("+1 guest")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Remove the guest; add another, then Clear removes members only.
  await removeKai.click();
  await expect(removeKai).toHaveCount(0);
  await expectAttendanceSaved(page);
  await expect(summary).toContainText("1 (1 member + 0 guests)");
  await card.getByLabel("First name").fill("Ben");
  await card.getByLabel("Last name").fill(memberToken);
  await card.getByRole("button", { name: "Add guest" }).click();
  await expectAttendanceSaved(page);
  await card
    .getByRole("button", { name: "Clear 1 attending member (guests stay)" })
    .click();
  await expect(grace).toHaveAttribute("aria-pressed", "false");
  await expectAttendanceSaved(page);
  await expect(
    card.getByRole("button", { name: `Remove guest Ben ${memberToken}` }),
  ).toBeVisible();
  await expect(summary).toContainText("1 (0 members + 1 guest)");

  // The guest never joined the members directory.
  const { count } = await adminClient
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("last_name", memberToken);
  expect(count).toBe(2);
});

test("a host who isn't an admin can't add courts to the club", async ({
  page,
}) => {
  const email = uniqueEmail("setup-host");
  const hostUserId = await createLogin(email);
  await addHostRow(hostUserId, "E2E setup host", "host");
  testHostUserIds.push(hostUserId);
  await signIn(page, email);
  await startNewDraft(page);
  await expect(page.getByRole("heading", { name: "Courts" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add court", exact: true }),
  ).toHaveCount(0);
});
