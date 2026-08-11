import { expect, test } from "@playwright/test";

import {
  __test as adminSecurityTest,
  createAdminSecurity,
} from "../../services/auth-api/src/admin-security.mjs";
import { loadConfig } from "../../services/auth-api/src/config.mjs";
import {
  createAuthStore,
  createDatabasePool,
} from "../../services/auth-api/src/db.mjs";
import { normalizeLoginIdentifier } from "../../services/auth-api/src/credentials.mjs";

const password = "Moonlight!2026";

async function register(page, label) {
  const username = `browser-${label}-${Date.now().toString(36)}`;
  await page.goto("/?view=me");
  await expect(page.getByText("现在的数据只保存在这台设备")).toBeVisible();
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  const form = page.locator(".credential-gateway form");
  await form.getByLabel("用户名").fill(username);
  await form.getByLabel("邮箱").fill(`${username}@example.com`);
  await form.getByLabel("密码").fill(password);
  await form.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: `@${username}` })).toBeVisible();
  return username;
}

async function login(page, username) {
  await page.goto("/?view=me");
  await expect(page.getByText("现在的数据只保存在这台设备")).toBeVisible();
  const form = page.locator(".credential-gateway form");
  await form.getByLabel("用户名或邮箱").fill(username);
  await form.getByLabel("密码").fill(password);
  await form.getByRole("button", { name: "登录并同步" }).click();
  await expect(page.getByRole("heading", { name: `@${username}` })).toBeVisible();
}

async function bootstrapAdministrator(username) {
  const config = loadConfig();
  const store = createAuthStore(createDatabasePool(config));
  const security = createAdminSecurity({
    activeKeyId: config.adminMfaActiveKeyId,
    keyring: config.adminMfaKeys,
    recoveryPepper: config.adminRecoveryPepper,
  });
  try {
    const target = await store.getAdminBootstrapTarget(
      normalizeLoginIdentifier(username),
    );
    expect(target?.id).toBeTruthy();
    const enrollment = security.createEnrollment({
      userId: target.id,
      accountLabel: username,
    });
    await store.bootstrapAdmin({ userId: target.id, enrollment });
    return enrollment;
  } finally {
    await store.close();
  }
}

test("two users and one administrator complete the critical browser path", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const replierContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const replier = await replierContext.newPage();
  const administrator = await adminContext.newPage();

  try {
    const ownerUsername = await register(owner, "owner");
    const replierUsername = await register(replier, "replier");
    const adminUsername = await register(administrator, "admin");

    await administrator.goto("/admin");
    await expect(
      administrator.getByRole("heading", {
        name: "这个入口只对值守人员开放",
      }),
    ).toBeVisible();

    const topicTitle = `PG17 浏览器闭环 ${Date.now().toString(36)}`;
    const topicBody = "这条主题由第一名真实注册用户通过页面发布。";
    await owner.goto("/community");
    await owner
      .getByRole("button", { name: /写一条新主题|写第一条/u })
      .first()
      .click();
    const composer = owner.locator("form").filter({ hasText: "发布主题" });
    await composer.getByLabel("标题").fill(topicTitle);
    await composer.getByLabel("正文").fill(topicBody);
    await composer.getByRole("button", { name: "发布主题" }).click();
    const topicLink = owner
      .locator('a[href^="/community/topics/"]')
      .filter({ hasText: topicTitle })
      .first();
    await expect(topicLink).toBeVisible();
    const topicPath = await topicLink.getAttribute("href");
    expect(topicPath).toMatch(/^\/community\/topics\/[0-9a-f-]{36}$/u);

    await replier.goto(topicPath);
    const replyBody = "第二名真实注册用户通过页面补充了这条回复。";
    await replier.getByLabel("加入讨论").fill(replyBody);
    await replier.getByRole("button", { name: "发布回复" }).click();
    await expect(replier.getByText(replyBody)).toBeVisible();
    await replier.getByRole("button", { name: "举报主题" }).click();
    const report = replier.getByRole("dialog", {
      name: `举报“${topicTitle}”`,
    });
    await report.getByLabel(/补充说明/u).fill("用于验证真实浏览器举报与管理员入口。");
    await report.getByRole("button", { name: "提交举报" }).click();
    await expect(replier.getByRole("status")).toContainText("举报已提交");

    await owner.goto(topicPath);
    await owner.getByRole("button", { name: /通知/u }).click();
    const notifications = owner.getByRole("dialog", { name: "通知" });
    await expect(notifications.getByText(replyBody)).toBeVisible();
    await expect(notifications.getByText(`@${replierUsername}`)).toBeVisible();

    const enrollment = await bootstrapAdministrator(adminUsername);
    await login(administrator, adminUsername);
    await administrator.goto("/admin");
    await expect(
      administrator.getByRole("heading", {
        name: /值守之前/u,
      }),
    ).toBeVisible();
    const totp = adminSecurityTest.codeForStep(
      enrollment.secret,
      Math.floor(Date.now() / 1_000 / 30),
    );
    await administrator.getByLabel("动态码或恢复码").fill(totp);
    await administrator.getByRole("button", { name: "开始值守" }).click();
    await expect(
      administrator.getByRole("heading", { name: "今日值守簿" }),
    ).toBeVisible();
    await expect(administrator.getByText("在册账号")).toBeVisible();
    await expect(administrator.getByText(ownerUsername)).toBeVisible();
  } finally {
    await Promise.all([
      ownerContext.close(),
      replierContext.close(),
      adminContext.close(),
    ]);
  }
});
