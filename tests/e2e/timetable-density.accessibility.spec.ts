import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

type Meeting = { id: string; term: string; title: string; teacher: string; weekday: number; block: number; building: string; room: string; classNames: string };
const catalog = JSON.parse(readFileSync("public/data/course-data.json", "utf8")) as { schedules: Meeting[] };
const sample: Meeting[] = [];
for (const title of ["内部审计", "国家审计", "中国税收", "衍生金融工具", "大数据与财务管理实验", "人力资源管理", "案例方法与论文写作", "审计理论", "高级财务会计", "体能提升课（男）", "大数据平台基础(n)", "证券投资"]) {
  const options = catalog.schedules.filter(item => item.term === "fall" && item.title === title);
  const item = options.find(item => item.classNames.includes("审计2401") && !sample.some(other => other.weekday === item.weekday && other.block === item.block))
    ?? options.find(item => !sample.some(other => other.weekday === item.weekday && other.block === item.block));
  if (item) sample.push(item);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-08T00:30:00Z"));
  await page.route("**/api/auth/session", route => route.fulfill({ json: { authenticated: false } }));
  await page.addInitScript(ids => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify({
    profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: ids }],
    activePlanId: "default", activities: [], assignments: [], academicSnapshots: [], favoriteRooms: [], recentRooms: [],
  })), sample.map(item => item.id));
});

test("personal timetable keeps source, full text and direct remove/undo at compact mobile density", async ({ page }, testInfo) => {
  expect(sample.length).toBeGreaterThanOrEqual(10);
  await page.goto("/?view=schedule");
  const cards = page.locator(".week-grid .draggable-schedule");
  await expect(cards).toHaveCount(sample.length);
  await expect(page.locator('.week-grid .day-head[aria-current="date"]')).toHaveText("周四");
  await expect(page.locator('.week-grid [aria-current="date"]')).toHaveCount(1);
  await expect(page.locator('.schedule-heading-actions button')).toHaveCount(4);
  if (page.viewportSize()!.width <= 680) {
    await expect(page.locator('.schedule-heading-actions button').first()).toHaveCSS("min-height", "36px");
    await expect(page.locator('.timetable-tools button').first()).toHaveCSS("min-height", "36px");
  }
  await expect(page.locator('.week-grid article[aria-label^="手动添加："]')).toHaveCount(sample.length);
  await expect(page.locator('.week-grid article[aria-label^="教务导入："]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  for (const item of sample) {
    const card = cards.filter({ has: page.locator("strong", { hasText: item.title }) });
    await expect(card.locator("strong")).toHaveText(item.title);
    await expect(card.locator(".schedule-card-teacher-link")).toHaveText(item.teacher);
    await expect(card.locator(".schedule-card-remove")).toBeVisible();
  }
  const layout = await page.locator(".week-grid").evaluate(grid => ({
    height: grid.getBoundingClientRect().height,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    clipped: [...grid.querySelectorAll("article, article small, article a")].filter(node => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1).map(node => node.textContent),
  }));
  expect(layout.overflow).toBe(false);
  expect(layout.clipped).toEqual([]);
  if (page.viewportSize()!.width < 680) {
    await expect(cards.first().locator("strong")).toHaveCSS("font-size", "11px");
    expect(layout.height).toBeLessThan(700);
  }
  await page.screenshot({ path: testInfo.outputPath("schedule-toolbar.png"), animations: "disabled" });
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    const grid = document.querySelector(".week-grid")!;
    window.scrollTo({ top: scrollY + grid.getBoundingClientRect().top - 90, behavior: "instant" });
  });
  await page.screenshot({ path: testInfo.outputPath("personal-compact.png"), animations: "disabled" });
  const removedTitle = await cards.first().locator("strong").textContent();
  await cards.first().locator(".schedule-card-remove").click();
  await expect(cards).toHaveCount(sample.length - 1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(cards).toHaveCount(sample.length);
  await expect(cards.locator("strong", { hasText: removedTitle! })).toBeVisible();
  const dragHandle = cards.first().locator(".schedule-card-main");
  await dragHandle.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".schedule-drag-overlay")).toBeVisible();
  // KeyboardSensor attaches its document key listener in a zero-delay timer.
  // Wait for that task before sending a separate user's cancellation key.
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  await page.keyboard.press("Escape");
  await expect(page.locator(".schedule-drag-overlay")).toHaveCount(0);
  await expect(cards).toHaveCount(sample.length);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter(issue => ["serious", "critical"].includes(issue.impact ?? "")).map(issue => ({ id: issue.id, targets: issue.nodes.map(node => node.target) }))).toEqual([]);
});

test("compact rooms retain aligned left floors and a complete legible weekly grid", async ({ page }, testInfo) => {
  await page.goto("/?view=rooms");
  const floors = page.getByRole("navigation", { name: "选择楼层" });
  await floors.getByRole("button", { name: /^1 层，/ }).click();
  const room = page.locator(".floor-rooms-v5 button").filter({ has: page.locator("strong", { hasText: /^102$/ }) });
  if (page.viewportSize()!.width <= 600) {
    await expect(room.locator("strong")).toHaveCSS("font-size", "16px");
    await expect(room).toHaveCSS("min-height", "72px");
  }
  const layout = await page.evaluate(() => {
    const center = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return r.y + r.height / 2; };
    return { delta: Math.abs(center(".floor-selector > span") - center(".corridor-line > span")),
      columns: getComputedStyle(document.querySelector(".floor-rooms-v5")!).gridTemplateColumns.split(" ").length };
  });
  expect(layout.delta).toBeLessThanOrEqual(1);
  expect(layout.columns).toBe(2);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo({ top: scrollY + document.querySelector(".indoor-map")!.getBoundingClientRect().top - 90, behavior: "instant" });
  });
  await page.screenshot({ path: testInfo.outputPath("rooms-compact.png"), animations: "disabled" });
  await room.click();
  await expect(page.locator("#room-week-board [role=row]")).toHaveCount(5);
  if (page.viewportSize()!.width <= 680) await expect(page.locator("#room-week-title")).toHaveCSS("font-size", "24px");
  await expect(page.locator("#room-week-board [role=rowheader] small").first()).toHaveText("08:00–09:35");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo({ top: scrollY + document.querySelector("#room-week-board")!.getBoundingClientRect().top - 90, behavior: "instant" });
  });
  await page.screenshot({ path: testInfo.outputPath("room-week-compact.png"), animations: "disabled" });
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter(issue => ["serious", "critical"].includes(issue.impact ?? "")).map(issue => ({ id: issue.id, targets: issue.nodes.map(node => node.target) }))).toEqual([]);
  await page.getByRole("button", { name: /返回空教室/ }).click();
  await expect(floors.getByRole("button", { name: /^1 层，/ })).toHaveAttribute("aria-pressed", "true");
});
