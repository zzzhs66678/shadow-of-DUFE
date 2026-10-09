import { defineConfig } from "@playwright/test";

// Dedicated local dev runner: intentionally never invokes build or the shared server.
export default defineConfig({
  testDir: "./e2e", testMatch: "hub-experience.spec.ts", workers: 1, timeout: 60_000,
  expect: { timeout: 15_000 }, reporter: "line",
  outputDir: "../test-results/hub-experience",
  projects: [
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
  ],
  use: { baseURL: process.env.HUB_EXPERIENCE_URL ?? "http://localhost:3110", channel: "chrome", timezoneId: "Asia/Shanghai", viewport: { width: 390, height: 844 }, trace: "retain-on-failure" },
  webServer: process.env.HUB_EXPERIENCE_URL ? undefined : {
    command: "npm run dev -- --host 127.0.0.1 --port 3110", cwd: "..",
    url: "http://localhost:3110", reuseExistingServer: false, timeout: 120_000,
  },
});
