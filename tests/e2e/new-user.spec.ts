import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { savedState, snapshot, section, meeting } from "../fixtures/hub-experience.mjs";

type Schedule = {
  id: string; sectionId: string; courseId: string; term: string; title: string;
  classNames: string; teacher: string; weekday: number; block: number;
  periods: number[]; weeks: number[]; building: string; room: string; timeText: string;
};
type Major = { id: string; name: string; college: string; aliases: string[] };
const catalog = JSON.parse(readFileSync("public/data/course-data.json", "utf8")) as {
  schedules: Schedule[]; majors: Major[];
};
const storageKey = "dufesh:student-profile:v3:anonymous";
const classes = (value: string) => value.split(/[、，,；;]/).map(item => item.trim()).filter(Boolean);

// Derive the class and every expected meeting from the source catalog. Prefer a
// section with several meetings and several effective-week sets so importing
// only its first row cannot make this test pass.
const candidates = catalog.majors.flatMap(major => [...new Set(catalog.schedules
  .flatMap(item => classes(item.classNames))
  .filter(name => major.aliases.some(alias => name.startsWith(`${alias}25`))))]
  .map(className => {
    const schedules = catalog.schedules.filter(item => item.term === "fall" && classes(item.classNames).includes(className));
    const sections = new Map<string, Schedule[]>();
    for (const item of schedules) sections.set(item.sectionId, [...(sections.get(item.sectionId) ?? []), item]);
    return { major, className, schedules, varied: [...sections.values()].some(items =>
      items.length > 1 && new Set(items.map(item => item.weeks.join(","))).size > 1) };
  })).filter(item => item.schedules.length > 0);
const selected = candidates.find(item => item.varied);
if (!selected) throw new Error("Source catalog needs a 2025 fall class with a multi-meeting section and distinct effective weeks");
const chosen = selected;
const courseCount = new Set(chosen.schedules.map(item => item.courseId)).size;
const expectedIds = chosen.schedules.map(item => item.id);

async function prepare(page: Page, state?: ReturnType<typeof savedState>) {
  await page.clock.setFixedTime(new Date("2026-10-12T00:30:00Z"));
  await page.route("**/api/auth/session", route => route.fulfill({ json: { authenticated: false } }));
  await page.route("**/api/teachers/by-schedule?**", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/teachers/colleges", route => route.fulfill({ json: { items: [] } }));
  await page.route(/\/api\/teachers\?/, route => route.fulfill({ json: { items: [], nextCursor: null } }));
  if (state) await page.addInitScript(({ key, value }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
  }, { key: storageKey, value: state });
}

async function stored(page: Page, key = storageKey) {
  return page.evaluate(value => JSON.parse(localStorage.getItem(value)!), key);
}

async function selectClass(dialog: Locator) {
  await dialog.getByLabel("入学年份", { exact: true }).selectOption("2025");
  await dialog.getByLabel("学院", { exact: true }).selectOption(chosen.major.college);
  await dialog.getByLabel("专业", { exact: true }).selectOption(chosen.major.id);
  await dialog.getByLabel("班级", { exact: true }).selectOption(chosen.className);
}

async function openClassSetup(page: Page, fromHome = true) {
  if (fromHome) await page.getByRole("button", { name: "按班级添加", exact: true }).click();
  else await page.getByRole("button", { name: /^(修改班级|导入班级课程)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "按班级添加课程", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("入学年份", { exact: true })).toBeVisible();
  return dialog;
}

test("a clean first visit is usable at 320/390/1280px without a modal or eager full index", async ({ page }, testInfo) => {
  await prepare(page);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "添加你的课表", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const search = page.getByRole("textbox", { name: "搜索课程、教师和资料", exact: true });
  await expect(search).toBeVisible();
  await expect(page.getByRole("link", { name: "教师评价", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "课程资料", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "手动选课", exact: true })).toBeVisible();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    expect(await search.evaluate(input => input.getBoundingClientRect().bottom)).toBeLessThan(900);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(audit.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`first-visit-${width}.png`), animations: "disabled" });
  }
  expect(requests).toContain("/data/course-core.json");
  expect(requests).not.toContain("/data/course-data.json");
  expect(requests).not.toContain("/api/teachers/by-schedule");
  expect(errors).toEqual([]);
  await expect(page.locator(".today-page")).not.toContainText("先选专业和班级");
  await expect(page.locator(".today-page")).not.toContainText("接下来七天还没有安排");
});

test("home search submits a real query by Enter and by button, then opens the exact course", async ({ page }) => {
  await prepare(page);
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "搜索课程、教师和资料", exact: true });
  const course = catalog.schedules.find(item => item.title === "中国近现代史纲要")!;
  expect(course).toBeTruthy();
  for (const method of ["enter", "button"]) {
    await input.fill("近代史");
    if (method === "enter") await input.press("Enter");
    else await page.getByRole("search").getByRole("button", { name: "搜索", exact: true }).click();
    const search = page.getByRole("dialog", { name: "全站搜索", exact: true });
    await expect(search.getByRole("textbox")).toHaveValue("近代史");
    await expect(search).toContainText(course.title);
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
  }
  await input.press("Enter");
  const search = page.getByRole("dialog", { name: "全站搜索", exact: true });
  await search.getByRole("button").filter({ has: page.locator("strong", { hasText: course.title }) }).first().click();
  await expect(page.locator(".course-drawer")).toContainText(course.title);
  expect(new URL(page.url()).searchParams.get("course")).toBe(course.courseId);
  await expect(page.getByRole("dialog", { name: "按班级添加课程", exact: true })).toHaveCount(0);
});

test("class setup starts unselected; close, Escape and backdrop restore focus without saving or reopening", async ({ page }, testInfo) => {
  await prepare(page);
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "按班级添加", exact: true });
  for (const method of ["escape", "backdrop", "close"]) {
    const dialog = await openClassSetup(page);
    await expect(dialog.getByRole("combobox")).toHaveCount(4);
    await expect(dialog.getByLabel("入学年份", { exact: true })).toHaveValue("");
    await selectClass(dialog);
    await expect(dialog).toContainText(`${courseCount} 门课程`);
    await expect(dialog).toContainText(`${expectedIds.length} 个上课时段`);
    if (method === "escape") {
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await dialog.evaluate(element => { element.scrollTop = 0; });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`class-preview-${width}.png`), animations: "disabled" });
        const audit = await new AxeBuilder({ page }).analyze();
        expect(audit.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.keyboard.press("Escape");
    } else if (method === "backdrop") await dialog.locator("..").click({ position: { x: 1, y: 1 } });
    else await dialog.getByRole("button", { name: "关闭班级设置", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const state = await stored(page);
    expect(state.profile).toBeNull();
    expect(state.plans.flatMap((plan: { scheduleIds: string[] }) => plan.scheduleIds)).toEqual([]);
  }
  await page.reload();
  await expect(trigger).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the global search shortcut cannot stack a hidden modal or leave page scrolling locked during setup", async ({ page }) => {
  await prepare(page);
  await page.goto("/");
  const dialog = await openClassSetup(page);
  await selectClass(dialog);
  for (const shortcut of ["Control+k", "Meta+k"]) {
    await page.keyboard.press(shortcut);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("班级", { exact: true })).toHaveValue(chosen.className);
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe("hidden");
  await expect(page.getByRole("button", { name: "按班级添加", exact: true })).toBeFocused();
  for (const shortcut of ["Control+k", "Meta+k"]) {
    await page.keyboard.press(shortcut);
    const search = page.getByRole("dialog", { name: "全站搜索", exact: true });
    await expect(search).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe("hidden");
  }
});

test("explicit class confirmation saves all exact meeting IDs, including distinct effective-week sets", async ({ page }) => {
  await prepare(page);
  let academicCalls = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/auth/academic/connect") academicCalls += 1; });
  await page.goto("/");
  const dialog = await openClassSetup(page);
  await selectClass(dialog);
  await dialog.getByRole("button", { name: `添加 ${courseCount} 门课程`, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await stored(page)).plans[0].scheduleIds.length).toBe(expectedIds.length);
  const state = await stored(page);
  expect(state.profile).toEqual({ entranceYear: 2025, college: chosen.major.college, majorId: chosen.major.id, className: chosen.className });
  expect([...state.plans[0].scheduleIds].sort()).toEqual([...expectedIds].sort());
  expect(state.academicSnapshots).toEqual([]);
  expect(academicCalls).toBe(0);
  const imported = catalog.schedules.filter(item => state.plans[0].scheduleIds.includes(item.id));
  expect(imported).toEqual(chosen.schedules);
  expect(new Set(imported.map(item => item.weeks.join(","))).size).toBeGreaterThan(1);
  await expect(page.getByRole("heading", { name: "添加你的课表", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await stored(page)).plans[0].scheduleIds).toEqual(state.plans[0].scheduleIds);
});

test("changing year or college clears a previously selected class before confirmation", async ({ page }) => {
  await prepare(page);
  await page.goto("/");
  const dialog = await openClassSetup(page);
  await selectClass(dialog);
  await expect(dialog.getByRole("button", { name: `添加 ${courseCount} 门课程`, exact: true })).toBeEnabled();
  await dialog.getByLabel("入学年份", { exact: true }).selectOption("2024");
  await expect(dialog.getByLabel("班级", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: /^添加 \d+ 门课程$/ })).toHaveCount(0);
  await selectClass(dialog);
  const otherCollege = catalog.majors.find(item => item.college !== chosen.major.college)!.college;
  await dialog.getByLabel("学院", { exact: true }).selectOption(otherCollege);
  await expect(dialog.getByLabel("专业", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("班级", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: /^添加 \d+ 门课程$/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect((await stored(page)).plans[0].scheduleIds).toEqual([]);
});

test("a failed optional class index can close and retry while the homepage remains usable", async ({ page }) => {
  await prepare(page);
  let requests = 0;
  await page.route("**/data/course-data.json", route => {
    requests += 1;
    return requests < 3 ? route.fulfill({ status: 503, json: { error: "synthetic_index_unavailable" } }) : route.continue();
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "按班级添加", exact: true });
  expect(requests).toBe(0);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "按班级添加课程", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("班级课程暂时没能加载");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("textbox", { name: "搜索课程、教师和资料", exact: true })).toBeVisible();
  await trigger.click();
  await expect(dialog.getByRole("alert")).toContainText("班级课程暂时没能加载");
  await dialog.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(dialog.getByLabel("入学年份", { exact: true })).toBeVisible();
  expect(requests).toBe(3);
  await expect(dialog.getByLabel("入学年份", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  expect((await stored(page)).profile).toBeNull();
  expect((await stored(page)).plans[0].scheduleIds).toEqual([]);
  await page.reload();
  await expect(trigger).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("saving only the major retains an existing manual plan and never guesses class meetings", async ({ page }) => {
  const manual = { id: "manual-original", name: "个人选课", scheduleIds: [catalog.schedules.find(item => item.term === "fall")!.id] };
  await prepare(page, savedState({ plans: [manual], activePlanId: manual.id }));
  await page.goto("/?view=schedule");
  const dialog = await openClassSetup(page, false);
  await dialog.getByLabel("入学年份", { exact: true }).selectOption("2025");
  await dialog.getByLabel("学院", { exact: true }).selectOption(chosen.major.college);
  await dialog.getByLabel("专业", { exact: true }).selectOption(chosen.major.id);
  await expect(dialog.getByLabel("班级", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "只保存专业设置", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const state = await stored(page);
  expect(state.plans).toEqual([manual]);
  expect(state.activePlanId).toBe(manual.id);
  expect(state.profile).toEqual({ entranceYear: 2025, college: chosen.major.college, majorId: chosen.major.id, className: "" });
  expect(state.academicSnapshots).toEqual([]);
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await stored(page)).plans).toEqual([manual]);
});

test("a saved major without actual courses still offers setup and manual selection without guessing teachers", async ({ page }) => {
  const profile = { entranceYear: 2025, college: chosen.major.college, majorId: chosen.major.id, className: "" };
  await prepare(page, savedState({ profile, skipped: false }));
  await page.goto("/");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "添加你的课表", exact: true })).toBeVisible();
  const dialog = await openClassSetup(page);
  await expect(dialog.getByLabel("班级", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: /^添加 \d+ 门课程$/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect((await stored(page)).plans[0].scheduleIds).toEqual([]);
  await page.getByRole("button", { name: "手动选课", exact: true }).click();
  await expect(page.locator(".schedule-page")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await stored(page)).plans[0].scheduleIds).toEqual([]);
});

test("adding a class creates another plan and preserves existing manual selections", async ({ page }) => {
  const existingId = catalog.schedules.find(item => item.term === "fall" && !expectedIds.includes(item.id))!.id;
  const plan = { id: "manual-original", name: "我的原有选课", scheduleIds: [existingId] };
  await prepare(page, savedState({ plans: [plan], activePlanId: plan.id }));
  await page.goto("/?view=schedule");
  const dialog = await openClassSetup(page, false);
  await selectClass(dialog);
  await dialog.getByRole("button", { name: `添加 ${courseCount} 门课程`, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const state = await stored(page);
  expect(state.plans.find((item: { id: string }) => item.id === plan.id)).toEqual(plan);
  expect(state.plans).toHaveLength(2);
  expect(state.activePlanId).not.toBe(plan.id);
  expect([...state.plans.find((item: { id: string }) => item.id === state.activePlanId).scheduleIds].sort()).toEqual([...expectedIds].sort());
  expect(state.academicSnapshots).toEqual([]);
});

test("official school courses remain authoritative after adding a separate class plan", async ({ page }) => {
  const official = snapshot({ sections: [section({ courseName: "合成教务课程", meetings: [meeting()] })], exams: [] });
  await prepare(page, savedState({ academicSnapshots: [official] }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "添加你的课表", exact: true })).toHaveCount(0);
  await expect(page.locator(".today-page")).toContainText("合成教务课程");
  await page.goto("/?view=schedule");
  await expect(page.locator('.week-grid article[aria-label^="教务导入："]')).toHaveCount(1);
  const dialog = await openClassSetup(page, false);
  await selectClass(dialog);
  await dialog.getByRole("button", { name: `添加 ${courseCount} 门课程`, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await stored(page)).academicSnapshots).toEqual([official]);
  await page.goto("/");
  await expect(page.locator(".today-page")).toContainText("合成教务课程");
  await page.goto("/?view=schedule");
  await expect(page.locator('.week-grid article[aria-label^="教务导入："]')).toHaveCount(1);
  await expect(page.locator('.week-grid article[aria-label^="手动添加："]')).toHaveCount(0);
});

test("a delayed authenticated session closes anonymous class choices without leaking them into the account", async ({ page }) => {
  await prepare(page);
  const accountKey = "dufesh:student-profile:v3:user:new-user-b";
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: accountKey, value: savedState() });
  let session: Route | undefined;
  await page.route("**/api/auth/session", route => { session = route; });
  await page.route("**/api/auth/devices", route => route.fulfill({ json: { devices: [] } }));
  await page.route("**/api/auth/sync**", route => route.fulfill({ status: 503, json: { error: "offline" } }));
  await page.goto("/");
  const dialog = await openClassSetup(page);
  await selectClass(dialog);
  await expect.poll(() => Boolean(session)).toBe(true);
  await session!.fulfill({ json: { authenticated: true, user: { id: "new-user-b", displayName: "合成用户 B", avatarUrl: null } } });
  await expect(dialog).toHaveCount(0);
  const next = await openClassSetup(page);
  await expect(next.getByLabel("入学年份", { exact: true })).toHaveValue("");
  await expect(next.getByLabel("班级", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  expect((await stored(page, accountKey)).profile).toBeNull();
  expect((await stored(page, accountKey)).plans[0].scheduleIds).toEqual([]);
  expect((await stored(page)).profile).toBeNull();
});
