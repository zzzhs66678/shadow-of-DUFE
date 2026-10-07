import { expect, test } from "@playwright/test";

const views = [
  { name: "today", path: "/", selector: ".today-page" },
  { name: "catalog", path: "/?view=catalog", selector: ".catalog-page-v2" },
  { name: "schedule", path: "/?view=schedule", selector: ".schedule-page" },
  { name: "rooms", path: "/?view=rooms", selector: ".rooms-page" },
  { name: "personal", path: "/?view=me", selector: ".me-page" },
  { name: "teachers", path: "/teachers", selector: "main#main-content" },
  { name: "materials", path: "/materials", selector: "main#main-content" },
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
        academicSnapshots: [],
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

test("floor navigation stays left and opens the selected room week", async ({ page }, testInfo) => {
  await page.goto("/?view=rooms", { waitUntil: "domcontentloaded" });
  const floors = page.getByRole("navigation", { name: "选择楼层" });
  await expect(floors).toBeVisible();
  const floorButtons = floors.getByRole("button");
  expect(await floorButtons.count()).toBeGreaterThan(0);
  const floorBox = await floors.boundingBox();
  const roomBox = await page.locator(".floor-canvas").boundingBox();
  expect(floorBox!.x + floorBox!.width).toBeLessThanOrEqual(roomBox!.x + 1);
  expect(Math.abs(floorBox!.y - roomBox!.y)).toBeLessThanOrEqual(1);
  const target = floorButtons.last();
  await target.click();
  await expect(target).toHaveAttribute("aria-pressed", "true");
  for (const button of await floorButtons.all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator(".indoor-map").screenshot({ path: testInfo.outputPath("left-floors.png") });
  const room = page.locator(".floor-rooms-v5 button").first();
  if (await room.count()) {
    const roomName = await room.locator("strong").textContent();
    await room.click();
    await expect(page.locator("#room-week-schedule")).toBeVisible();
    await expect(page.locator("#room-week-schedule")).toContainText(roomName!);
  }
});

test("personal course context reorders discovery without hiding schoolwide results", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-390", "covered once at the primary mobile width");

  const material = (id: string, courseTitle: string, courseId: string) => ({
    id,
    courseTitle,
    courseIds: [courseId],
    teachers: [courseTitle === "当前课程" ? "测试教师" : "其他教师"],
    colleges: ["测试学院"],
    terms: ["fall"],
    years: [1],
    tags: ["课件"],
    category: "课件",
    name: `${courseTitle}.pdf`,
    kind: "PDF",
    extension: ".pdf",
    sizeBytes: 1024,
    catalogedAt: "2026-10-05T00:00:00.000Z",
    description: `${courseTitle}资料`,
    previewable: false,
    previewUrl: "",
    downloadUrl: `/resources/${id}.pdf`,
  });
  const currentMaterial = material("current", "当前课程", "COURSE-1");
  const schoolwideMaterial = material("schoolwide", "全站课程", "COURSE-2");

  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: false }) }),
  );
  await page.route("**/api/materials?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [schoolwideMaterial],
        total: 2,
        offset: 0,
        limit: 24,
        hasMore: true,
        filters: { courses: [], teachers: [], types: [], tags: [], terms: [], years: [] },
        catalog: { total: 2, generatedAt: "2026-10-05T00:00:00.000Z" },
      }),
    }),
  );
  await page.route("**/data/resource-manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ materials: [schoolwideMaterial, currentMaterial] }),
    }),
  );
  await page.route("**/api/teachers?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], nextCursor: null }) }),
  );
  await page.addInitScript(() => {
    localStorage.setItem(
      "dufesh:student-profile:v3:anonymous",
      JSON.stringify({
        academicSnapshots: [{
          academicYear: "2026-2027",
          importedAt: "2026-10-05T00:00:00.000Z",
          sections: [{ courseCode: "COURSE-1", courseName: "当前课程", teachers: ["测试教师"] }],
        }],
        trainingPlan: { courses: [] },
      }),
    );
  });

  await page.goto("/materials", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[role="listitem"]').first()).toContainText("当前课程");
  await expect(page.locator('[role="listitem"]').first()).toContainText("本学期");
  await page.getByRole("button", { name: "全站排序" }).click();
  await expect(page.locator('[role="listitem"]').first()).toContainText("全站课程");

  await page.goto("/teachers", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("本学期教师").getByRole("button", { name: "测试教师" })).toBeVisible();
});
