// Socials (M4.5 A3, docs/plans/socials.md) against the LOCAL Supabase stack:
// a social's hosts co-edit its one draft ("Start a new session" opens a
// co-host's draft and says so), a stale tab is told another host changed it,
// and another social's manager sees none of it. A co-host who didn't start
// the draft discards it after a two-step confirmation. Three browser
// contexts = three signed-in people. Everything is removed afterwards.
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  addHostRow,
  adminClient,
  createLogin,
  createSocial,
  deleteCreatedLogins,
  signIn,
  signInAsNewManager,
  uniqueEmail,
  uniqueSocialName,
  useRandomClientIp,
} from "./support/localHostSession";

test.afterAll(async () => {
  // The socials go with their draft sessions (deleteTestSocials).
  await deleteCreatedLogins();
});

/** A fresh browser context: its own cookies, so its own signed-in person. */
async function newSignedOutPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

/**
 * The autosave status in the page header: the first status in <main> (the
 * co-host notice below it is a status too).
 */
function saveStatus(page: Page) {
  return page.getByRole("main").getByRole("status").first();
}

test("a social's hosts share its draft, a stale tab hears about the co-host's change, and another social sees nothing", async ({
  browser,
}) => {
  const token = `Zqsocial${randomUUID().slice(0, 8)}`;
  const draftName = `E2E shared draft ${token}`;

  // Social A: a manager and a host. The host is created first so cleanup
  // (in creation order) never leaves the social with a host but no manager.
  const socialAName = uniqueSocialName("socials-a");
  const socialAId = await createSocial(socialAName);
  const coHostEmail = uniqueEmail("socials-cohost");
  await addHostRow(
    await createLogin(coHostEmail),
    "E2E co-host",
    "host",
    socialAId,
  );
  const managerEmail = uniqueEmail("socials-manager");
  await addHostRow(
    await createLogin(managerEmail),
    "E2E manager",
    "manager",
    socialAId,
  );

  // The co-host opens Setup first: nothing is open yet.
  const coHostPage = await newSignedOutPage(browser);
  await useRandomClientIp(coHostPage);
  await signIn(coHostPage, coHostEmail);
  await expect(
    coHostPage.getByRole("heading", { name: "No session in progress" }),
  ).toBeVisible();

  // Meanwhile the manager starts the social's draft and names it.
  const managerPage = await newSignedOutPage(browser);
  await useRandomClientIp(managerPage);
  await signIn(managerPage, managerEmail);
  await managerPage
    .getByRole("button", { name: "Start a new session" })
    .click();
  await managerPage.getByLabel("Session name").fill(draftName);
  await expect(saveStatus(managerPage)).toHaveText("Saved");

  // The co-host's "Start a new session" opens that draft and says so.
  await coHostPage.getByRole("button", { name: "Start a new session" }).click();
  await expect(
    coHostPage.getByText(
      `A co-host already started \u201c${draftName}\u201d. You're editing it together.`,
    ),
  ).toBeVisible();
  await expect(coHostPage.getByLabel("Session name")).toHaveValue(draftName);
  await coHostPage
    .getByLabel("Location (optional)")
    .fill(`Co-host courts ${token}`);
  await expect(saveStatus(coHostPage)).toHaveText("Saved");

  // The manager's tab was loaded before that change: its next edit is refused.
  await managerPage.getByLabel("Session name").fill("Stale manager edit");
  const conflictBanner = managerPage.getByRole("region", {
    name: "Setup changed elsewhere",
  });
  await expect(conflictBanner).toContainText(
    "Setup was changed by another host, tab or device. Reload to see the latest — your unsaved changes here will be lost.",
  );
  const { data: draftRow, error } = await adminClient
    .from("sessions")
    .select("name, location")
    .eq("social_id", socialAId)
    .eq("status", "draft")
    .single();
  if (error) throw error;
  expect(draftRow).toEqual({
    name: draftName,
    location: `Co-host courts ${token}`,
  });

  // After a reload the manager sees the co-host's change.
  await conflictBanner.getByRole("button", { name: "Reload" }).click();
  await expect(managerPage.getByLabel("Location (optional)")).toHaveValue(
    `Co-host courts ${token}`,
  );

  // Another social's manager: no open session, nothing of social A.
  const otherPage = await newSignedOutPage(browser);
  await useRandomClientIp(otherPage);
  await signInAsNewManager(otherPage, "socials-b");
  await expect(
    otherPage.getByRole("heading", { name: "No session in progress" }),
  ).toBeVisible();
  await expect(otherPage.getByText(token)).toHaveCount(0);

  // The co-host, who didn't start the draft, may discard it, but only after
  // a dialog that names it and says it goes for every host.
  const readDraftRow = async () => {
    const { data, error: readError } = await adminClient
      .from("sessions")
      .select("id, status, name, draft_revision")
      .eq("social_id", socialAId)
      .neq("status", "live")
      .single();
    if (readError) throw readError;
    return data;
  };
  const rowBeforeDiscard = await readDraftRow();
  expect(rowBeforeDiscard.status).toBe("draft");
  await coHostPage.getByRole("button", { name: "Discard draft" }).click();
  const coHostDialog = coHostPage.getByRole("dialog", {
    name: `Discard \u201c${draftName}\u201d?`,
  });
  await expect(coHostDialog).toContainText(
    `This discards the draft for every host of ${socialAName}, including anyone editing it right now.`,
  );
  await expect(coHostDialog).toContainText("Hosted by E2E manager");
  await coHostDialog.getByRole("button", { name: "Keep draft" }).click();
  await expect(coHostDialog).toBeHidden();
  expect(await readDraftRow()).toEqual(rowBeforeDiscard);

  await coHostPage.getByRole("button", { name: "Discard draft" }).click();
  await expect(
    coHostDialog.getByRole("button", { name: "Discard for all hosts" }),
  ).toBeDisabled();
  await coHostDialog
    .getByRole("checkbox", {
      name: `I understand this discards \u201c${draftName}\u201d for all hosts`,
    })
    .check();
  await coHostDialog
    .getByRole("button", { name: "Discard for all hosts" })
    .click();
  await expect(
    coHostPage.getByRole("heading", { name: "No session in progress" }),
  ).toBeVisible();
  expect(await readDraftRow()).toMatchObject({
    id: rowBeforeDiscard.id,
    status: "cancelled",
  });

  // The manager's tab still shows the draft: discarding it there is refused
  // inside the dialog, which stays open.
  await managerPage.getByRole("button", { name: "Discard draft" }).click();
  const managerDialog = managerPage.getByRole("dialog", {
    name: `Discard \u201c${draftName}\u201d?`,
  });
  await managerDialog.getByRole("checkbox").check();
  await managerDialog
    .getByRole("button", { name: "Discard for all hosts" })
    .click();
  await expect(managerDialog).toContainText(
    "This draft is no longer open (it was discarded or started). Reload the page.",
  );
  await expect(managerDialog).toBeVisible();

  for (const page of [managerPage, coHostPage, otherPage]) {
    await page.context().close();
  }
});
