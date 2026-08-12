import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
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

async function dismissOnboarding(page) {
  const onboarding = page.getByRole("dialog", { name: "建立个人档案" });
  try {
    await onboarding.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return;
  }
  await onboarding.getByRole("button", { name: "暂时跳过" }).click();
  await expect(onboarding).toBeHidden();
}

async function register(page, label) {
  const username = `browser-${label}-${Date.now().toString(36)}`;
  await page.goto("/?view=me");
  await dismissOnboarding(page);
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
  await dismissOnboarding(page);
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
  const candidateBody = `历史课堂资料衔接清楚，课程安排稳定，复核样本 ${suffix}。`;
  const sourceSha256 = createHash("sha256")
    .update(`browser-import-${suffix}`)
    .digest("hex");
  const bodySha256 = createHash("sha256")
    .update(candidateBody.normalize("NFKC"))
    .digest("hex");
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
    const batch = await pool.query(
      `INSERT INTO data_import_batches (
         import_type, source_filename, source_sha256, mapping_version,
         status, dry_run, row_count, accepted_count, applied_at
       ) VALUES (
         'teacher_reviews', $1, $2, 'browser-e2e-v1',
         'applied', false, 1, 1, now()
       ) RETURNING id`,
      [`browser-review-${suffix}.xlsx`, sourceSha256],
    );
    const importRow = await pool.query(
      `INSERT INTO data_import_rows (
         batch_id, source_sheet, source_row, source_column,
         source_locator, content_sha256, disposition, sanitized_payload
       ) VALUES ($1::uuid, 'E2E', 2, 3, 'E2E!C2', $2, 'accepted', $3::jsonb)
       RETURNING id`,
      [
        batch.rows[0].id,
        bodySha256,
        JSON.stringify({ teacherName: displayName, review: candidateBody }),
      ],
    );
    await pool.query(
      `INSERT INTO teacher_review_candidates (
         teacher_id, import_row_id, sanitized_body,
         original_body_sha256, normalized_body_sha256, risk_flags
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $4, '{}')`,
      [id, importRow.rows[0].id, candidateBody, bodySha256],
    );
    return { id, displayName, collegeName, candidateBody };
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
    const publishedReviewBody = reviewBody.normalize("NFKC");
    await secondOwner.getByLabel(/具体说说课堂组织/u).fill(reviewBody);
    await secondOwner.getByRole("button", { name: "保存并公开" }).click();
    await expect(secondOwner.getByText("你的评价已保存并公开。")).toBeVisible();
    const publishedReviews = await secondOwner.evaluate(async (teacherId) => {
      const response = await fetch(`/api/teachers/${teacherId}/reviews?limit=20`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      return {
        status: response.status,
        payload: await response.json(),
      };
    }, teacher.id);
    expect(publishedReviews.status).toBe(200);
    expect(publishedReviews.payload.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: publishedReviewBody })]),
    );
    const userReview = publishedReviews.payload.items.find(
      (review) => review.body === publishedReviewBody,
    );
    expect(userReview?.id).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(secondOwner.getByText(publishedReviewBody)).toBeVisible();

    await replier.goto(`/teachers/${teacher.id}`);
    const reviewArticle = replier.locator("article").filter({ hasText: publishedReviewBody });
    await reviewArticle.getByRole("button", { name: "展开讨论" }).click();
    const teacherReplyBody = "这条回复由另一名真实注册用户补充具体课堂体验。";
    await reviewArticle.getByLabel("只讨论具体教学体验").fill(teacherReplyBody);
    await reviewArticle.getByRole("button", { name: "发布回复" }).click();
    await expect(reviewArticle.getByText(teacherReplyBody)).toBeVisible();

    await expect.poll(async () => {
      return secondOwner.evaluate(async (expectedBody) => {
        const response = await fetch("/api/community/notifications?limit=30", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return false;
        const payload = await response.json();
        return payload.items.some((item) =>
          item.type === "teacher_review_reply" && item.body === expectedBody
        );
      }, teacherReplyBody);
    }).toBe(true);

    await secondOwner.goto("/community");
    await secondOwner.getByRole("button", { name: /通知/u }).click();
    const teacherNotifications = secondOwner.getByRole("dialog", { name: "通知" });
    await expect(teacherNotifications.getByText(teacherReplyBody)).toBeVisible();
    await expect(
      teacherNotifications.locator("small").filter({ hasText: replierUsername }),
    ).toBeVisible();
    await teacherNotifications.getByRole("button", { name: "关闭通知" }).click();

    await secondOwner.goto(`/teachers/${teacher.id}`);
    const reportedReviewArticle = secondOwner.locator("article").filter({ hasText: publishedReviewBody });
    await reportedReviewArticle.getByRole("button", { name: "展开讨论" }).click();
    await reportedReviewArticle.getByRole("button", { name: "举报", exact: true }).click();
    const teacherReport = secondOwner.getByRole("dialog", { name: "举报“教师评价回复”" });
    await teacherReport.getByLabel(/补充说明/u).fill("用于验证教师评价回复的真实举报与审核闭环。");
    await teacherReport.getByRole("button", { name: "提交举报" }).click();
    await expect(secondOwner.getByRole("status")).toContainText("举报已提交");

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
    await expect(owner).toHaveURL(/\/community\/topics\/[0-9a-f-]{36}$/u);
    await expect(owner.getByRole("heading", { name: topicTitle })).toBeVisible();
    const topicPath = new URL(owner.url()).pathname;
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
    await expect(
      notifications.locator("small").filter({ hasText: replierUsername }),
    ).toBeVisible();

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
    await expect(
      administrator.getByRole("heading", { name: "教师评价复核" }),
    ).toBeVisible();
    await administrator
      .getByRole("button", { name: new RegExp(teacher.displayName, "u") })
      .click();
    const teacherReviewDialog = administrator.getByRole("dialog", {
      name: teacher.displayName,
    });
    await teacherReviewDialog
      .getByLabel(/决定依据/u)
      .fill("正文不含身份线索或攻击表达，允许作为历史整理内容公开。");
    await teacherReviewDialog
      .getByRole("button", { name: "确认公开" })
      .click();
    await expect(teacherReviewDialog).toBeHidden();
    await expect(
      administrator.getByText(/历史评价已作为“历史整理内容”公开/u),
    ).toBeVisible();

    await secondOwner.goto(`/teachers/${teacher.id}`);
    await expect(secondOwner.getByText(teacher.candidateBody)).toBeVisible();
    await expect(secondOwner.getByText("历史整理内容", { exact: true })).toBeVisible();

    const moderationDesk = administrator.locator("section").filter({
      has: administrator.getByRole("heading", { name: "举报案卷" }),
    });
    await moderationDesk
      .getByRole("button", { name: new RegExp(teacher.displayName, "u") })
      .click();
    const teacherCaseDialog = administrator.getByRole("dialog", {
      name: teacher.displayName,
    });
    await teacherCaseDialog
      .getByLabel(/入案原因/u)
      .fill("举报证据完整，进入教师评价回复的人工复核流程。");
    await teacherCaseDialog.getByRole("button", { name: "建立审核案件" }).click();
    await expect(teacherCaseDialog.getByLabel("治理动作")).toBeVisible();
    await teacherCaseDialog.getByLabel("治理动作").selectOption("hide");
    await teacherCaseDialog
      .getByLabel(/处置原因/u)
      .fill("证据已留存，先隐藏教师评价回复并继续复核。");
    await teacherCaseDialog
      .getByRole("button", { name: "隐藏内容，继续审核" })
      .click();
    await expect(teacherCaseDialog.getByLabel("治理动作")).toHaveValue("restore");
    await teacherCaseDialog.getByLabel("治理动作").selectOption("restore");
    await teacherCaseDialog
      .getByLabel(/处置原因/u)
      .fill("复核后先恢复原回复，验证恢复不改写原始正文。");
    await teacherCaseDialog
      .getByRole("button", { name: "恢复内容并结案" })
      .click();
    await expect(teacherCaseDialog).toBeHidden();

    await secondOwner.goto(`/teachers/${teacher.id}`);
    const restoredReviewArticle = secondOwner.locator("article").filter({ hasText: publishedReviewBody });
    await restoredReviewArticle.getByRole("button", { name: "展开讨论" }).click();
    await expect(restoredReviewArticle.getByText(teacherReplyBody)).toBeVisible();
    await restoredReviewArticle.getByRole("button", { name: "举报", exact: true }).click();
    const finalTeacherReport = secondOwner.getByRole("dialog", { name: "举报“教师评价回复”" });
    await finalTeacherReport.getByLabel(/补充说明/u).fill("恢复后再次举报，用于验证管理员最终删除的真实页面闭环。");
    await finalTeacherReport.getByRole("button", { name: "提交举报" }).click();
    await expect(secondOwner.getByRole("status")).toContainText("举报已提交");

    await administrator.reload();
    const refreshedModerationDesk = administrator.locator("section").filter({
      has: administrator.getByRole("heading", { name: "举报案卷" }),
    });
    await refreshedModerationDesk
      .getByRole("button", { name: new RegExp(teacher.displayName, "u") })
      .click();
    const finalTeacherCase = administrator.getByRole("dialog", { name: teacher.displayName });
    await finalTeacherCase
      .getByLabel(/入案原因/u)
      .fill("恢复后的新举报证据完整，进入最终删除复核。");
    await finalTeacherCase.getByRole("button", { name: "建立审核案件" }).click();
    await finalTeacherCase.getByLabel("治理动作").selectOption("delete");
    await finalTeacherCase
      .getByLabel(/处置原因/u)
      .fill("复核确认后软删除教师评价回复并保留讨论位置。");
    await finalTeacherCase
      .getByRole("button", { name: "删除内容并结案" })
      .click();
    await expect(finalTeacherCase).toBeHidden();

    await secondOwner.reload();
    const deletedReviewArticle = secondOwner.locator("article").filter({ hasText: publishedReviewBody });
    await deletedReviewArticle.getByRole("button", { name: "展开讨论" }).click();
    await expect(deletedReviewArticle.getByText("这条回复已不可见，讨论位置仍被保留。")).toBeVisible();
    await expect(deletedReviewArticle.getByText(teacherReplyBody)).toBeHidden();

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
    await Promise.allSettled([
      ownerContext.close(),
      secondOwnerContext.close(),
      replierContext.close(),
      adminContext.close(),
    ]);
  }
});
