import { expect, test } from "@playwright/test";

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

test("home defers the full course index until a full workspace opens", async ({
  page,
}) => {
  const dataRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/data/course-")) dataRequests.push(pathname);
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .locator("main:not(.data-loading)")
    .waitFor({ state: "visible", timeout: 30_000 });
  await expect(page.locator(".today-page")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect(dataRequests).toContain("/data/course-core.json");
  expect(dataRequests).not.toContain("/data/course-data.json");

  const desktopNavigation = page.getByRole("navigation", {
    name: "主导航",
    exact: true,
  });
  const activeNavigation = (await desktopNavigation.isVisible())
    ? desktopNavigation
    : page.getByRole("navigation", { name: "手机主导航" });
  await activeNavigation.getByRole("button", { name: "我的课表" }).click();
  await expect(page.locator(".schedule-page")).toBeVisible({
    timeout: 30_000,
  });
  expect(dataRequests).toContain("/data/course-data.json");
});
