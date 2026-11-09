// The Members directory (/members) against the LOCAL Supabase stack. Runs on
// desktop and on a phone (the `mobile` project). Test members carry a unique
// token in their last name and every check searches for it, so other data in
// the database doesn't interfere.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  adminClient,
  deleteCreatedLogins,
  signInAsNewManager,
  useRandomClientIp,
} from "./support/localHostSession";

/** A unique, letters-only last name. */
function uniqueLastName(): string {
  const letters = randomUUID()
    .replace(/[^a-f]/g, "")
    .slice(0, 8)
    .padEnd(8, "q");
  const token = `Zqe${letters}`;
  return token;
}

test.beforeEach(async ({ page }) => {
  await useRandomClientIp(page);
});

test.afterAll(async () => {
  // The test socials go with every member the tests added.
  await deleteCreatedLogins();
});

async function searchMembers(page: Page, searchText: string) {
  const searchInput = page.getByRole("searchbox", {
    name: "Search members by name",
  });
  await searchInput.fill(searchText);
  // Debounced: the URL updates, then the server renders the results.
  await expect(page).toHaveURL(
    new RegExp(
      `[?&]q=${encodeURIComponent(searchText).replace(/%20/g, "\\+")}`,
    ),
  );
}

/** Orange edge and text (DESIGN.md attention colours), not the grey outline. */
async function expectOrangeOutline(button: Locator) {
  await expect(button).toHaveCSS("border-top-color", "rgb(90, 66, 32)");
  await expect(button).toHaveCSS("color", "rgb(255, 184, 119)");
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("a host adds, finds, edits, deactivates and reactivates a member", async ({
  page,
}) => {
  const lastName = uniqueLastName();
  const fullName = `Ana ${lastName}`;
  const memberCard = page.getByRole("link", { name: new RegExp(fullName) });

  await signInAsNewManager(page, "members");
  await page.getByRole("link", { name: "Members", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Members", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  // Add: required fields are checked inline.
  await page.getByRole("link", { name: "Add member", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Add a member" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add member" }).click();
  const firstNameInput = page.getByLabel("First name");
  await expect(page.getByText("Enter a first name.")).toBeVisible();
  await expect(firstNameInput).toHaveAttribute("aria-invalid", "true");
  await expect(firstNameInput).toHaveAccessibleDescription(
    "Enter a first name.",
  );
  await expectNoHorizontalScroll(page);

  await firstNameInput.fill("Ana");
  await page.getByLabel("Last name").fill(lastName);
  await page.getByLabel("Skill (optional)").selectOption("beginner");
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.getByRole("status")).toHaveText(`Saved ${fullName}.`);
  // The notice is shown once: ?saved= leaves the address, so a refresh drops it.
  await expect(page).toHaveURL(/\/members$/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);

  // Find it: accent- and case-insensitive contains search on the full name.
  await searchMembers(page, `ána ${lastName.toLowerCase()}`);
  await expect(memberCard).toHaveCount(1);
  await expect(memberCard).toContainText("Beginner");
  await expect(memberCard).toContainText("Never checked in");
  await expect(page.getByText("Showing 1 of 1 active member")).toBeVisible();
  // The search survives a refresh.
  await page.reload();
  await expect(
    page.getByRole("searchbox", { name: "Search members by name" }),
  ).toHaveValue(`ána ${lastName.toLowerCase()}`);
  await expect(memberCard).toHaveCount(1);

  // Edit the skill.
  await memberCard.click();
  await expect(
    page.getByRole("heading", { name: `Edit ${fullName}` }),
  ).toBeVisible();
  await page.getByLabel("Skill (optional)").selectOption("advanced");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText(`Saved ${fullName}.`);
  await searchMembers(page, lastName);
  await expect(memberCard).toContainText("Advanced");

  // Deactivate: no longer active, listed under Deactivated with the word shown.
  await memberCard.click();
  const deactivateButton = page.getByRole("button", {
    name: "Deactivate member",
  });
  await expectOrangeOutline(deactivateButton);
  await deactivateButton.click();
  await expect(page.getByText("DEACTIVATED", { exact: true })).toBeVisible();
  await page.goto(`/members?q=${lastName}`);
  await expect(
    page.getByRole("heading", {
      name: `No active members match “${lastName}”`,
    }),
  ).toBeVisible();
  const deactivatedChip = page.getByRole("button", {
    name: "Deactivated",
    exact: true,
  });
  await deactivatedChip.click();
  await expect(deactivatedChip).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/status=deactivated/);
  await expect(memberCard).toContainText("Deactivated · Never checked in");

  // Reactivate.
  await memberCard.click();
  await page.getByRole("button", { name: "Reactivate member" }).click();
  await expect(page.getByText("ACTIVE", { exact: true })).toBeVisible();
  await page.goto(`/members?q=${lastName}`);
  await expect(memberCard).toHaveCount(1);
  await expect(memberCard).not.toContainText("Deactivated");
});

test("a duplicate name warns before saving", async ({ page }) => {
  const lastName = uniqueLastName();
  await signInAsNewManager(page, "members-dup");

  async function submitKofi() {
    await page.goto("/members/new");
    await page.getByLabel("First name").fill("Kofi");
    await page.getByLabel("Last name").fill(lastName);
    await page.getByRole("button", { name: "Add member" }).click();
  }
  await submitKofi();
  await expect(page.getByRole("status")).toHaveText(`Saved Kofi ${lastName}.`);
  await submitKofi();
  await expect(
    page.getByText(`An active member is already called Kofi ${lastName}.`),
  ).toBeVisible();
  // The values are kept, and the host can still save a different person.
  await expect(page.getByLabel("Last name")).toHaveValue(lastName);
  const saveAnywayButton = page.getByRole("button", { name: "Save anyway" });
  await expectOrangeOutline(saveAnywayButton);
  // Cancel matches the 56px primary button beside it.
  await expect(page.getByRole("link", { name: "Cancel" })).toHaveCSS(
    "height",
    "56px",
  );
  await saveAnywayButton.click();
  await expect(page.getByRole("status")).toHaveText(`Saved Kofi ${lastName}.`);
  await page.goto(`/members?q=${lastName}`);
  await expect(
    page.getByRole("link", { name: new RegExp(`Kofi ${lastName}`) }),
  ).toHaveCount(2);
});

test("an empty search shows a clear state, the page fits the screen and focus is visible", async ({
  page,
}) => {
  // Members belong to a social: a new social's directory is empty ("No
  // members yet", no search), so give it one member to search past.
  const memberLastName = uniqueLastName();
  await signInAsNewManager(page, "members-empty", async (socialId) => {
    const { error } = await adminClient.from("members").insert({
      social_id: socialId,
      first_name: "Grace",
      last_name: memberLastName,
    });
    if (error) throw error;
  });
  const unmatchedText = uniqueLastName();

  await page.goto("/members");
  await expectNoHorizontalScroll(page);
  await searchMembers(page, unmatchedText);
  await expect(
    page.getByRole("heading", {
      name: `No active members match “${unmatchedText}”`,
    }),
  ).toBeVisible();
  await expect(page.getByText("No matching members")).toBeAttached();
  await expectNoHorizontalScroll(page);

  // Skill chips are toggle buttons.
  const advancedChip = page.getByRole("button", {
    name: "Advanced",
    exact: true,
  });
  await expect(advancedChip).toHaveAttribute("aria-pressed", "false");
  await advancedChip.click();
  await expect(advancedChip).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "All", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(/skill=advanced/);
  // The typed search is kept when a chip is pressed.
  await expect(page).toHaveURL(new RegExp(`q=${unmatchedText}`));

  await page.getByRole("link", { name: "Clear search and filters" }).click();
  await expect(page).toHaveURL(/\/members$/);
  await expect(
    page.getByRole("searchbox", { name: "Search members by name" }),
  ).toHaveValue("");

  // Keyboard focus shows the 2px ring on the search box and the chips.
  await page.getByRole("searchbox", { name: "Search members by name" }).focus();
  await page.keyboard.press("Tab");
  const focusedOutline = await page.evaluate(() => {
    const focused = document.activeElement as HTMLElement;
    const style = getComputedStyle(focused);
    return {
      text: focused.textContent,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(focusedOutline).toEqual({
    text: "All",
    outlineStyle: "solid",
    outlineWidth: "2px",
  });
});
