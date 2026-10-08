import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Asia/Shanghai" });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-08T00:30:00Z"));
  await page.addInitScript(() => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify({
    profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [] }],
    activePlanId: "default", activities: [], assignments: [], academicSnapshots: [], favoriteRooms: [], recentRooms: [],
  })));
  const core = {
    version: 1, catalogId: `course-v1:${"a".repeat(64)}`, disclaimer: "测试数据",
    periods: [
      { block: 1, label: "第一大节", short: "1–2节", time: "08:00–09:35" },
      { block: 2, label: "第二大节", short: "3–4节", time: "09:55–11:30" },
      { block: 3, label: "第三大节", short: "5–7节", time: "13:00–15:25" },
      { block: 4, label: "第四大节", short: "8–10节", time: "18:15–20:40" },
    ],
    buildings: ["测试楼"], colleges: [], majors: [], quality: { roomScheduleRows: 3 },
    courseTitles: [["morning", "上午课程"], ["afternoon", "下午课程"]],
    dictionaries: { teachers: ["测试教师"], timeTexts: ["1-18周"], venues: ["测试楼"], rooms: ["101", "102", "103"] },
    schedules: [
      ["morning-101", 0, 0, 0, 4, 1, [6], 0, 0, 0],
      ["afternoon-102", 0, 1, 0, 4, 3, [6], 0, 0, 1],
      ["afternoon-103", 0, 1, 0, 4, 3, [6], 0, 0, 2],
      ["other-week-102", 0, 0, 0, 4, 2, [7], 0, 0, 1],
      ["other-day-103", 0, 0, 0, 5, 1, [6], 0, 0, 2],
    ],
  } as const;
  await page.route("**/data/course-core.json*", route => route.fulfill({ json: core }));
  await page.route("**/data/course-data.json*", route => route.fulfill({ json: {
    ...core, majorCourses: [],
    courses: core.courseTitles.map(([id, title]) => ({ id, title, college: "", category: "", property: "", credits: "", textbook: "", publisher: "", author: "", terms: ["fall"], teachers: [] })),
    schedules: core.schedules.map(([id, , courseIndex, teacherIndex, weekday, block, weeks, timeIndex, buildingIndex, roomIndex]) => ({
      id, term: "fall", courseId: core.courseTitles[courseIndex][0], title: core.courseTitles[courseIndex][1],
      teacher: core.dictionaries.teachers[teacherIndex], weekday, block, weeks, periods: block === 1 ? [1, 2] : block === 2 ? [3, 4] : id === "afternoon-103" ? [6, 7] : [5, 6, 7],
      timeText: core.dictionaries.timeTexts[timeIndex], building: core.dictionaries.venues[buildingIndex], room: core.dictionaries.rooms[roomIndex], classNames: "",
    })),
  }}));
  await page.goto("/?view=rooms");
  await expect(page.locator(".floor-rooms-v5 button")).toHaveCount(3);
});

test("morning visitors can query afternoon before the room list and return to now", async ({ page }) => {
  const filter = page.getByRole("region", { name: "查询时间", exact: true });
  const times = filter.getByRole("group", { name: "选择时段" });
  const context = page.getByLabel("当前查询时间", { exact: true });
  await expect(times.getByRole("button", { name: "08:00", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(filter.getByRole("button", { name: "回到当前" })).toHaveCount(0);
  await expect(page.locator(".floor-rooms-v5 .free")).toHaveCount(2);
  await expect(page.locator(".floor-rooms-v5 .free").filter({ hasText: "102" }).locator("span")).toHaveText("下节课 13:00");
  await expect(page.locator(".floor-rooms-v5 .free").filter({ hasText: "103" }).locator("span")).toHaveText("下节课 13:50");
  const layout = await times.getByRole("button").evaluateAll(buttons => buttons.map(button => {
    const { y, width, height } = button.getBoundingClientRect();
    return { y, width, height };
  }));
  expect(layout).toHaveLength(4);
  expect(new Set(layout.map(button => button.y)).size).toBe(1);
  for (const button of layout) {
    expect(button.width).toBeGreaterThanOrEqual(44);
    expect(button.height).toBeGreaterThanOrEqual(44);
  }
  expect((await page.locator(".floor-rooms-v5 button").first().boundingBox())!.y).toBeLessThan(450);
  await expect(page.getByRole("button", { name: "测试楼，2 间空闲", exact: true })).toHaveAttribute("aria-pressed", "true");
  await filter.locator("summary").click();
  await expect(filter.getByLabel("日期", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await filter.getByLabel("日期", { exact: true }).press("Escape");
  await expect(filter.getByLabel("日期", { exact: true })).toBeHidden();
  await expect(filter.locator("summary")).toBeFocused();
  await expect(page.locator(".room-tools, .room-intents, .room-recommendations, input[name='room-number']")).toHaveCount(0);
  expect((await filter.boundingBox())!.y).toBeLessThan((await page.locator(".building-tabs").boundingBox())!.y);
  const afternoon = times.getByRole("button", { name: "13:00", exact: true });
  await afternoon.click();
  await expect(context).toContainText("13:00–15:25");
  await expect(afternoon).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".floor-rooms-v5 .free")).toHaveCount(1);
  await expect(page.locator(".floor-rooms-v5 .free strong")).toHaveText("101");
  await expect(page.locator(".floor-rooms-v5 .free span")).toHaveCount(0);
  await expect(page.locator(".building-tabs b")).toHaveText("1");
  await expect(page.locator(".floor-selector small")).toHaveText("1");
  const navigation = page.getByRole("navigation", { name: /^(手机)?主导航$/ });
  await navigation.getByRole("button", { name: "今天", exact: true }).click();
  await navigation.getByRole("button", { name: "空教室", exact: true }).click();
  await expect(afternoon).toHaveAttribute("aria-pressed", "true");
  await expect(context).not.toContainText("现在");
  await filter.locator("summary").click();
  await filter.getByRole("button", { name: "明天", exact: true }).click();
  await expect(filter.locator("summary")).toContainText("明天");
  await expect(context).toContainText("13:00–15:25");
  await expect(page.locator(".floor-rooms-v5 .free")).toHaveCount(3);
  await expect(page.locator(".floor-rooms-v5 .free span")).toHaveCount(0);
  await filter.getByRole("button", { name: "回到当前", exact: true }).click();
  await expect(filter.locator("summary")).toContainText("今天");
  await expect(context).toContainText("08:00–09:35");
  await expect(page.locator(".floor-rooms-v5 .free")).toHaveCount(2);
  await filter.locator("summary").click();
  await filter.getByLabel("日期", { exact: true }).fill("2027-08-01");
  await expect(filter.getByRole("status")).toContainText("不在当前学期");
  await expect(page.locator(".floor-rooms-v5 .free")).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).include('.rooms-page').analyze();
  expect(axe.violations.filter(v => ["critical", "serious"].includes(v.impact ?? ""))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("each time button queries only its own period and keeps room week access", async ({ page }) => {
  const times = page.getByRole("group", { name: "选择时段" });
  await times.getByRole("button", { name: "13:00", exact: true }).click();
  await expect(page.getByLabel("当前查询时间", { exact: true })).toContainText("13:00–15:25");
  await expect(page.locator(".floor-rooms-v5 .free")).toHaveCount(1);
  await times.getByRole("button", { name: "09:55", exact: true }).click();
  await expect(page.getByLabel("当前查询时间", { exact: true })).toContainText("09:55–11:30");
  await expect(page.locator(".floor-rooms-v5 .free")).toHaveCount(3);
  await times.getByRole("button", { name: "18:15", exact: true }).click();
  await expect(page.getByLabel("当前查询时间", { exact: true })).toContainText("18:15–20:40");
  await expect(page.locator(".floor-rooms-v5 .free")).toHaveCount(3);
  await expect(page.locator(".floor-rooms-v5 .free span")).toHaveCount(0);
  await page.locator(".floor-rooms-v5 button").first().click();
  await expect(page.locator("#room-week-schedule")).toBeVisible();
  await expect(page.locator("#room-week-schedule")).toContainText("上午课程");
  await page.getByRole("button", { name: /返回空教室/ }).click();
  await expect(page.locator(".floor-rooms-v5 button")).toHaveCount(3);
  await expect(page.getByLabel("当前查询时间", { exact: true })).toContainText("18:15–20:40");
  await expect(page.locator(".room-tools")).toHaveCount(0);
});
