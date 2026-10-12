import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { savedState, snapshot, section, meeting, exam } from "../fixtures/hub-experience.mjs";
import { whiteboardLecture } from "../fixtures/whiteboard.mjs";

test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL || (process.env.CI ? "http://localhost:3000" : "http://localhost:3107"), timezoneId: "Asia/Shanghai" });
const now = "2026-10-12T07:30:00+08:00";
const name = "数字化管理会计（DMA）II（N）";
const official = snapshot({ sections: [section({ courseName: name, teachers:["演示教师甲 / 演示教师乙"], meetings:[meeting({ weeks:Array.from({length:18},(_,i)=>i+1),weekText:"1-18周",room:"1010" })] })], exams:[exam({ date:"2026-10-13",courseName:name,seat:"18",examNumber:"演示考号001" })] });
const personalStateKey = (userId: string) => `dufesh:student-profile:v3:user:${encodeURIComponent(userId)}`;
const personalBootstrapKey = (userId: string) => `${personalStateKey(userId)}:pending-cloud-bootstrap`;
type RecordedCloudState = {
  academicSnapshots: Array<{ id: string; sections: Array<{ courseName: string }> }>;
  activities: Array<{ title: string }>;
};
async function cachedAccount(page: Page, userId: string) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || "null"), personalStateKey(userId));
}
async function importSchoolCourses(page: Page) {
  await page.getByRole("button", { name: /^(导入教务数据|更新教务数据|重新导入)$/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "导入教务数据", exact: true });
  await dialog.getByLabel("教务账号").fill("synthetic-school-student");
  await dialog.getByLabel("教务密码").fill("SyntheticSchoolPassword!");
  await dialog.getByRole("button", { name: /^(登录并自动导入|更新教务数据)$/ }).click();
  await expect(dialog).toHaveCount(0);
}
async function setup(page: Page, state = savedState(), board = true) {
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(value => localStorage.setItem("dufesh:student-profile:v3:anonymous",JSON.stringify(value)), state);
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/catalog/current") return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    return route.fulfill({ json:path === "/api/auth/session" ? {authenticated:false} : {items:path === "/api/community/whiteboard" && board ? [whiteboardLecture] : [],nextCursor:null} });
  });
  return { errors,writes };
}

for (const width of [320,390,768,1280]) {
  test(`returning local users retain their previous workspace, courses, exams and navigation at ${width}px`, async ({page}, info) => {
    await page.setViewportSize({width,height:844});
    const state = savedState({ academicSnapshots:[official],
      activities:[{id:"event-demo",title:"午间讨论",date:"2026-10-12",weekday:1,block:3,startTime:"13:10",endTime:"13:40",repeat:"none",location:"梅园A座",notes:"",color:"red"}],
      assignments:[{id:"task-demo",title:"提交小组报告",courseId:"",notes:"",completed:false,dueDate:"2026-10-12"}]
    });
    const checks = await setup(page,state);
    await page.goto("/?view=home");
    await expect(page.getByRole("button",{name:"返回东财之影首页",exact:true})).toBeVisible();
    const card = page.locator(".now-card"), exams = page.getByRole("region",{name:"最近考试",exact:true});
    await expect(page.locator(".today-page")).toHaveAttribute("data-home-mode", "workspace");
    await expect(page.getByRole("textbox", { name: "搜索课程、教师和资料", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "小白板", exact: true })).toHaveCount(0);
    await expect(card).toContainText(name); await expect(card).toContainText("演示教师甲"); await expect(card).toContainText("1010");
    await expect(exams).toContainText("演示考号001"); await expect(exams).toContainText("18");
    expect((await exams.boundingBox())!.y).toBeLessThan((await card.boundingBox())!.y);
    expect((await page.getByRole("navigation", { name: "东财常用服务", exact: true }).boundingBox())!.y).toBeLessThan((await card.boundingBox())!.y);
    await expect(page.locator(".agenda-row.activity")).toContainText("13:10–13:40");
    await expect(page.locator(".agenda-row.assignment")).toContainText("提交小组报告");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const violations = (await new AxeBuilder({page}).analyze()).violations.filter(v=>["serious","critical"].includes(v.impact||""));
    expect(violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`home-${width}.png`),fullPage:true});
    await page.locator(".unified-agenda").getByRole("button",{name:"＋ 添加日程",exact:true}).click();
    const dialog = page.getByRole("dialog",{name:"添加日程",exact:true}); await expect(dialog).toBeVisible();
    await dialog.getByRole("button",{name:"关闭",exact:true}).click();
    await page.locator("#wall-header-entry").click();
    await page.getByRole("link",{name:"← 返回今日",exact:true}).click(); await expect(card).toContainText(name);
    await page.getByRole("button",{name:"搜索全站",exact:true}).click(); await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
    expect(checks.errors).toEqual([]); expect(checks.writes).toEqual([]);
  });
}

for (const configured of [false,true]) {
  test(`empty home distinguishes a profile from a confirmed empty timetable: ${configured}`,async({page})=>{
    await setup(page,savedState({profile:{majorId:"unknown",entranceYear:2026,className:"演示班级"},academicSnapshots:configured ? [snapshot({sections:[],exams:[]})] : []}),false);
    await page.goto("/?view=home");
    await expect(page.getByRole("heading",{name:configured ? "今天没有后续课程" : "把课表导进来吧",exact:true})).toBeVisible();
    await expect(page.getByRole("region",{name:"最近考试",exact:true})).toHaveCount(0);
    await expect(page.getByRole("region",{name:"小白板",exact:true})).toHaveCount(0);
    await page.getByRole("button",{name:configured ? "打开课表" : "选择班级",exact:true}).click();
    if (configured) await expect(page.locator(".schedule-page")).toBeVisible();
    else await expect(page.getByRole("dialog",{name:"选择班级",exact:true})).toBeVisible();
  });
}

test("a next-day course is labelled with its weekday",async({page})=>{
  const next = snapshot({sections:[section({meetings:[meeting({weekday:2,weeks:Array.from({length:18},(_,i)=>i+1),weekText:"1-18周"})]})],exams:[]});
  await setup(page,savedState({academicSnapshots:[next]}),false); await page.goto("/?view=home");
  await expect(page.locator(".now-card > header")).toContainText("下一节课 · 周二");
});

test("logging in restores the previous workspace only after the account's cloud courses are read", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  const userId = "restored-workspace-fixture";
  const cloud = { ...savedState({ academicSnapshots: [official] }), preferredTerm: "fall", theme: "system" };
  let authenticated = false;
  let releaseCloud!: () => void;
  const cloudGate = new Promise<void>(resolve => { releaseCloud = resolve; });
  const writes: unknown[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/catalog/current") return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (path === "/api/auth/login") {
      authenticated = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/auth/session") return route.fulfill({ json: {
      authenticated, user: authenticated ? { id: userId, username: "returning-student", displayName: "返回同学", role: "user" } : null,
      session: authenticated ? { expiresAt: "2099-01-01T00:00:00Z", deviceId: null } : undefined,
      login: { credentialsAvailable: true },
    } });
    if (path === "/api/auth/devices") return route.fulfill({ json: { devices: [] } });
    if (path === "/api/auth/sync") {
      if (request.method() === "GET") await cloudGate;
      else writes.push(request.postDataJSON());
      return route.fulfill({ json: { revision: 5, state: cloud, updatedAt: now } });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  // A baseline may survive while the actual account cache is absent. It must
  // not turn the missing cache into a deletion of existing cloud courses.
  await page.addInitScript(({ id, state }) => localStorage.setItem(`dufesh:personal-sync:v2:user:${id}`, JSON.stringify({
    schemaVersion: 1, userId: id, revision: 5, baseState: state, pendingConflicts: [], syncedAt: "2026-10-11T00:00:00Z",
  })), { id: userId, state: cloud });
  await page.goto("/");
  await expect(page.locator(".today-page")).toHaveAttribute("data-home-mode", "discovery");
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "我的", exact: true }).click();
  await page.locator(".account-center").getByRole("button", { name: "登录", exact: true }).first().click();
  await page.getByLabel("用户名或邮箱", { exact: true }).fill("returning-student");
  await page.getByLabel("密码", { exact: true }).fill("SyntheticPassword-2026!");
  await page.getByRole("button", { name: "登录并同步", exact: true }).click();
  await expect(page.locator(".account-center")).toHaveClass(/account-authenticated/);
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator(".today-page")).toHaveAttribute("data-home-mode", "workspace");
  await expect(page.getByRole("heading", { name: "正在读取你的课表…", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "添加你的课表", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "搜索课程、教师和资料", exact: true })).toHaveCount(0);
  releaseCloud();
  await expect(page.locator(".now-card")).toContainText(name);
  await expect(page.getByRole("heading", { name: "正在读取你的课表…", exact: true })).toHaveCount(0);
  await expect(page.locator(".today-page .study-management")).toContainText("编辑我的课表");
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) || "{}").academicSnapshots?.[0]?.id,
    `dufesh:student-profile:v3:user:${userId}`)).toBe(official.id);
  await page.waitForTimeout(1800);
  expect(writes).toEqual([]);
  await page.reload();
  await expect(page.locator(".today-page")).toHaveAttribute("data-home-mode", "workspace");
  await expect(page.locator(".now-card")).toContainText(name);
});

test("a failed account read stays in the workspace and reports unavailable courses instead of a new-user setup", async ({ page }) => {
  const userId = "offline-course-fixture";
  const cloud = { ...savedState({ academicSnapshots: [official] }), preferredTerm: "fall", theme: "system" };
  let offline = true;
  const writes: unknown[] = [];
  await page.addInitScript(({ id, state }) => {
    const key = `dufesh:personal-sync:v2:user:${id}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      schemaVersion: 1, userId: id, revision: 5, baseState: state, pendingConflicts: [], syncedAt: "2026-10-11T00:00:00Z",
    }));
  }, { id: userId, state: cloud });
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/catalog/current") return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (path === "/api/auth/session") return route.fulfill({ json: { authenticated: true, user: { id: userId, username: "offline-student" } } });
    if (path === "/api/auth/sync") {
      if (request.method() !== "GET") writes.push(request.postDataJSON());
      return offline ? route.fulfill({ status: 503, json: { error: "service_unavailable" } }) :
        route.fulfill({ json: { revision: 5, state: cloud, updatedAt: now } });
    }
    return route.fulfill({ json: { devices: [], items: [], nextCursor: null } });
  });
  await page.goto("/");
  await expect(page.locator(".today-page")).toHaveAttribute("data-home-mode", "workspace");
  await expect(page.getByRole("heading", { name: "账号课表暂未同步", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "添加你的课表", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "课程、教师与资料检索", exact: true })).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), `dufesh:student-profile:v3:user:${userId}`)).toBeNull();
  offline = false;
  await page.reload();
  await expect(page.locator(".now-card")).toContainText(name);
  await page.waitForTimeout(1800);
  expect(writes).toEqual([]);
});

test("a signed-in account with no saved courses uses the workspace and keeps class setup explicit", async ({ page }) => {
  const cloud = { ...savedState(), preferredTerm: "fall", theme: "system" };
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/catalog/current") return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (path === "/api/auth/session") return route.fulfill({ json: { authenticated: true, user: { id: "empty-account-fixture", username: "empty-account" } } });
    if (path === "/api/auth/sync") return route.fulfill({ json: { revision: 5, state: cloud, updatedAt: now } });
    return route.fulfill({ json: { devices: [], items: [], nextCursor: null } });
  });
  await page.goto("/");
  await expect(page.locator(".today-page")).toHaveAttribute("data-home-mode", "workspace");
  await expect(page.getByRole("heading", { name: "把课表导进来吧", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "添加你的课表", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "选择班级", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "选择班级", exact: true })).toBeVisible();
});

test("offline account edits survive refresh and merge with existing cloud courses without an empty upload", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  const userId = "offline-edit-fixture", activityTitle = "离线新增日程保留";
  let cloud = { ...savedState({ academicSnapshots: [official] }), preferredTerm: "fall", theme: "system" };
  let revision = 5, offline = true;
  const writes: RecordedCloudState[] = [];
  await page.addInitScript(({ id, state }) => {
    const key = `dufesh:personal-sync:v2:user:${id}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      schemaVersion: 1, userId: id, revision: 5, baseState: state, pendingConflicts: [], syncedAt: "2026-10-11T00:00:00Z",
    }));
  }, { id: userId, state: cloud });
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/catalog/current") return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (path === "/api/auth/session") return route.fulfill({ json: { authenticated: true, user: { id: userId, username: "offline-editor" } } });
    if (path === "/api/auth/sync") {
      if (offline) return route.fulfill({ status: 503, json: { error: "service_unavailable" } });
      if (request.method() !== "GET") {
        cloud = request.postDataJSON().state;
        writes.push(structuredClone(cloud));
        revision += 1;
      }
      return route.fulfill({ json: { revision, state: cloud, updatedAt: now } });
    }
    return route.fulfill({ json: { devices: [], items: [], nextCursor: null } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "账号课表暂未同步", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加个人日程", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加日程", exact: true });
  await editor.getByLabel("标题", { exact: true }).fill(activityTitle);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(async () => (await cachedAccount(page, userId))?.activities?.[0]?.title).toBe(activityTitle);
  expect(await page.evaluate(key => localStorage.getItem(key), personalBootstrapKey(userId))).toBe("1");
  await page.reload();
  await expect(page.locator(".agenda-row.activity")).toContainText(activityTitle);
  expect((await cachedAccount(page, userId)).activities[0].title).toBe(activityTitle);
  offline = false;
  await page.reload();
  await expect(page.locator(".now-card")).toContainText(name);
  await expect(page.locator(".agenda-row.activity")).toContainText(activityTitle);
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes.every(state => state.academicSnapshots.some(item => item.id === official.id) &&
    state.activities.some(item => item.title === activityTitle))).toBe(true);
  expect(await page.evaluate(key => localStorage.getItem(key), personalBootstrapKey(userId))).toBeNull();
  await page.reload();
  await expect(page.locator(".now-card")).toContainText(name);
  await expect(page.locator(".agenda-row.activity")).toContainText(activityTitle);
});

test("a successful reimport during a delayed cloud read keeps the new snapshot when the old same-id response arrives", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
  const userId = "delayed-reimport-fixture", newTitle = "重新导入的课程保留";
  const freshSnapshot = snapshot({ importedAt: now, sections: [section({ courseName: newTitle,
    meetings: [meeting({ room: "202", weeks: Array.from({ length: 18 }, (_, i) => i + 1), weekText: "1-18周" })] })], exams: [] });
  let cloud = { ...savedState({ academicSnapshots: [official] }), preferredTerm: "fall", theme: "system" };
  let revision = 5, reads = 0;
  const writes: RecordedCloudState[] = [];
  let releaseCloud!: () => void;
  const gate = new Promise<void>(resolve => { releaseCloud = resolve; });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/catalog/current") return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (path === "/api/auth/session") return route.fulfill({ json: { authenticated: true, user: { id: userId, username: "reimport-editor" } } });
    if (path === "/api/auth/academic/connect") return route.fulfill({ json: { status: "imported", snapshot: freshSnapshot, trainingPlan: null } });
    if (path === "/api/auth/sync") {
      if (request.method() === "GET") { reads += 1; if (reads === 1) await gate; }
      else { cloud = request.postDataJSON().state; writes.push(structuredClone(cloud)); revision += 1; }
      return route.fulfill({ json: { revision, state: cloud, updatedAt: now } });
    }
    return route.fulfill({ json: { devices: [], items: [], nextCursor: null } });
  });
  await page.goto("/?view=catalog");
  await expect.poll(() => reads).toBe(1);
  await importSchoolCourses(page);
  await expect.poll(async () => (await cachedAccount(page, userId))?.academicSnapshots?.[0]?.sections?.[0]?.courseName).toBe(newTitle);
  expect(writes).toEqual([]);
  releaseCloud();
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes.every(state => state.academicSnapshots.find(item => item.id === freshSnapshot.id)?.sections[0]?.courseName === newTitle)).toBe(true);
  expect((await cachedAccount(page, userId)).academicSnapshots).toEqual([freshSnapshot]);
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator(".now-card")).toContainText(newTitle);
  await expect(page.locator(".today-page")).not.toContainText(name);
  await page.reload();
  await expect(page.locator(".now-card")).toContainText(newTitle);
  expect((await cachedAccount(page, userId)).academicSnapshots).toEqual([freshSnapshot]);
});

test("logging out while account A's cloud read is delayed prevents the late response from entering anonymous data", async ({ page }) => {
  const userId = "late-account-a-fixture";
  const cloud = { ...savedState({ academicSnapshots: [official] }), preferredTerm: "fall", theme: "system" };
  let authenticated = true, reads = 0, releasedResponses = 0;
  const writes: unknown[] = [];
  let releaseCloud!: () => void;
  const gate = new Promise<void>(resolve => { releaseCloud = resolve; });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/catalog/current") return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (path === "/api/auth/session") return route.fulfill({ json: { authenticated, user: authenticated ? { id: userId, username: "account-a" } : null, login: { credentialsAvailable: true } } });
    if (path === "/api/auth/logout") { authenticated = false; return route.fulfill({ json: { ok: true } }); }
    if (path === "/api/auth/sync") {
      if (request.method() !== "GET") writes.push(request.postDataJSON());
      reads += 1;
      await gate;
      releasedResponses += 1;
      await route.fulfill({ json: { revision: 5, state: cloud, updatedAt: now } }).catch(() => undefined);
      return;
    }
    return route.fulfill({ json: { devices: [], items: [], nextCursor: null } });
  });
  await page.goto("/?view=me");
  await expect.poll(() => reads).toBe(1);
  await page.getByRole("button", { name: "管理账号", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.locator(".account-center")).toHaveClass(/account-anonymous/);
  releaseCloud();
  await expect.poll(() => releasedResponses).toBe(1);
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator(".today-page")).toHaveAttribute("data-home-mode", "discovery");
  await expect(page.locator(".today-page")).not.toContainText(name);
  await page.waitForTimeout(1800);
  expect(writes).toEqual([]);
  expect(await cachedAccount(page, userId)).toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), personalBootstrapKey(userId))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("dufesh:student-profile:v3:anonymous") || "{}").academicSnapshots)).toEqual([]);
  await page.reload();
  await expect(page.locator(".today-page")).toHaveAttribute("data-home-mode", "discovery");
  await expect(page.locator(".today-page")).not.toContainText(name);
  expect(reads).toBe(1);
});

test("an unconfirmed exam page remains distinct from no exams",async({page})=>{
  await setup(page,savedState({academicSnapshots:[snapshot({...official,examStatus:"unavailable"})]}),false);
  await page.goto("/?view=home");
  await expect(page.getByRole("region",{name:"考试安排未同步",exact:true})).toContainText("尚未同步");
  await expect(page.getByRole("region",{name:"最近考试",exact:true})).toHaveCount(0);
});
