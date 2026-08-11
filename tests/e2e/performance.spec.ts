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
  const campusImageRequests: string[] = [];
  const fontRequests: string[] = [];
  const teacherLookupRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/data/course-")) dataRequests.push(pathname);
    if (pathname === "/api/teachers/by-schedule") {
      teacherLookupRequests.push(request.url());
    }
    if (pathname.startsWith("/images/dufe-")) {
      campusImageRequests.push(pathname);
    }
    if (request.resourceType() === "font") fontRequests.push(pathname);
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .locator("main:not(.data-loading)")
    .waitFor({ state: "visible", timeout: 30_000 });
  await expect(page.locator(".today-page")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect(dataRequests).toContain("/data/course-core.json");
  expect(dataRequests).not.toContain("/data/course-data.json");
  expect(campusImageRequests).toEqual([]);
  expect(fontRequests).toEqual([]);
  expect(teacherLookupRequests).toEqual([]);

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

test("course finder keeps its mounted result set bounded", async ({ page }) => {
  await page.goto("/?view=schedule", { waitUntil: "domcontentloaded" });
  await page
    .locator("main:not(.data-loading)")
    .waitFor({ state: "visible", timeout: 30_000 });
  await expect(page.locator(".schedule-page")).toBeVisible();
  await page.getByRole("button", { name: "＋ 添加课程" }).click();
  await expect(page.locator(".course-pool.open")).toBeVisible();

  const courseCards = page.locator(".course-pool article");
  await expect(courseCards).toHaveCount(40);
  await page.locator(".load-more-courses").click();
  await expect(courseCards).toHaveCount(80);

  const search = page.getByRole("textbox", { name: "搜索全校课程" });
  await search.fill("高等数学");
  await expect(courseCards).toHaveCount(3);
  await search.fill("");
  await expect(courseCards).toHaveCount(40);
});
