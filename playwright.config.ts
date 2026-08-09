import { defineConfig, devices } from "@playwright/test";

const localBrowserChannel = process.env.CI ? undefined : "chrome";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : "line",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    channel: localBrowserChannel,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "desktop",
      testMatch: /accessibility\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testMatch: /accessibility\.spec\.ts/,
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "tablet",
      testMatch: /responsive\.spec\.ts/,
      use: {
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: "mobile-landscape",
      testMatch: /responsive\.spec\.ts/,
      use: {
        viewport: { width: 667, height: 375 },
      },
    },
  ],
});
