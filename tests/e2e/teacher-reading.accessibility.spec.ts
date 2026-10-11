import { devices, test } from "@playwright/test";
import { runTeacherReadingChecks } from "../teacher-reading.browser.mjs";

// The existing desktop/mobile projects match accessibility.spec.ts, so these
// checks run under npm run test:browser without adding another project.
test("teacher colleges and review stream preserve reading, paging, composing, and accessibility", async ({ browser, baseURL, isMobile }, testInfo) => {
  test.setTimeout(120_000);
  await runTeacherReadingChecks({
    browser,
    baseURL: baseURL ?? "http://localhost:3000",
    screenshots: testInfo.outputPath("teacher-pages"),
    widths: [isMobile ? 390 : 1280],
    contextOptions: isMobile ? devices["Pixel 5"] : {},
  });
});
