// Renders every [data-shot] frame in the M5 design drafts to PNG (2x) and
// reports elements that stick out of their frame (horizontal overflow).
// Run from the repo root:  node docs/designs/m5/render.mjs [file.html ...]
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// @playwright/test is the devDependency; it re-exports the playwright browsers.
import { chromium } from "@playwright/test";

const designsDirectory = dirname(fileURLToPath(import.meta.url));
const screensDirectory = join(designsDirectory, "screens");
// Pass file names to render only those, e.g. `node render.mjs host-tray.html`.
const designFiles =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ["player-checkin.html", "host-tray.html", "sticker-qr.html"];

await mkdir(screensDirectory, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});

let overflowProblemCount = 0;
for (const designFile of designFiles) {
  if (!existsSync(join(designsDirectory, designFile)))
    throw new Error(`Missing ${designFile}`);
  await page.goto(pathToFileURL(join(designsDirectory, designFile)).href);
  // Outfit comes from Google Fonts; fall back to system-ui when offline.
  await page.evaluate(() =>
    Promise.race([
      document.fonts.ready,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]),
  );

  const overflowProblems = await page.evaluate(() => {
    const problems = [];
    for (const frameElement of document.querySelectorAll("[data-shot]")) {
      const screen =
        frameElement.querySelector("[data-screen], .phone") ?? frameElement;
      const screenBox = screen.getBoundingClientRect();
      if (screen.scrollWidth > screen.clientWidth + 1) {
        problems.push(
          `${frameElement.dataset.shot}: scrollWidth ${screen.scrollWidth} > ${screen.clientWidth}`,
        );
      }
      for (const element of screen.querySelectorAll("*")) {
        const box = element.getBoundingClientRect();
        if (box.width === 0) continue;
        if (
          box.right > screenBox.right + 0.5 ||
          box.left < screenBox.left - 0.5
        ) {
          problems.push(
            `${frameElement.dataset.shot}: <${element.tagName.toLowerCase()} class="${element.className?.baseVal ?? element.className}"> sticks out (${Math.round(box.left - screenBox.left)}..${Math.round(box.right - screenBox.left)} of ${Math.round(screenBox.width)})`,
          );
        }
        if (
          element.scrollWidth > element.clientWidth + 1 &&
          getComputedStyle(element).overflowX === "visible" &&
          element.clientWidth > 0 &&
          !["svg", "path"].includes(element.tagName.toLowerCase())
        ) {
          problems.push(
            `${frameElement.dataset.shot}: <${element.tagName.toLowerCase()}> content wider than box (${element.scrollWidth} > ${element.clientWidth}): "${element.textContent.trim().slice(0, 40)}"`,
          );
        }
      }
    }
    return problems;
  });
  overflowProblemCount += overflowProblems.length;
  for (const problem of overflowProblems)
    console.warn(`OVERFLOW ${designFile} ${problem}`);

  const frameNames = await page.$$eval("[data-shot]", (frames) =>
    frames.map((frame) => frame.dataset.shot),
  );
  for (const frameName of frameNames) {
    await page
      .locator(`[data-shot="${frameName}"]`)
      .screenshot({ path: join(screensDirectory, `${frameName}.png`) });
    console.log(`rendered screens/${frameName}.png`);
  }
}
await browser.close();
console.log(
  overflowProblemCount === 0
    ? "No overflow found."
    : `${overflowProblemCount} overflow problem(s).`,
);
process.exitCode = overflowProblemCount === 0 ? 0 : 1;
