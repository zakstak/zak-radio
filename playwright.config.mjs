import { defineConfig } from "@playwright/test";

const browserPort = Number(process.env.ZAK_RADIO_BROWSER_PORT || "28799");
if (!Number.isInteger(browserPort) || browserPort < 1024 || browserPort > 65535) {
  throw new Error("ZAK_RADIO_BROWSER_PORT must be an integer from 1024 to 65535");
}
const baseURL = `http://127.0.0.1:${browserPort}`;

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: process.env.ZAK_RADIO_PLAYWRIGHT_OUTPUT ||
    `/tmp/zak-radio-playwright-results-${process.pid}`,
  use: {
    baseURL,
    headless: true,
    timezoneId: "America/New_York",
  },
  webServer: {
    command: "bash scripts/start-browser-fixture.sh",
    url: `${baseURL}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
