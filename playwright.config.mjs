import { defineConfig } from "@playwright/test";

function fixturePort(name, fallback) {
  const port = Number(process.env[name] || fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${name} must be an integer from 1024 to 65535`);
  }
  return port;
}

const browserPort = fixturePort("ZAK_RADIO_BROWSER_PORT", "28799");
// Native playback regressions need real source changes at track boundaries,
// so they run against a second fixture whose station alternates two tracks.
const twoTrackPort = fixturePort(
  "ZAK_RADIO_TWO_TRACK_BROWSER_PORT",
  String(browserPort + 1),
);
const baseURL = `http://127.0.0.1:${browserPort}`;
const twoTrackURL = `http://127.0.0.1:${twoTrackPort}`;

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: process.env.ZAK_RADIO_PLAYWRIGHT_OUTPUT ||
    `/tmp/zak-radio-playwright-results-${process.pid}`,
  use: {
    headless: true,
    timezoneId: "America/New_York",
  },
  projects: [
    {
      name: "frontend",
      testIgnore: /native-playback\.spec\.mjs$/,
      use: { baseURL },
    },
    {
      name: "native-playback",
      testMatch: /native-playback\.spec\.mjs$/,
      use: { baseURL: twoTrackURL },
    },
  ],
  webServer: [
    {
      command: "bash scripts/start-browser-fixture.sh",
      url: `${baseURL}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ZAK_RADIO_BROWSER_PORT: String(browserPort),
        ZAK_RADIO_TWO_TRACK_FIXTURE: "0",
      },
    },
    {
      command: "bash scripts/start-browser-fixture.sh",
      url: `${twoTrackURL}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ZAK_RADIO_BROWSER_PORT: String(twoTrackPort),
        ZAK_RADIO_TWO_TRACK_FIXTURE: "1",
      },
    },
  ],
});
