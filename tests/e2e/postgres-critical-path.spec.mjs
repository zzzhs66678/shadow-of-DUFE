import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";

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
const { Pool } = pg;

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

async function seedTeacher() {
  const suffix = randomUUID().slice(0, 8);
  const id = randomUUID();
  const displayName = `浏览器验收教师-${suffix}`;
  const collegeName = `浏览器验收学院-${suffix}`;
  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number.parseInt(process.env.PGPORT ?? "5432", 10),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 1,
  });
  try {
    await pool.query(
      `INSERT INTO teachers (
         id, display_name, normalized_name, college_name,
         normalized_college, identity_status
       ) VALUES ($1::uuid, $2, $3, $4, $5, 'active')`,
      [
        id,
        displayName,
        displayName.toLocaleLowerCase("zh-CN"),
        collegeName,
        collegeName.toLocaleLowerCase("zh-CN"),
      ],
    );
    return { id, displayName, collegeName };
  } finally {
    await pool.end();
  }
}

test("users and an administrator complete the release browser path", async ({
  browser,
}) => {
  const teacher = await seedTeacher();
  const ownerContext = await browser.newContext();
  const secondOwnerContext = await browser.newContext();
  const replierContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const secondOwner = await secondOwnerContext.newPage();
  const replier = await replierContext.newPage();
  const administrator = await adminContext.newPage();

  try {
    const ownerUsername = await register(owner, "owner");
    const replierUsername = await register(replier, "replier");
    const adminUsername = await register(administrator, "admin");

    const ownerDisplayName = `跨设备同学-${Date.now().toString(36)}`;
    await owner.getByRole("button", { name: "编辑资料" }).click();
    await owner.getByLabel("显示名").fill(ownerDisplayName);
    await owner.getByRole("button", { name: "保存资料" }).click();
    await expect(owner.getByText("账号资料已保存。")).toBeVisible();
    const avatar = await sharp({
      create: {
        width: 80,
        height: 120,
        channels: 3,
        background: { r: 181, g: 38, b: 38 },
      },
    }).png().toBuffer();
    await owner.locator('input[type="file"][accept*="image/png"]').setInputFiles({
      name: "browser-avatar.png",
      mimeType: "image/png",
      buffer: avatar,
    });
    await expect(
      owner.getByText("头像已更新；原图与定位信息没有保留。"),
    ).toBeVisible();

    await login(secondOwner, ownerUsername);
    await expect(
      secondOwner.getByRole("heading", { name: ownerDisplayName }),
    ).toBeVisible();
    await expect(secondOwner.getByRole("button", { name: "删除头像" })).toBeVisible();

    await secondOwner.goto("/materials");
    await secondOwner.getByLabel("搜索档案").fill("开课导学");
    const materialLink = secondOwner.getByRole("link", {
      name: "00 开课导学.pdf",
    });
    await expect(materialLink).toBeVisible();
    await materialLink.click();
    await expect(
      secondOwner.getByRole("heading", { name: "00 开课导学.pdf" }),
    ).toBeVisible();

    await secondOwner.goto(`/teachers?q=${encodeURIComponent(teacher.displayName)}`);
    await expect(secondOwner.getByText(teacher.collegeName)).toBeVisible();
    await secondOwner
      .getByRole("link", { name: new RegExp(teacher.displayName, "u") })
      .click();
    await expect(
      secondOwner.getByRole("heading", { name: teacher.displayName }),
    ).toBeVisible();
    await secondOwner.getByRole("button", { name: "写一份评价" }).click();
    for (const dimension of [
      "课程组织",
      "讲解清晰",
      "考核说明",
      "课堂互动",
      "资料完整",
    ]) {
      await secondOwner
        .getByRole("group", { name: dimension })
        .getByRole("radio", { name: "5" })
        .check();
    }
    const reviewBody = "课堂结构清楚，考核说明完整，课程资料与教学进度能够互相对应。";
    await secondOwner.getByLabel(/具体说说课堂组织/u).fill(reviewBody);
    await secondOwner.getByRole("button", { name: "保存并公开" }).click();
    await expect(secondOwner.getByText("你的评价已保存并公开。")).toBeVisible();
    await expect(secondOwner.getByText(reviewBody)).toBeVisible();

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

    await expect(
      administrator.getByRole("heading", { name: "举报案卷" }),
    ).toBeVisible();
    await administrator
      .getByRole("button", { name: new RegExp(topicTitle, "u") })
      .click();
    const caseDialog = administrator.getByRole("dialog", { name: topicTitle });
    await caseDialog
      .getByLabel(/入案原因/u)
      .fill("举报证据完整，进入浏览器端人工复核流程。");
    await caseDialog.getByRole("button", { name: "建立审核案件" }).click();
    await expect(caseDialog.getByLabel("治理动作")).toBeVisible();
    await caseDialog.getByLabel("治理动作").selectOption("hide");
    await caseDialog
      .getByLabel(/处置原因/u)
      .fill("正文已完成证据留存，先隐藏内容并继续复核。");
    await caseDialog
      .getByRole("button", { name: "隐藏内容，继续审核" })
      .click();
    await expect(caseDialog.getByLabel("治理动作")).toHaveValue("restore");
    await caseDialog.getByLabel("治理动作").selectOption("delete");
    await caseDialog
      .getByLabel(/处置原因/u)
      .fill("复核后确认删除测试主题并结束本次案件。");
    await caseDialog
      .getByRole("button", { name: "删除内容并结案" })
      .click();
    await expect(caseDialog).toBeHidden();
    await expect(
      administrator.getByText("治理动作已写入审计，案件已经结案。"),
    ).toBeVisible();

    await owner.goto(topicPath);
    await expect(owner.getByText("这段讨论已经不可见")).toBeVisible();
  } finally {
    await Promise.all([
      ownerContext.close(),
      secondOwnerContext.close(),
      replierContext.close(),
      adminContext.close(),
    ]);
  }
});
