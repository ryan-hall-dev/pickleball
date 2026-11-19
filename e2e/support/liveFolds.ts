import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The live Waiting and Resting lists show 3 players until a host opens them.
 * Journeys that act on any waiting player call this after loading the page (and
 * again if more players arrive while it is open).
 */
export async function showEveryWaitingPlayer(page: Page) {
  await page.getByRole("region", { name: /^Waiting/ }).waitFor();
  const folded = page.getByRole("button", {
    name: /^Show all \d+ (waiting|resting)$/,
  });
  while (await folded.count()) await folded.first().click();
}

/**
 * Waits for the Rest buttons in the Waiting list to reach `expectedCount`,
 * opening the folded list on each try so arrivals beyond the top 3 are counted.
 */
export async function expectRestButtonCount(
  page: Page,
  restButtons: Locator,
  expectedCount: number,
) {
  await expect
    .poll(
      async () => {
        await showEveryWaitingPlayer(page);
        return restButtons.count();
      },
      { timeout: 10_000 },
    )
    .toBe(expectedCount);
}
