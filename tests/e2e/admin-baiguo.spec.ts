import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";

const preview = {
  server_time: "2026-10-16T20:00:00+08:00", phase: "waiting", authentication_state: "authenticated", health_stale: false,
  last_auth_accepted_at: "2026-10-16T19:55:00+08:00", last_poll_completed_at: "2026-10-16T19:59:55+08:00",
  updated_at: "2026-10-16T20:00:00+08:00", last_auth_rejected_at: "2026-10-16T19:30:00+08:00",
  session_renewal: { status: "success", last_attempt: "2026-10-16T19:31:00+08:00", last_result: "success" },
  runtime_events: [
    { kind: "attendance", at: "2026-10-16T19:50:00+08:00", activity_id: "88", status: "pending_confirmation" },
    { kind: "attendance", at: "2026-10-16T19:40:00+08:00", activity_id: "87", status: "confirmed" },
    { kind: "renew_success", at: "2026-10-16T19:32:00+08:00" },
    { kind: "renew_started", at: "2026-10-16T19:31:00+08:00" },
    { kind: "auth_rejected", at: "2026-10-16T19:30:00+08:00" },
  ],
  automatic_submit: true, notifications_enabled: true, recent_actions: [], active_courses: [],
  schedule_revision: "synthetic-v1", monitoring: { message_seconds: 5, course_seconds: 15 },
  next_window: "2026-10-19T07:50:00+08:00",
  schedule: { timezone: "Asia/Shanghai", revision: "synthetic-v1", week1_monday: "2026-10-12", semester_weeks: 18, minutes_before: 10, minutes_after: 10, courses: [], disabled_dates: [], extra_sessions: [], cancelled_sessions: [] },
  week: { number: 1, start: "2026-10-12", end: "2026-10-18", days: Array.from({ length: 7 }, (_, index) => {
    const date = `2026-10-${12 + index}`;
    const name = ["审计学（示例）", "管理会计（示例）", "", "财务管理（示例）", "经济法（示例）", "", ""][index];
    return { date, weekday: index + 1, sessions: name ? [{ name, start: "08:00", end: "09:40", kind: "regular" }] : [], windows: name ? [{ start: `${date}T07:50:00+08:00`, end: `${date}T09:50:00+08:00`, courses: [name] }] : [] };
  }) },
};

async function mockAdmin(page: Page, { status = 200, elevated = true, seconds = 600 } = {}) {
  await page.route("**/admin/baiguo-session", route => route.fulfill({ status: status === 200 && elevated ? 200 : 403, json: { ticket: "A".repeat(43) } }));
  await page.route("**/api/admin/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let payload: object = { users: [], items: [], reports: [], announcements: [], candidates: [], events: [], requests: [], nextCursor: null };
    if (path.endsWith("/session")) payload = { role: "admin", mfaConfigured: true, elevated, elevatedUntil: new Date(Date.now() + seconds * 1000).toISOString() };
    if (path.endsWith("/overview")) payload = { overview: { totalUsers: 1, activeUsers: 1, disabledUsers: 0, administrators: 1, verifiedEmails: 1, registrationTrend: [] } };
    await route.fulfill({ status: path.endsWith("/session") ? status : 200, json: payload });
  });
}

for (const width of [320, 390, 1280]) {
  test(`embedded timetable works inside the admin workspace at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mockAdmin(page);
    const root = process.env.BAIGUO_BUNDLE;
    const dashboard = structuredClone(preview);
    let connected = false;
    const adjustments: Array<Record<string, unknown>> = [];
    await page.route("https://baiguo.dufesh.cn/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (root) {
        if (path === "/api/session") { await route.fulfill({ json: { authenticated: connected, csrf: "synthetic-csrf" } }); return; }
        if (path === "/api/login") { connected = true; await route.fulfill({ json: { authenticated: true, csrf: "synthetic-csrf" } }); return; }
        if (path === "/api/handoff/exchange") {
          expect(route.request().postDataJSON()).toEqual({ ticket: "A".repeat(43) });
          connected = true;
          await route.fulfill({ json: { authenticated: true, csrf: "synthetic-csrf" } }); return;
        }
        if (path === "/api/dashboard") { await route.fulfill({ json: dashboard }); return; }
        if (path === "/api/schedule") { adjustments.push(route.request().postDataJSON()); await route.fulfill({ json: { saved: true, revision: "synthetic-v2" } }); return; }
        const name = path === "/" ? "index.html" : path.slice(1);
        if (!["index.html", "app.js", "style.css", "dufesh-embed.js", "dufesh-embed.css"].includes(name)) throw new Error(`Unexpected Baiguo request: ${path}`);
        const body = await readFile(`${root}/web/${name}`);
        await route.fulfill({ body, contentType: name.endsWith("css") ? "text/css" : name.endsWith("js") ? "application/javascript" : "text/html", headers: { "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors https://dufesh.cn" } });
      } else {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>测试私人课表</title></head><body><main><h1>私人课表测试</h1></main><script>parent.postMessage({type:"dufesh:baiguo-ready",height:640},"https://dufesh.cn")</script></body></html>', headers: { "Content-Security-Policy": "frame-ancestors https://dufesh.cn" } });
      }
    });
    // Keep the real main origin for exact frame-ancestors and postMessage checks.
    await page.route("https://dufesh.cn/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith("/api/") || pathname === "/admin/baiguo-session") return route.fallback();
      if (pathname === "/favicon.svg") return route.fulfill({ status: 204 });
      const response = await route.fetch({ url: `${process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"}${new URL(route.request().url()).pathname}` });
      await route.fulfill({ response });
    });
    await page.goto("https://dufesh.cn/admin#users");
    await expect(page.getByRole("heading", { name: "用户管理", exact: true })).toBeVisible();
    expect(page.frames()).toHaveLength(1);
    await page.getByRole("navigation", { name: "管理功能" }).getByRole("button", { name: "白果云课表" }).click();
    await expect(page.getByRole("heading", { name: "白果云课表", exact: true })).toBeVisible();
    await expect(page.getByText("正在连接白果云课表…", { exact: true })).toBeHidden();
    const frame = page.frameLocator('iframe[title="白果云私人课表管理"]');
    if (root) {
      await expect(frame.getByRole("heading", { name: "本周课程", exact: true })).toBeVisible();
      await expect(frame.getByLabel("管理口令", { exact: true })).toBeHidden();
      await expect(frame.locator("html")).toHaveClass(/dufesh-embed/);
    } else await expect(frame.getByRole("heading", { name: "私人课表测试" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`baiguo-${width}.png`), fullPage: true });
    if (root) {
      await expect(frame.getByRole("heading", { name: "本周课程", exact: true })).toBeVisible();
      await expect(frame.getByRole("heading", { name: "账号与签到记录", exact: true })).toBeVisible();
      await expect(frame.locator("#runtime-rejected")).toContainText("19:30:00");
      await expect(frame.locator("#runtime-renewal-time")).toContainText("19:31:00");
      await expect(frame.locator("#runtime-attendance-time")).toContainText("19:40:00");
      await expect(frame.locator("#runtime-attendance-status")).toContainText("活动 87");
      await frame.locator(".runtime-history > summary").click();
      await expect(frame.locator("#runtime-events")).toContainText("签到 88 · 已提交，待确认");
      await expect(frame.locator("#runtime-events")).toContainText("自动重登已更新凭据");
      expect(await frame.locator("html").evaluate(node => node.scrollWidth <= innerWidth)).toBe(true);
      const grid = frame.locator("#week-grid");
      await expect(grid).toHaveAttribute("data-visible-days", "5");
      await expect(frame.locator(".day-column:visible")).toHaveCount(5);
      const geometry = await grid.evaluate(node => {
        const timeline = node.querySelector<HTMLElement>(".day-timeline")!;
        const course = node.querySelector<HTMLElement>(".course-block")!;
        const band = node.querySelector<HTMLElement>(".monitor-band")!;
        const scroll = node.parentElement!;
        return { height: timeline.getBoundingClientRect().height, courseTop: parseFloat(course.style.top), courseHeight: parseFloat(course.style.height), bandTop: parseFloat(band.style.top), bandHeight: parseFloat(band.style.height), width: node.getBoundingClientRect().width, available: scroll.clientWidth };
      });
      expect(geometry.height).toBe(420);
      expect(geometry.courseTop).toBeCloseTo(28);
      expect(geometry.courseHeight).toBeCloseTo(100 * 28 / 60);
      expect(geometry.bandTop).toBeCloseTo(50 * 28 / 60);
      expect(geometry.bandHeight).toBeCloseTo(120 * 28 / 60);
      expect(geometry.width).toBeLessThanOrEqual(geometry.available + 1);
      const dashboardAccessibility = await new AxeBuilder({ page }).analyze();
      expect(dashboardAccessibility.violations.filter(item => ["serious", "critical"].includes(item.impact ?? "")).map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`timetable-${width}.png`), fullPage: true });
      await frame.getByRole("button", { name: "添加补课", exact: true }).click();
      const dialog = frame.getByRole("dialog", { name: "添加一次补课" });
      await dialog.getByLabel("课程名称", { exact: true }).fill("补课（示例）");
      await dialog.getByLabel("补课日期").fill("2026-10-17");
      await dialog.getByLabel("开始时间").fill("10:00");
      await dialog.getByLabel("结束时间").fill("11:00");
      await expect.poll(async () => {
        const box = await dialog.boundingBox();
        return Boolean(box && box.y >= 0 && box.y + box.height <= 900);
      }).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`adjustment-${width}.png`) });
      await dialog.getByRole("button", { name: "添加补课", exact: true }).click();
      await expect(dialog).toBeHidden();
      expect(adjustments).toEqual([{ operation: "add", name: "补课（示例）", date: "2026-10-17", start: "10:00", end: "11:00", revision: "synthetic-v1" }]);
      await frame.getByRole("button", { name: "显示完整七天", exact: true }).click();
      await expect(frame.locator(".day-column:visible")).toHaveCount(7);
      await frame.getByRole("button", { name: "隐藏空白周末", exact: true }).click();
      await expect(frame.locator(".day-column:visible")).toHaveCount(5);
      dashboard.week.days[5].sessions.push({ name: "周末补课（示例）", start: "21:00", end: "22:30", kind: "extra" });
      dashboard.week.days[5].windows.push({ start: "2026-10-17T20:50:00+08:00", end: "2026-10-17T22:40:00+08:00", courses: ["周末补课（示例）"] });
      await frame.locator("html").evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(frame.locator(".day-column:visible")).toHaveCount(7);
      await expect(frame.getByRole("button", { name: "隐藏空白周末", exact: true })).toBeHidden();
      const weekend = frame.locator('.day-column[data-date="2026-10-17"]');
      await expect(weekend.getByRole("button", { name: /周末补课（示例）/ })).toBeAttached();
      expect(await weekend.locator(".day-timeline").evaluate(node => node.getBoundingClientRect().height)).toBe(448);
      dashboard.authentication_state = "auth_unverified";
      await frame.locator("html").evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(frame.locator("#runtime-account")).toHaveText("学校登录尚未验证");
      dashboard.health_stale = true;
      await frame.locator("html").evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(frame.locator("#runtime-account")).toContainText("当前登录与签到情况暂不能确认");
    }
    await page.getByRole("navigation", { name: "管理功能" }).getByRole("button", { name: "用户", exact: true }).click();
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.unrouteAll({ behavior: "wait" });
  });
}

for (const access of [{ status: 401 }, { status: 403 }, { elevated: false }]) {
  test(`no Baiguo document loads without valid admin elevation ${JSON.stringify(access)}`, async ({ page }) => {
    let remoteReads = 0;
    await mockAdmin(page, access);
    await page.route("https://baiguo.dufesh.cn/**", route => { remoteReads++; return route.abort(); });
    await page.goto("/admin#baiguo");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(remoteReads).toBe(0);
  });
}

test("expired elevation removes the embedded workspace", async ({ page }) => {
  await mockAdmin(page, { seconds: 2 });
  await page.route("https://baiguo.dufesh.cn/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>测试</title>" }));
  await page.goto("/admin#baiguo");
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "验证身份", exact: true })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("connection failures offer recovery without treating iframe load as success", async ({ page }) => {
  await mockAdmin(page);
  await page.route("https://baiguo.dufesh.cn/**", route => route.abort());
  await page.clock.install();
  await page.goto("/admin#baiguo");
  await expect(page.locator("iframe")).toHaveCount(1);
  await page.clock.fastForward(21_000);
  await expect(page.getByRole("button", { name: "重新载入", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "独立打开 ↗" })).toHaveAttribute("href", "https://baiguo.dufesh.cn");
});
