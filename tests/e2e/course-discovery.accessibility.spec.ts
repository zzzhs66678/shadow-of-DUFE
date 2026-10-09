import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const catalog = JSON.parse(readFileSync("public/data/course-data.json", "utf8"));
const target = catalog.schedules.find((item: any) => item.term === "fall" && item.title === "中国近现代史纲要" && item.building === "之远楼" && item.room === "303" && item.weeks.includes(6));
const targetSection = catalog.schedules.filter((item: any) => item.term === "fall" && item.sectionId === target.sectionId);
const trainingPlan = {
  schemaVersion: 1, planNumber: "TEST-NESTED", planName: "测试培养方案", majorCode: "120207", majorName: "审计学", cohortYear: 2026,
  requiredCredits: 160, earnedCredits: 96, importedAt: "2026-09-28T02:03:04.000Z",
  categories: [
    { code: "G", name: "通识选修", parentCode: null, requiredCredits: 12, earnedCredits: 2 },
    { code: "G1", name: "人文社会", parentCode: "G", requiredCredits: 4, earnedCredits: 0 },
    { code: "G11", name: "历史文化", parentCode: "G1", requiredCredits: 2, earnedCredits: 0 },
    { code: "G2", name: "艺术修养", parentCode: "G", requiredCredits: 2, earnedCredits: 0 },
  ],
  courses: [
    { courseCode: "TEST-HISTORY", courseName: "中国近现代史纲要", categoryCode: "G11", categoryName: "历史文化", attribute: "elective", credits: 2, completionStatus: "not_taken", completedTerm: "", replacementCourseCodes: [] },
    { courseCode: "TEST-ART", courseName: "艺术欣赏", categoryCode: "G2", categoryName: "艺术修养", attribute: "elective", credits: 2, completionStatus: "not_taken", completedTerm: "", replacementCourseCodes: [] },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-08T00:30:00Z"));
  await page.route("**/api/auth/session", route => route.fulfill({ json: { authenticated: false } }));
  await page.route("**/api/teachers/by-schedule?**", route => route.fulfill({ status: 404, json: {} }));
  await page.route("**/api/teachers/colleges", route => route.fulfill({ json: { items: [] } }));
  await page.route(/\/api\/teachers\?/, route => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.addInitScript(plan => {
    const key = "dufesh:student-profile:v3:anonymous";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
      activePlanId: "default", activities: [], assignments: [], academicSnapshots: [], trainingPlan: plan, favoriteRooms: [], recentRooms: [],
    }));
  }, trainingPlan);
});

test("abbreviations work in school catalog and global search without selecting a class", async ({ page }) => {
  await page.goto("/?view=catalog&tab=catalog");
  const query = page.getByPlaceholder("课程名或课程号", { exact: true });
  await query.fill("近代史");
  await expect(page.getByRole("tabpanel", { name: "课程库" })).toContainText("中国近现代史纲要");
  await query.fill("高财");
  await expect(page.getByRole("tabpanel", { name: "课程库" })).toContainText("高级财务会计");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog");
  await search.getByRole("textbox").fill("近代史");
  await expect(search).toContainText("中国近现代史纲要");
  await search.getByRole("textbox").fill("高财");
  await expect(search).toContainText("高级财务会计");
  await page.keyboard.press("Escape");
  await page.goto("/?view=schedule");
  const finder = page.getByPlaceholder("课程、简称或教师…");
  await expect(page.getByRole("heading", { name: "我的课表", exact: true })).toBeVisible();
  if (!await finder.isVisible()) await page.getByRole("button", { name: "＋ 添加课程", exact: true }).click();
  await finder.fill("高财");
  await expect(page.locator(".course-pool")).toContainText("高级财务会计");
  await finder.fill("近代史");
  await expect(page.locator(".course-pool")).toContainText("中国近现代史纲要");
});

test("a stale meeting deep link never substitutes another teacher or class", async ({ page }) => {
  const params = new URLSearchParams({ view: "rooms", room: "之远楼|303", "room-building": "之远楼", "room-date": "2026-10-08", course: target.courseId, meeting: "missing-meeting" });
  await page.goto(`/?${params}`);
  await expect(page.getByRole("dialog").locator(".offering-list > article")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText("这个教学班已不在当前课程库中");
  await page.getByRole("button", { name: "← 返回教室课表" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#room-week-schedule")).toBeVisible();
});

test("room lesson opens only the exact section and all back paths restore context", async ({ page }, testInfo) => {
  await page.goto("/?view=rooms&room-building=之远楼&room-floor=3&room-date=2026-10-08&room-block=3");
  const room = page.locator('[id="room-tile-之远楼|303"]');
  await room.click();
  const lesson = page.locator(`[id="room-lesson-${target.id}"]`);
  await expect(lesson).toBeVisible();
  await lesson.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".offering-list > article")).toHaveCount(1);
  await expect(dialog.locator(".offering-list > article")).toHaveAttribute("data-section-id", target.sectionId);
  await expect(dialog.locator(".section-meetings > span")).toHaveCount(targetSection.length);
  await expect(dialog).toContainText(target.classNames);
  await expect(dialog.getByRole("textbox", { name: "搜索教学班" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("exact-section.png") });
  const report = await new AxeBuilder({ page }).include(".course-drawer").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(report.violations.filter(item => ["critical", "serious"].includes(item.impact ?? ""))).toEqual([]);
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(lesson).toBeFocused();
  await lesson.click();
  await dialog.getByRole("button", { name: /查看其他教学班/ }).click();
  expect(await dialog.locator(".offering-list > article").count()).toBeGreaterThan(1);
  await dialog.getByRole("button", { name: "只看刚才的教学班" }).click();
  await expect(dialog.locator(".offering-list > article")).toHaveCount(1);
  await page.reload();
  await expect(dialog.locator(".offering-list > article")).toHaveAttribute("data-section-id", target.sectionId);
  await dialog.locator(".offering-list header a").click();
  await page.getByRole("link", { name: "← 返回刚才的教学班" }).click();
  await expect(dialog.locator(".offering-list > article")).toHaveAttribute("data-section-id", target.sectionId);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#room-week-schedule")).toBeVisible();
  await page.getByRole("button", { name: "← 返回空教室" }).click();
  await expect(page.getByRole("button", { name: /^3 层/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("当前查询时间", { exact: true })).toContainText("13:00");
  await expect(room).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("general electives unfold one level at a time and search reveals only matching paths", async ({ page }) => {
  await page.goto("/?view=catalog&tab=mine");
  await page.getByRole("button", { name: "查看培养方案课程" }).click();
  const plan = page.getByTestId("training-plan-window");
  const root = plan.getByRole("button", { name: /^通识选修/ });
  await expect(root).toHaveAttribute("aria-expanded", "false");
  await expect(plan.getByText("艺术欣赏", { exact: true })).toHaveCount(0);
  await root.click();
  await expect(plan.getByRole("button", { name: /^人文社会/ })).toHaveAttribute("aria-expanded", "false");
  await plan.getByRole("button", { name: /^人文社会/ }).click();
  await expect(plan.getByRole("button", { name: /^历史文化/ })).toHaveAttribute("aria-expanded", "false");
  await page.getByPlaceholder("课程名或课程号", { exact: true }).fill("近代史");
  await expect(plan.getByText("中国近现代史纲要", { exact: true })).toBeVisible();
  await expect(plan.getByRole("button", { name: /^艺术修养/ })).toHaveCount(0);
  await page.getByPlaceholder("课程名或课程号", { exact: true }).clear();
  await expect(plan.getByRole("button", { name: /^历史文化/ })).toHaveAttribute("aria-expanded", "false");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("dufesh:student-profile:v3:anonymous")!).trainingPlan);
  expect(stored.categories).toEqual(trainingPlan.categories);
  expect(stored.courses).toEqual(trainingPlan.courses);
});
