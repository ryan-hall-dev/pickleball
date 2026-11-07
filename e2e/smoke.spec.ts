import { expect, test } from "@playwright/test";

test("the app serves the host sign-in page", async ({ page }) => {
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { level: 1, name: "Host sign in" }),
  ).toBeVisible();
});
