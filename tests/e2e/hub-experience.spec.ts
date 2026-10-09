import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { savedState, snapshot, section, meeting, exam, trainingPlan } from "../fixtures/hub-experience.mjs";

async function seed(page: Page, state = savedState()) {
  await page.addInitScript((value) => localStorage.setItem("dufesh:student-profile:v3:anonymous", JSON.stringify(value)), state);
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated: false } }));
  await page.route("**/api/teachers/by-schedule?*", (route) => route.fulfill({ json: { items: [] } }));
}
async function unloadPrevented(page: Page) {
  return page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
}
async function openEditor(page: Page, kind: "日程" | "作业") {
  await page.getByRole("button", { name: `＋ 添加${kind}`, exact: true }).click();
  return page.getByRole("dialog", { name: `添加${kind}`, exact: true });
}
for (const kind of ["日程", "作业"] as const) {
  test(`${kind}: pristine/erased drafts close silently; all four dirty close paths retain content when cancelled`, async ({ page }) => {
    await seed(page);
    await page.goto("/?view=schedule");
    for (const method of ["close", "cancel", "escape", "backdrop"]) {
      const editor = await openEditor(page, kind);
      const close = async () => {
        if (method === "close") await editor.getByRole("button", { name: "关闭", exact: true }).click();
        if (method === "cancel") await editor.getByRole("button", { name: "取消", exact: true }).click();
        if (method === "escape") await page.keyboard.press("Escape");
        if (method === "backdrop") await page.locator(".calendar-editor-backdrop").click({ position: { x: 1, y: 1 } });
      };
      expect(await unloadPrevented(page)).toBe(false);
      await editor.getByLabel("标题", { exact: true }).fill(`未保存${kind}`);
      expect(await unloadPrevented(page)).toBe(true);
      const confirmation = page.waitForEvent("dialog").then(async (dialog) => {
        expect(dialog.message()).toContain("未保存");
        await dialog.dismiss();
      });
      await close();
      await confirmation;
      await expect(editor.getByLabel("标题", { exact: true })).toHaveValue(`未保存${kind}`);
      await editor.getByLabel("标题", { exact: true }).fill("");
      expect(await unloadPrevented(page)).toBe(false);
      await close();
      await expect(editor).toHaveCount(0);
    }
  });
  test(`${kind}: accepted discard and successful save remove the unload guard`, async ({ page }) => {
    await seed(page);
    await page.goto("/?view=schedule");
    let editor = await openEditor(page, kind);
    await editor.getByLabel("备注").fill("仅备注也须保护");
    const confirm = page.waitForEvent("dialog").then((dialog) => dialog.accept());
    await editor.getByRole("button", { name: "关闭", exact: true }).click();
    await confirm;
    await expect(editor).toHaveCount(0);
    expect(await unloadPrevented(page)).toBe(false);
    editor = await openEditor(page, kind);
    await expect(editor.getByLabel("备注")).toHaveValue("");
    await editor.getByLabel("标题", { exact: true }).fill(`已保存${kind}`);
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(await unloadPrevented(page)).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem("dufesh:student-profile:v3:anonymous"))).toContain(`已保存${kind}`);
  });
}
test("assignment deletion asks once in both the editor and today's list", async ({ page }) => {
  await seed(page, savedState({ assignments: [{ id: "a1", title: "待删除作业", courseId: "", notes: "", completed: false, dueDate: "2026-10-09" }] }));
  await page.clock.setFixedTime(new Date("2026-10-09T10:00:00+08:00"));
  await page.goto("/");
  const row = page.locator(".agenda-row.assignment");
  await expect(row).toContainText("待删除作业");
  let confirm = page.waitForEvent("dialog").then(async (dialog) => { expect(dialog.message()).toContain("删除作业"); await dialog.dismiss(); });
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await confirm;
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑作业", exact: true });
  expect(await unloadPrevented(page)).toBe(false);
  await editor.getByLabel("标题", { exact: true }).fill("已编辑");
  confirm = page.waitForEvent("dialog").then((dialog) => dialog.dismiss());
  await editor.getByRole("button", { name: "删除", exact: true }).click();
  await confirm;
  await expect(editor).toBeVisible();
  confirm = page.waitForEvent("dialog").then((dialog) => dialog.accept());
  await editor.getByRole("button", { name: "删除", exact: true }).click();
  await confirm;
  await expect(editor).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect(await unloadPrevented(page)).toBe(false);
});
test("a late account switch removes the old draft without saving it to the next account", async ({ page }) => {
  await seed(page);
  await page.addInitScript((value) => localStorage.setItem("dufesh:student-profile:v3:user:test-b", JSON.stringify(value)), savedState());
  let reply: Route | undefined;
  await page.route("**/api/auth/session", (route) => { reply = route; });
  await page.route("**/api/auth/devices", (route) => route.fulfill({ json: { devices: [] } }));
  await page.route("**/api/auth/sync**", (route) => route.fulfill({ status: 503, json: { error: "offline" } }));
  await page.goto("/?view=schedule");
  const editor = await openEditor(page, "作业");
  await editor.getByLabel("标题", { exact: true }).fill("A的私密草稿");
  await expect.poll(() => Boolean(reply)).toBe(true);
  await reply!.fulfill({ json: { authenticated: true, user: { id: "test-b", displayName: "B", avatarUrl: null } } });
  await expect(editor).toHaveCount(0);
  expect(await unloadPrevented(page)).toBe(false);
  const next = await openEditor(page, "作业");
  await expect(next.getByLabel("标题", { exact: true })).toHaveValue("");
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).not.toContain("A的私密草稿");
});

async function importSnapshot(page: Page, account = "test-student") {
  await page.getByRole("button", { name: /^(导入教务数据|更新教务数据|重新导入)$/ }).first().click();
  await page.getByLabel("教务账号").fill(account);
  await page.getByLabel("教务密码").fill("synthetic-password");
  await page.getByRole("dialog").getByRole("button", { name: /^(登录并自动导入|更新教务数据)$/ }).click();
  await expect(page.getByLabel("教务密码")).toHaveCount(0);
}
test("successful reimport shows real changes, can close/reopen, ignores failed exams/plan and clears for another school account", async ({ page }) => {
  await seed(page);
  let round = 0;
  await page.route("**/api/auth/academic/connect", (route) => {
    round += 1;
    const next = round === 1 ? snapshot() : snapshot({
      sections: [section({ meetings: [meeting({ weekday: 2, room: "202", weeks: [9, 10] })] })],
      exams: [exam({ id: "changed-id", date: "2027-01-09", room: "302" })],
    });
    return route.fulfill({ json: round === 4 ? {
      status: "partial_imported", snapshot: { ...next, sections: [section({ meetings: [meeting({ room: "303" })] })], exams: [], examStatus: "unavailable" },
      trainingPlan: null, warning: "academic_exam_unavailable", warnings: ["academic_exam_unavailable", "academic_plan_unavailable"],
    } : { status: "imported", snapshot: next, trainingPlan: trainingPlan() } });
  });
  await page.goto("/?view=catalog");
  await importSnapshot(page);
  const summary = page.locator("summary").filter({ hasText: "教务更新变化" });
  await expect(summary).toHaveCount(0);
  await importSnapshot(page);
  await expect(summary).toContainText("2 项");
  await summary.click();
  const details = summary.locator("..");
  await expect(details).toContainText("第9-10周");
  await expect(details).toContainText("考试 · 变化");
  await expect(details).not.toContainText("考试 · 移除");
  await summary.click();
  await expect(details).not.toHaveAttribute("open");
  await summary.click();
  await expect(details).toContainText("2027-01-09");
  // A successful but unchanged refresh does not erase the last real change list.
  await importSnapshot(page);
  await expect(summary).toContainText("2 项");
  await importSnapshot(page);
  await expect(details).toContainText("不代表考试取消");
  await expect(details).toContainText("不代表课程移除");
  await expect(details).not.toContainText("考试 · 移除");
  await importSnapshot(page, "different-student");
  await expect(summary).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("dufesh:student-profile:v3:anonymous")!));
  expect(saved.plans).toEqual(savedState().plans);
  expect(Object.keys(saved)).not.toContain("academicUpdates");
});

test("native browser refresh prompts only while the editor is dirty", async ({ page }) => {
  await seed(page);
  await page.goto("/?view=schedule");
  const editor = await openEditor(page, "日程");
  await editor.getByLabel("标题", { exact: true }).fill("刷新保护");
  const confirmation = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
  });
  const navigation = page.reload({ timeout: 5_000 }).catch(() => null);
  await confirmation;
  await navigation;
  await expect(editor.getByLabel("标题", { exact: true })).toHaveValue("刷新保护");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "＋ 添加日程", exact: true })).toBeVisible();
});

test("drawer expands every conflict intersection and still allows adding the full section", async ({ page }) => {
  const catalog = JSON.parse(readFileSync("public/data/course-data.json", "utf8"));
  const chosen = catalog.schedules.find((item: { term: string; weeks: number[]; periods: number[] }) => item.term === "fall" && item.weeks.includes(9) && item.periods.length > 0);
  const imported = snapshot({ sections: [section({ courseCode: "OTHER", courseName: "真实冲突课", meetings: [
    meeting({ weekday: chosen.weekday, block: chosen.block, periods: chosen.periods, weeks: [9], room: "001" }),
    meeting({ id: "second", weekday: chosen.weekday, block: chosen.block, periods: chosen.periods, weeks: [9], room: "002" }),
  ] })], exams: [] });
  await seed(page, savedState({ academicSnapshots: [imported] }));
  await page.goto(`/?view=catalog&course=${chosen.courseId}&meeting=${chosen.id}`);
  const article = page.locator(`.offering-list article[data-section-id="${chosen.sectionId}"]`);
  await expect(article).toContainText("与当前课表冲突");
  await article.locator("summary").filter({ hasText: "查看冲突详情" }).click();
  const details = article.locator("details");
  await expect(details.getByText("真实冲突课", { exact: true })).toHaveCount(2);
  await expect(details).toContainText("第9周");
  await expect(details).not.toContainText("第1-18周");
  await expect(article.getByRole("button", { name: "加入选课方案", exact: true })).toBeEnabled();
  await article.getByRole("button", { name: "加入选课方案", exact: true }).click();
  await expect(article.getByRole("button", { name: "已添加", exact: true })).toBeDisabled();
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem("dufesh:student-profile:v3:anonymous")!));
  expect(state.academicSnapshots[0].sections[0].courseName).toBe("真实冲突课");
  expect(state.plans[0].scheduleIds).toEqual(catalog.schedules.filter((item: { sectionId: string }) => item.sectionId === chosen.sectionId).map((item: { id: string }) => item.id));
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include(".course-drawer").analyze();
    expect(audit.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
  }
});
