import { test, expect } from "@playwright/test";
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
      let payload: unknown = { items: [], reports: [], announcements: [], candidates: [], events: [], nextCursor: null };
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
