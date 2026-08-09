import { expect, test } from "@playwright/test";

const views = [
  { name: "today", path: "/", selector: ".today-page" },
  { name: "catalog", path: "/?view=catalog", selector: ".catalog-page-v2" },
  { name: "schedule", path: "/?view=schedule", selector: ".schedule-page" },
  { name: "rooms", path: "/?view=rooms", selector: ".rooms-page" },
  { name: "personal", path: "/?view=me", selector: ".me-page" },
] as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "dufesh:student-profile:v3:anonymous",
      JSON.stringify({
        profile: null,
        skipped: true,
        plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
        activePlanId: "default",
        activities: [],
        assignments: [],
        favoriteRooms: [],
        recentRooms: [],
      }),
    );
  });
});

for (const view of views) {
  test(`${view.name} stays within the viewport`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(view.path, { waitUntil: "domcontentloaded" });
    await page
      .locator("main:not(.data-loading)")
      .waitFor({ state: "visible", timeout: 30_000 });
    await expect(page.locator(view.selector)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const layout = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      rootWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    const renderedWidth = Math.max(layout.bodyWidth, layout.rootWidth);

    expect(pageErrors).toEqual([]);
    expect(
      renderedWidth,
      `${view.name} rendered ${renderedWidth}px into a ${layout.viewportWidth}px viewport`,
    ).toBeLessThanOrEqual(layout.viewportWidth + 1);
  });
}
