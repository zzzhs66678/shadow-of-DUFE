import { test, expect, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const width of [320, 390, 1280]) {
  test(`administrator workspace and user details at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const checkLayout = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(accessibility.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
    };
    const now = new Date().toISOString();
    const id = "00000000-0000-4000-8000-000000000002";
    const email = "student.long.address@example.test";
    let detailReads = 0;
    await page.route("**/api/admin/**", async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      let payload: unknown = { items: [], reports: [], announcements: [], candidates: [], events: [], requests: [], nextCursor: null };
      if (path.endsWith("/session")) payload = { role: "admin", mfaConfigured: true, elevated: true, elevatedUntil: new Date(Date.now() + 600000).toISOString() };
      if (path.endsWith("/overview")) payload = { overview: { totalUsers: 128, activeUsers: 126, disabledUsers: 2, administrators: 1, verifiedEmails: 65, registrationTrend: [{ date: now.slice(0, 10), count: 6 }] } };
      if (path.endsWith("/users")) payload = { users: [
        { id, username: "chenxu", displayName: "陈同学", emailMasked: "st***@example.test", emailVerified: false, schoolAccountVerified: false, status: "active", role: "user", createdAt: now, lastLoginAt: now },
        { id: "00000000-0000-4000-8000-000000000003", username: "linlin", displayName: "林同学", emailMasked: "li***@example.test", emailVerified: true, schoolAccountVerified: false, status: "active", role: "user", createdAt: now, lastLoginAt: now },
      ], nextCursor: null };
      if (path.endsWith("/registration")) {
        detailReads++;
        payload = { registration: { username: "chenxu", displayName: "陈同学", email, emailVerified: false, schoolAccount: "20260001", schoolAccountVerified: false, avatarUrl: null, registeredVia: "credential", createdAt: now, lastLoginAt: now, role: "user", status: "active", profile: { entranceYear: 2026, college: "会计学院", majorId: "会计学", className: "会计一班", updatedAt: now } } };
      }
      if (path.endsWith("/public-profile")) payload = { profile: { topicCount: 1, commentCount: 1 }, items: [{ id: "activity", title: "期末复习资料整理", topicTitle: "自习室开放时间", body: url.searchParams.get("kind") === "topics" ? "整理了本学期的复习资料。" : "图书馆周末正常开放。", publicPath: "/community/topics/example", createdAt: now }], nextCursor: null };
      if (path.endsWith("/reports")) payload = { reports: [{ id: "report", targetType: "comment", targetId: "comment", targetLabel: "课程讨论", targetStatus: "published", allowedActions: [], reporterUsername: "student", reasonCode: "spam", detail: "广告链接", status: "open", caseId: null, evidenceTitle: "课程讨论中的重复广告", evidenceBody: "这是一条用于界面检查的举报内容。", evidenceAuthorLabel: "测试作者", evidenceCapturedAt: now, createdAt: now }], nextCursor: null };
      if (path.endsWith("/content")) payload = { items: [{ id: "content", type: "topic", title: "校园二手书交换", body: "交换教材，请注明版本。", authorLabel: "陈同学", status: "published", publicPath: "/community/topics/example", caseId: null, createdAt: now, updatedAt: now, allowedActions: [] }], nextCursor: null };
      if (path.endsWith("/audit")) payload = { events: [{ id: "audit", action: "admin.user.registration_viewed", targetId: id, createdAt: now, metadata: {} }] };
      await route.fulfill({ json: payload });
    });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();
    expect(detailReads).toBe(0);
    await checkLayout();
    const nav = page.getByRole("navigation", { name: "管理功能" });
    await page.screenshot({ path: testInfo.outputPath(`users-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "查看资料", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "陈同学" });
    await expect(dialog.getByText(email, { exact: true })).toBeVisible();
    expect(detailReads).toBe(1);
    await expect(dialog.getByText("会计一班", { exact: true })).toBeVisible();
    await expect(dialog.getByText("学号", { exact: true })).toBeVisible();
    await expect(dialog.getByText("20260001", { exact: true })).toBeVisible();
    await expect(dialog.getByText("校园账号", { exact: true })).toHaveCount(0);
    await checkLayout();
    await page.screenshot({ path: testInfo.outputPath(`detail-${width}.png`) });
    await dialog.getByRole("button", { name: "主题", exact: true }).click();
    await expect(dialog.getByText("整理了本学期的复习资料。", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "回复", exact: true }).click();
    await expect(dialog.getByText("图书馆周末正常开放。", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "账号资料" }).click();
    await expect(dialog.getByText(email, { exact: true })).toBeVisible();
    expect(detailReads).toBe(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await nav.getByRole("button", { name: "内容审核", exact: true }).click();
    await expect(page.getByRole("heading", { name: "举报处理", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "注册用户", exact: true })).toBeHidden();
    await checkLayout();
    await page.screenshot({ path: testInfo.outputPath(`review-${width}.png`), fullPage: true });
    await page.getByRole("navigation", { name: "审核分类" }).getByRole("button", { name: "主题与回复" }).click();
    await expect(page.getByText("校园二手书交换", { exact: true })).toBeVisible();
    await checkLayout();
    await page.screenshot({ path: testInfo.outputPath(`content-${width}.png`), fullPage: true });
    await page.reload();
    await expect(page.getByRole("heading", { name: "主题与回复", exact: true })).toBeVisible();
    await nav.getByRole("button", { name: "通知", exact: true }).click();
    await page.getByLabel("通知标题").fill("测试草稿");
    await nav.getByRole("button", { name: "用户", exact: true }).click();
    await nav.getByRole("button", { name: "通知", exact: true }).click();
    await expect(page.getByLabel("通知标题")).toHaveValue("测试草稿");
    await checkLayout();
    await page.screenshot({ path: testInfo.outputPath(`notices-${width}.png`), fullPage: true });
    await nav.getByRole("button", { name: "操作记录", exact: true }).click();
    await expect(page.getByText("已查看用户注册资料", { exact: true })).toBeVisible();
    await checkLayout();
    expect(errors).toEqual([]);
  });
}

test("a refreshed name-change queue ignores a late pagination response", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const makeEntry = (id: string, displayName: string) => ({ id, userId: id, username: id, displayName, requestedUsername: null, requestedDisplayName: `${displayName}申请`, status: "pending", reason: null, createdAt: new Date().toISOString(), reviewedAt: null });
  const previous = makeEntry("00000000-0000-4000-8000-000000000041", "旧队列");
  const newest = makeEntry("00000000-0000-4000-8000-000000000042", "新队列");
  let heldPage: Route | null = null;
  let reads = 0;
  await page.route("**/api/admin/**", async route => {
    const url = new URL(route.request().url());
    let payload: unknown = { users: [], items: [], reports: [], announcements: [], candidates: [], events: [], requests: [], nextCursor: null };
    if (url.pathname.endsWith("/session")) payload = { role: "admin", mfaConfigured: true, elevated: true, elevatedUntil: new Date(Date.now() + 600000).toISOString() };
    if (url.pathname.endsWith("/overview")) payload = { overview: { totalUsers: 0, activeUsers: 0, disabledUsers: 0, administrators: 1, verifiedEmails: 0, registrationTrend: [] } };
    if (url.pathname === "/api/admin/name-changes") {
      expect(url.searchParams.get("limit")).toBe("20");
      if (url.searchParams.has("cursor")) {
        expect(url.searchParams.get("cursor")).toBe("synthetic-next-page");
        heldPage = route;
        return;
      }
      reads += 1;
      payload = reads === 1 ? { requests: [previous], nextCursor: "synthetic-next-page" } : { requests: [newest], nextCursor: null };
    }
    await route.fulfill({ json: payload });
  });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "用户管理", exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: /^改名申请$/ }).click();
  const desk = page.getByRole("region", { name: "改名申请", exact: true });
  await desk.getByRole("button", { name: "加载更多改名申请", exact: true }).click();
  await expect.poll(() => Boolean(heldPage)).toBe(true);
  await desk.getByRole("button", { name: "刷新申请", exact: true }).click();
  await expect(desk.getByRole("button", { name: "审核改名申请：新队列", exact: true })).toBeVisible();
  // The refresh aborts the superseded page; fulfilling it cannot append old rows.
  await (heldPage as Route | null)?.fulfill({ json: { requests: [previous], nextCursor: null } }).catch(() => undefined);
  await expect(desk.getByRole("button", { name: "审核改名申请：旧队列", exact: true })).toHaveCount(0);
  await expect(desk.getByRole("button", { name: "审核改名申请：新队列", exact: true })).toBeVisible();
});

for (const width of [320, 390, 1280]) {
  test(`name changes require explicit review and renewed MFA at ${width}px`, async ({ page, context, baseURL }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const now = new Date().toISOString();
    const entries = ["陈同学", "林同学", "沈同学"].map((displayName, index) => ({
      id: `00000000-0000-4000-8000-00000000001${index}`,
      userId: `00000000-0000-4000-8000-00000000002${index}`,
      username: `student-${index}`, displayName,
      requestedUsername: index === 0 ? "beach-student" : null,
      requestedDisplayName: `海边自习${index}`, status: "pending", reason: null as string | null,
      createdAt: now, reviewedAt: null as string | null,
    }));
    const reviews: { id: string; body: Record<string, unknown> }[] = [];
    let queueReads = 0;
    const errors: string[] = [];
    await context.addCookies([{ name: "synthetic_admin_session", value: "same-session", url: baseURL! }]);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/admin/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      let payload: unknown = { items: [], reports: [], announcements: [], candidates: [], events: [], requests: [], nextCursor: null };
      if (path.endsWith("/session")) payload = { role: "admin", mfaConfigured: true, elevated: true, elevatedUntil: new Date(Date.now() + 600000).toISOString() };
      if (path.endsWith("/overview")) payload = { overview: { totalUsers: 3, activeUsers: 3, disabledUsers: 0, administrators: 1, verifiedEmails: 3, registrationTrend: [] } };
      if (path.endsWith("/users")) payload = { users: [], nextCursor: null };
      if (path === "/api/admin/name-changes") {
        queueReads += 1;
        expect(url.searchParams.get("limit")).toBe("20");
        payload = { requests: entries, nextCursor: null };
      }
      if (path.endsWith("/review")) {
        const id = path.split("/").at(-2)!;
        const body = request.postDataJSON();
        reviews.push({ id, body });
        const headers = await request.allHeaders();
        expect(request.method()).toBe("POST");
        expect(headers.origin).toBe(url.origin);
        expect(headers.cookie).toContain("synthetic_admin_session=same-session");
        if (id === entries[2].id) {
          await route.fulfill({ status: 403, json: { error: "admin_mfa_required" } });
          return;
        }
        const entry = entries.find(item => item.id === id)!;
        entry.status = body.decision === "approve" ? "approved" : "rejected";
        entry.reason = body.reason ?? null;
        entry.reviewedAt = now;
        payload = { request: entry };
      }
      if (path.endsWith("/audit")) payload = { events: reviews.filter(item => item.id !== entries[2].id).map((item, index) => ({ id: `name-audit-${index}`, action: item.body.decision === "approve" ? "admin.account_name.approved" : "admin.account_name.rejected", createdAt: now, metadata: {} })) };
      await route.fulfill({ json: payload });
    });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "用户管理", exact: true })).toBeVisible();
    expect(queueReads).toBe(0);
    await page.locator("summary").filter({ hasText: /^改名申请$/ }).click();
    const desk = page.getByRole("region", { name: "改名申请", exact: true });
    await desk.getByRole("button", { name: "审核改名申请：陈同学", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "审核改名申请", exact: true });
    await expect(dialog.getByText("@student-0", { exact: true })).toBeVisible();
    await expect(dialog.getByText("@beach-student", { exact: true })).toBeVisible();
    await expect(dialog.getByText("陈同学", { exact: true })).toBeVisible();
    await expect(dialog.getByText("海边自习0", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(reviews).toHaveLength(0);
    await desk.getByRole("button", { name: "审核改名申请：陈同学", exact: true }).click();
    await dialog.getByRole("button", { name: "确认批准", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(desk).toContainText("改名已批准。");
    expect(reviews[0].body).toEqual({ decision: "approve" });
    await desk.getByRole("button", { name: "审核改名申请：林同学", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "审核改名申请", exact: true });
    await expect(dialog.getByRole("heading", { name: "审核改名申请", exact: true })).toBeVisible();
    await dialog.getByRole("combobox", { name: "审核决定", exact: true }).selectOption("reject");
    await expect(dialog.getByRole("button", { name: "确认拒绝", exact: true })).toBeDisabled();
    await dialog.getByLabel(/^拒绝原因/).fill("申请名字含不适当内容");
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`name-review-${width}.png`) });
    await dialog.getByRole("button", { name: "确认拒绝", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(desk).toContainText("用户原名字保留。");
    expect(reviews[1].body).toEqual({ decision: "reject", reason: "申请名字含不适当内容" });
    expect(entries[1].displayName).toBe("林同学");
    await page.getByRole("navigation", { name: "管理功能" }).getByRole("button", { name: "操作记录", exact: true }).click();
    await expect(page.getByText("用户改名已批准", { exact: true })).toBeVisible();
    await expect(page.getByText("用户改名申请已拒绝", { exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "管理功能" }).getByRole("button", { name: "用户", exact: true }).click();
    await desk.getByRole("button", { name: "审核改名申请：沈同学", exact: true }).click();
    await dialog.getByRole("button", { name: "确认批准", exact: true }).click();
    await expect(page.getByRole("heading", { name: "验证身份", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(desk).toHaveCount(0);
    expect(entries[2].status).toBe("pending");
    expect(reviews).toHaveLength(3);
    expect((await context.cookies()).find(item => item.name === "synthetic_admin_session")?.value).toBe("same-session");
    expect(errors).toEqual([]);
  });
}
