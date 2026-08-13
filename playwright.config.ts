import { defineConfig, devices } from "@playwright/test";

const localBrowserChannel = process.env.CI ? undefined : "chrome";
const webServerCommand = process.env.CI
  ? "node server.mjs"
  : "npm run build && node server.mjs";
const responsiveViewports = [
  { name: "mobile-320", viewport: { width: 320, height: 844 } },
  { name: "mobile-360", viewport: { width: 360, height: 800 } },
  { name: "mobile-375", viewport: { width: 375, height: 812 } },
  { name: "mobile-390", viewport: { width: 390, height: 844 } },
  { name: "mobile-414", viewport: { width: 414, height: 896 } },
  { name: "tablet-768", viewport: { width: 768, height: 1024 } },
  { name: "landscape-667", viewport: { width: 667, height: 375 } },
  { name: "landscape-844", viewport: { width: 844, height: 390 } },
] as const;

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
    command: webServerCommand,
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
    ...responsiveViewports.map(({ name, viewport }) => ({
      name,
      testMatch: /responsive\.spec\.ts/,
      use: { viewport },
    })),
    {
      name: "performance",
      testMatch: /performance\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 } },
    },
  ],
});
