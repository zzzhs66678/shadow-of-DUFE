import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', testMatch: /catalog-native-critical-path\.spec\.mjs/,
  timeout: 180_000, expect: { timeout: 20_000 }, fullyParallel: false, workers: 1, reporter: 'line',
  outputDir: 'test-results/catalog-native',
  globalTeardown: './tests/helpers/catalog-publishing-teardown.mjs',
  use: { baseURL: 'http://127.0.0.1:3141', channel: process.env.CI ? undefined : 'chrome',
    viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai', trace: 'retain-on-failure' },
  webServer: { command: 'node tests/helpers/catalog-publishing-server.mjs', url: 'http://127.0.0.1:3141/__catalog_fixture',
    reuseExistingServer: false, timeout: 90_000, stdout: 'pipe', stderr: 'pipe', gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
});
