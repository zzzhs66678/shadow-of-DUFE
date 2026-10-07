import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Asia/Shanghai" });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-07T04:00:00Z"));
  await page.addInitScript(() => {
    const key = "dufesh:student-profile:v3:anonymous";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      profile: null, skipped: true, plans: [{ id: "default", name: "默认课表", scheduleIds: [] }], activePlanId: "default",
      activities: [{ id: "legacy", title: "旧周日例会", weekday: 7, block: 2, location: "", notes: "", color: "red" }],
      assignments: [], academicSnapshots: [], favoriteRooms: [], recentRooms: [],
    }));
  });
  await page.goto("/?view=schedule", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".schedule-page")).toBeVisible();
});

test("clock editor validates, saves one-off weekends, refreshes, edits and deletes with focus containment", async ({ page }, testInfo) => {
  const trigger = page.getByRole("button", { name: "＋ 添加日程", exact: true });
  await trigger.click();
  const editor = page.getByRole("dialog", { name: "添加日程", exact: true });
  await expect(editor.getByRole("combobox", { name: "重复", exact: true })).toHaveValue("none");
  await expect(editor.getByLabel("日期", { exact: true })).toHaveValue("2026-10-07");
  await editor.getByLabel("标题", { exact: true }).fill("周末午间讨论");
  await editor.getByLabel("日期", { exact: true }).fill("2026-10-11");
  await expect(editor.getByRole("option", { name: "每周日", exact: true })).toHaveCount(1);
  await editor.getByLabel("开始时间", { exact: true }).fill("12:05");
  await editor.getByLabel("结束时间", { exact: true }).fill("12:05");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("结束时间须晚于开始时间");
  await editor.getByLabel("结束时间", { exact: true }).fill("12:45");
  const clockLayout = await editor.locator(".editor-time-range input").evaluateAll((inputs) => inputs.map((input) => {
    const rect = input.getBoundingClientRect();
    return { top: rect.top, height: rect.height, width: rect.width };
  }));
  expect(Math.abs(clockLayout[0].top - clockLayout[1].top)).toBeLessThan(2);
  expect(clockLayout.every((item) => item.height >= 44 && item.width > 0)).toBe(true);
  const violations = (await new AxeBuilder({ page }).include(".calendar-editor").analyze()).violations.filter((item) => ["critical", "serious"].includes(item.impact ?? ""));
  expect(violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("event-editor.png") });
  await editor.getByRole("button", { name: "保存", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(editor.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(editor.getByRole("button", { name: "保存", exact: true })).toBeFocused();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator(".personal-event").filter({ hasText: "周末午间讨论" })).toContainText("12:05–12:45");
  await page.reload();
  const event = page.locator(".personal-event").filter({ hasText: "周末午间讨论" });
  await expect(event).toContainText("2026-10-11");
  await event.click();
  const edit = page.getByRole("dialog", { name: "编辑日程", exact: true });
  await expect(edit.getByLabel("开始时间", { exact: true })).toHaveValue("12:05");
  await edit.getByRole("combobox", { name: "重复", exact: true }).selectOption("weekly");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await event.click();
  await expect(edit.getByRole("combobox", { name: "重复", exact: true })).toHaveValue("weekly");
  page.once("dialog", (dialog) => dialog.dismiss());
  await edit.getByRole("button", { name: "删除", exact: true }).click();
  await expect(edit).toBeVisible();
  await expect(event).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await edit.getByRole("button", { name: "删除", exact: true }).click();
  await expect(event).toHaveCount(0);
  await page.reload();
  await expect(event).toHaveCount(0);
});

test("today orders events by clocks and marks them past only after the end", async ({ page }) => {
  await page.evaluate(() => {
    const key = "dufesh:student-profile:v3:anonymous";
    const state = JSON.parse(localStorage.getItem(key)!);
    const base = { weekday: 3, block: 2, repeat: "none", date: "2026-10-07", location: "", notes: "", color: "red" };
    state.activities = [
      { ...base, id: "future", title: "下午讨论", startTime: "13:10", endTime: "13:40" },
      { ...base, id: "past", title: "上午讨论", startTime: "09:10", endTime: "09:40" },
      { ...base, id: "ongoing", title: "午间讨论", startTime: "11:45", endTime: "12:15" },
    ];
    localStorage.setItem(key, JSON.stringify(state));
  });
  await page.goto("/");
  const rows = page.locator(".unified-agenda .agenda-row.activity");
  await expect(rows.locator("strong")).toHaveText(["上午讨论", "午间讨论", "下午讨论"]);
  await expect(rows.nth(0)).toHaveClass(/past/);
  await expect(rows.nth(1)).not.toHaveClass(/past/);
  await expect(rows.nth(2)).not.toHaveClass(/past/);
});

test("legacy weekly title edit retains unbounded recurrence and Escape returns focus", async ({ page }) => {
  const event = page.locator(".personal-event").filter({ hasText: "旧周日例会" });
  await event.click();
  const editor = page.getByRole("dialog", { name: "编辑日程", exact: true });
  await expect(editor.getByRole("combobox", { name: "重复", exact: true })).toHaveValue("weekly");
  await expect(editor.getByLabel("开始时间", { exact: true })).toHaveValue("09:55");
  await page.keyboard.press("Escape");
  await expect(event).toBeFocused();
  await event.click();
  await editor.getByLabel("标题", { exact: true }).fill("旧例会新标题");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem("dufesh:student-profile:v3:anonymous") ?? "{}").activities?.find((item: { id: string }) => item.id === "legacy"))).toMatchObject({ title: "旧例会新标题", repeat: "weekly", startTime: "09:55", endTime: "11:30" });
  const date = await page.evaluate(() => JSON.parse(localStorage.getItem("dufesh:student-profile:v3:anonymous") ?? "{}").activities.find((item: { id: string }) => item.id === "legacy").date);
  expect(date).toBeUndefined();
});
