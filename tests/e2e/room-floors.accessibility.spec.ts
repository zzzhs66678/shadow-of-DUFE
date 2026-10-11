import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Asia/Shanghai" });

test("real tenth-floor rooms stay separate from first-floor and wing rooms", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-10-08T00:30:00Z"));
  await page.addInitScript(() => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify({
    profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
    activePlanId: "default", activities: [], assignments: [], academicSnapshots: [], favoriteRooms: [], recentRooms: [],
  })));
  await page.goto("/?view=rooms");
  await page.getByRole("navigation", { name: "选择教学楼" }).getByRole("button", { name: /^之远楼/ }).click();
  const floors = page.getByRole("navigation", { name: "选择楼层" });
  await expect(page.locator(".floor-overview")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "整栋楼一览" })).toHaveCount(0);
  await expect(floors.locator("button b")).toHaveText(["10F", "9F", "8F", "7F", "6F", "5F", "4F", "3F", "2F", "1F"]);
  const firstFloor = floors.getByRole("button", { name: /^1 层，/ });
  const tenthFloor = floors.getByRole("button", { name: /^10 层，/ });
  await tenthFloor.click();
  await expect(tenthFloor).toHaveAttribute("aria-pressed", "true");
  await expect(firstFloor).toHaveAttribute("aria-pressed", "false");
  await expect(floors.locator("button.active")).toHaveCount(1);
  await expect(page.locator(".floor-rooms-v5 button strong")).toHaveText(["1010", "1014", "1015"]);
  const freeRooms = await page.locator(".floor-rooms-v5 button.free").count();
  await expect(tenthFloor.locator("small")).toHaveText(String(freeRooms));
  await expect(tenthFloor).toHaveAttribute("aria-label", `10 层，${freeRooms} 间空闲，共 3 间`);
  expect(await tenthFloor.locator('span[aria-hidden="true"] > i').evaluate(element => (element as HTMLElement).style.width))
    .toBe(`${Math.round(freeRooms / 3 * 100)}%`);
  await expect(page.locator(".floor-map-heading")).toContainText("之远楼 · 10 层");
  await page.screenshot({ path: testInfo.outputPath("tenth-floor.png"), fullPage: true });
  await page.locator(".floor-rooms-v5 button").filter({ hasText: "1010" }).click();
  await expect(page.getByRole("heading", { name: /之远楼.*1010/ })).toBeVisible();
  await page.getByRole("button", { name: /返回空教室/ }).click();
  await expect(tenthFloor).toHaveAttribute("aria-pressed", "true");
  await firstFloor.click();
  await expect(page.locator(".floor-rooms-v5 button strong")).toHaveText(["102", "103", "104", "105", "106", "108", "E101", "W101"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter(v => ["critical", "serious"].includes(v.impact ?? ""))).toEqual([]);
  expect(errors).toEqual([]);
});

test("global room search opens the exact room without leaving a hidden floor filter", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-08T00:30:00Z"));
  await page.addInitScript(() => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify({
    profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
    activePlanId: "default", activities: [], assignments: [], academicSnapshots: [], favoriteRooms: [], recentRooms: [],
  })));
  await page.goto("/?view=rooms");
  await expect(page.getByRole("navigation", { name: "选择楼层" })).toBeVisible();
  await page.getByRole("button", { name: "搜索全站", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索课程、资料、教师或教室", exact: true }).fill("之远楼1010");
  await page.getByRole("button", { name: /之远楼1010.*查看今天哪些时段有课/ }).click();
  await expect(page.getByRole("heading", { name: /之远楼.*1010/ })).toBeVisible();
  await page.getByRole("button", { name: /返回空教室/ }).click();
  const floors = page.getByRole("navigation", { name: "选择楼层" });
  await expect(page).toHaveURL(/room-floor=10/);
  expect(new URL(page.url()).searchParams.get("room-building")).toBe("之远楼");
  await expect(floors.getByRole("button", { name: /^10 层，/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".floor-rooms-v5 button strong")).toHaveText(["1010", "1014", "1015"]);
  await floors.getByRole("button", { name: /^1 层，/ }).click();
  await expect(page.locator(".floor-rooms-v5 button strong")).toHaveText(["102", "103", "104", "105", "106", "108", "E101", "W101"]);
  await expect(page.locator(".room-tools, input[name='room-number']")).toHaveCount(0);
});
