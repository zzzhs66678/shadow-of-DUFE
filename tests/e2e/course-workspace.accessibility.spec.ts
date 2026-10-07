import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const teacherId = "11111111-1111-4111-8111-111111111111";
const material = {
  id: "fixture-note", courseTitle: "会计学", courseIds: ["001"], teachers: ["李老师"],
  colleges: ["会计学院"], terms: ["fall"], years: [1], tags: ["复习"], category: "笔记",
  name: "会计学课堂笔记", kind: "document", extension: ".pdf", sizeBytes: 10240,
  catalogedAt: "2026-10-01T00:00:00Z", description: "测试资料", previewable: true,
  previewUrl: "/api/materials/fixture-note/preview", downloadUrl: "/api/materials/fixture-note/download",
};

async function setup(page: Page) {
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated: false } }));
  await page.addInitScript(() => {
    localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify({
      profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
      activePlanId: "default", activities: [], assignments: [], academicSnapshots: [], favoriteRooms: [], recentRooms: [],
    }));
  });
  await page.route("**/api/teachers/colleges", (route) => route.fulfill({ json: {
    items: [{ key: "会计学院", name: "会计学院", teacherCount: 1 }, { key: "经济学院", name: "经济学院", teacherCount: 1 }],
  } }));
  await page.route(/\/api\/teachers\?/, (route) => route.fulfill({ json: {
    items: [{ id: teacherId, displayName: "李老师", collegeName: "会计学院", courseCount: 2, reviewCount: 3, updatedAt: "2026-10-01T00:00:00Z" }], nextCursor: null,
  } }));
  await page.route(/\/api\/materials\?/, (route) => route.fulfill({ json: {
    items: [material], total: 1, offset: 0, limit: 24, hasMore: false,
    filters: { courses: ["会计学"], teachers: ["李老师"], types: ["document"], tags: ["复习"], terms: ["fall"], years: [1] },
    catalog: { total: 1, generatedAt: "2026-10-01T00:00:00Z" },
  } }));
}

async function assertLayout(page: Page) {
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: "课程", exact: true })).toHaveCount(1);
  await expect(page.getByRole("tablist", { name: "课程、教师与资料" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(report.violations.filter((issue) => issue.impact === "critical" || issue.impact === "serious")).toEqual([]);
}

test("course center keeps four sections, queries, browser history and one shell", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page);
  await page.goto("/?view=catalog&tab=mine&v=workspace-test");
  await expect(page.getByRole("tabpanel", { name: "我的课程" })).toBeVisible();
  await page.getByRole("tab", { name: /^课程库/ }).click();
  await expect(page.getByRole("tab", { name: /^课程库/ })).toHaveAttribute("aria-selected", "true");
  await page.getByPlaceholder("课程名或课程号", { exact: true }).fill("会计");
  await page.getByRole("tab", { name: /^教师评价/ }).click();
  await expect(page.getByRole("button", { name: /会计学院.*1/ })).toBeVisible();
  await page.getByRole("button", { name: /会计学院.*1/ }).click();
  await expect(page.getByRole("link", { name: /李老师/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /李老师/ })).toHaveAttribute("href", `/teachers/${teacherId}`);
  await expect(page).toHaveURL(/view=catalog.*tab=teachers/);
  await assertLayout(page);
  await page.screenshot({ path: testInfo.outputPath("teachers.png"), fullPage: true });
  await page.getByRole("tab", { name: /^学习资料/ }).click();
  await page.getByRole("searchbox", { name: /搜索资料/ }).fill("会计");
  await expect(page.getByRole("link", { name: "会计学课堂笔记", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /下载/ }).first()).toHaveAttribute("href", material.downloadUrl);
  await expect(page).toHaveURL(/tab=materials/);
  await assertLayout(page);
  await page.screenshot({ path: testInfo.outputPath("materials.png"), fullPage: true });
  await page.getByRole("tab", { name: /^课程库/ }).click();
  await expect(page.getByPlaceholder("课程名或课程号", { exact: true })).toHaveValue("会计");
  await page.goBack();
  await expect(page.getByRole("tab", { name: /^学习资料/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox", { name: /搜索资料/ })).toHaveValue("会计");
  await page.goBack();
  await expect(page.getByRole("tab", { name: /^教师评价/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("combobox", { name: /学院/ })).toHaveValue("会计学院");
  await page.reload();
  await expect(page.getByRole("link", { name: /李老师/ })).toBeVisible();
  await expect(page).toHaveURL(/v=workspace-test/);
  await page.getByRole("tab", { name: /^教师评价/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /^学习资料/ })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: /^我的课程/ })).toBeFocused();
  expect(errors).toEqual([]);
});

test("late material pages cannot replace a new search or navigate a switched tab", async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname === "/api/materials") {
        const options: RequestInit = { ...init };
        delete options.signal;
        return original(input, options);
      }
      return original(input, init);
    };
  });
  let releaseOld!: () => void;
  let sawOld!: () => void;
  const oldRequested = new Promise<void>((resolve) => { sawOld = resolve; });
  const oldReleased = new Promise<void>((resolve) => { releaseOld = resolve; });
  await page.route(/\/api\/materials\?/, async (route) => {
    const url = new URL(route.request().url());
    const late = url.searchParams.has("offset");
    if (late) { sawOld(); await oldReleased; }
    const fresh = url.searchParams.get("q") === "新结果";
    await route.fulfill({ json: {
      items: [{ ...material, id: late ? "late" : fresh ? "fresh" : material.id, name: late ? "过期分页不得出现" : fresh ? "新搜索资料" : material.name }],
      total: 2, offset: late ? 1 : 0, limit: 1, hasMore: !late && !fresh,
      filters: { courses: [], teachers: [], types: [], tags: [], terms: [], years: [] },
      catalog: { total: 2, generatedAt: "2026-10-01T00:00:00Z" },
    } });
  });
  await page.goto("/?view=catalog&tab=materials");
  await page.getByRole("button", { name: "继续查看", exact: true }).click();
  await oldRequested;
  await page.getByRole("searchbox", { name: /搜索资料/ }).fill("新结果");
  await expect(page.getByRole("link", { name: "新搜索资料", exact: true })).toBeVisible();
  releaseOld();
  await expect(page.getByRole("link", { name: "过期分页不得出现", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: /^教师评价/ }).click();
  await expect(page.getByRole("button", { name: /会计学院.*1/ })).toBeVisible();
  await expect(page).toHaveURL(/view=catalog.*tab=teachers/);
  await page.getByRole("tab", { name: /^学习资料/ }).click();
  await expect(page.getByRole("searchbox", { name: /搜索资料/ })).toHaveValue("新结果");
  await expect(page.getByRole("link", { name: "新搜索资料", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "过期分页不得出现", exact: true })).toHaveCount(0);
});
