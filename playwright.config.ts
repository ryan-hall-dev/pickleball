import { defineConfig, devices } from "@playwright/test";

const isCi = Boolean(process.env.CI);
const baseUrl = "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  reporter: isCi ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: baseUrl,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: isCi ? "pnpm build && pnpm start" : "pnpm dev",
    url: baseUrl,
    reuseExistingServer: !isCi,
    timeout: 180_000,
  },
});
