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
  await page.getByRole("button", { name: "登录", exact: true }).click();
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
  await page.getByRole("button", { name: "登录", exact: true }).click();
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

async function teacherReplyDatabaseSnapshot({ reviewId, replyBody }) {
  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number.parseInt(process.env.PGPORT ?? "5432", 10),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 1,
  });
  try {
    const result = await pool.query(
      `SELECT
         reviews.author_user_id AS review_author_user_id,
         comments.id AS comment_id,
         comments.author_user_id AS comment_author_user_id,
         notifications.recipient_user_id,
         notifications.notification_type,
         notifications.body AS notification_body
       FROM teacher_reviews AS reviews
       JOIN teacher_review_comments AS comments
         ON comments.review_id = reviews.id
        AND comments.body = $2
       LEFT JOIN community_notifications AS notifications
         ON notifications.teacher_review_comment_id = comments.id
       WHERE reviews.id = $1::uuid`,
      [reviewId, replyBody],
    );
    return result.rows[0] ?? null;
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
    await secondOwner.getByRole("searchbox", { name: /搜索资料/ }).fill("开课导学");
    const materialLink = secondOwner.getByRole("link", {
      name: "00 开课导学.pdf",
    });
    await expect(materialLink).toBeVisible();
    await materialLink.click();
    await expect(
      secondOwner.getByRole("heading", { name: "00 开课导学.pdf" }),
    ).toBeVisible();

    await secondOwner.goto(`/teachers?q=${encodeURIComponent(teacher.displayName)}`);
    await expect(secondOwner.getByRole("link", { name: new RegExp(teacher.displayName, "u") }).getByText(teacher.collegeName, { exact: true })).toBeVisible();
    await secondOwner
      .getByRole("link", { name: new RegExp(teacher.displayName, "u") })
      .click();
    await expect(
      secondOwner.getByRole("heading", { name: teacher.displayName }),
    ).toBeVisible();
    await expect(secondOwner.getByLabel("评价正文", { exact: true })).toBeVisible();
    await expect(secondOwner.getByRole("radio")).toHaveCount(0);
    const createReviewRequest = secondOwner.waitForRequest((request) =>
      request.method() === "PUT" && new URL(request.url()).pathname === `/api/teachers/${teacher.id}/my-review`
    );
    const createReviewResponse = secondOwner.waitForResponse((response) =>
      response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/teachers/${teacher.id}/my-review`
    );
    await secondOwner.getByLabel(/评价正文/u).fill("好");
    await secondOwner.getByRole("button", { name: "发布", exact: true }).click();
    expect((await createReviewRequest).postDataJSON()).toEqual({ body: "好" });
    const createdReview = await (await createReviewResponse).json();
    await expect(secondOwner.getByText("评价已发布。", { exact: true })).toBeVisible();
    await expect(secondOwner.getByText("好", { exact: true })).toBeVisible();

    const reviewBody = "课堂结构清楚，考核说明完整，课程资料与教学进度能够互相对应。";
    const publishedReviewBody = reviewBody.normalize("NFKC");
    await secondOwner.getByRole("button", { name: "修改我的评价", exact: true }).click();
    await secondOwner.getByLabel(/评价正文/u).fill(reviewBody);
    const updateReviewRequest = secondOwner.waitForRequest((request) =>
      request.method() === "PUT" && new URL(request.url()).pathname === `/api/teachers/${teacher.id}/my-review`
    );
    await secondOwner.getByRole("button", { name: "保存修改", exact: true }).click();
    expect((await updateReviewRequest).postDataJSON()).toEqual({ body: reviewBody, expectedVersion: createdReview.review.version });
    await expect(secondOwner.getByText("评价已修改。", { exact: true })).toBeVisible();
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
    await reviewArticle.getByRole("button", { name: "回复", exact: true }).click();
    const teacherReplyBody = "这条回复由另一名真实注册用户补充具体课堂体验。";
    await reviewArticle.getByLabel("回复正文", { exact: true }).fill(teacherReplyBody);
    await reviewArticle.getByRole("button", { name: "发布回复" }).click();
    await expect(reviewArticle.getByText("回复已发布。", { exact: true })).toBeVisible();
    await expect(
      reviewArticle.locator("ol > li").filter({ hasText: teacherReplyBody }),
    ).toBeVisible();

    const [ownerSession, replierSession] = await Promise.all([
      secondOwner.evaluate(async () => {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        return { status: response.status, payload: await response.json() };
      }),
      replier.evaluate(async () => {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        return { status: response.status, payload: await response.json() };
      }),
    ]);
    expect(ownerSession).toEqual(expect.objectContaining({
      status: 200,
      payload: expect.objectContaining({ authenticated: true }),
    }));
    expect(replierSession).toEqual(expect.objectContaining({
      status: 200,
      payload: expect.objectContaining({ authenticated: true }),
    }));
    const teacherReplySnapshot = await teacherReplyDatabaseSnapshot({
      reviewId: userReview.id,
      replyBody: teacherReplyBody,
    });
    expect(teacherReplySnapshot).toEqual(expect.objectContaining({
      review_author_user_id: ownerSession.payload.user.id,
      comment_author_user_id: replierSession.payload.user.id,
      recipient_user_id: ownerSession.payload.user.id,
      notification_type: "teacher_review_reply",
      notification_body: teacherReplyBody,
    }));

    await expect.poll(async () => {
      return secondOwner.evaluate(async (expectedBody) => {
        const response = await fetch("/api/community/notifications?limit=30", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return { status: response.status, found: false };
        const payload = await response.json();
        return {
          status: response.status,
          found: payload.items.some((item) =>
            item.type === "teacher_review_reply" && item.body === expectedBody
          ),
          types: payload.items.map((item) => item.type),
        };
      }, teacherReplyBody);
    }).toEqual(expect.objectContaining({ status: 200, found: true }));

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
    await reportedReviewArticle.getByRole("button", { name: "回复", exact: true }).click();
    await reportedReviewArticle.getByRole("button", { name: "举报", exact: true }).click();
    const teacherReport = secondOwner.getByRole("dialog", { name: "举报“教师评价回复”" });
    await teacherReport.getByLabel(/补充说明/u).fill("用于验证教师评价回复的真实举报与审核闭环。");
    await teacherReport.getByRole("button", { name: "提交举报" }).click();
    await expect(secondOwner.getByRole("status")).toContainText("举报已提交");

    await administrator.goto("/admin");
    await expect(
      administrator.getByRole("heading", {
        name: "仅管理员可访问",
      }),
    ).toBeVisible();

    const topicTitle = `PG17 浏览器闭环 ${Date.now().toString(36)}`;
    const topicBody = "这条主题由第一名真实注册用户通过页面发布。";
    await owner.goto("/community");
    await owner
      .getByRole("button", { name: "发布主题", exact: true })
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
    const topicReplyNotification = notifications
      .getByRole("button")
      .filter({ hasText: replyBody });
    await expect(topicReplyNotification).toBeVisible();
    await expect(
      topicReplyNotification.locator("small").filter({ hasText: replierUsername }),
    ).toBeVisible();

    const enrollment = await bootstrapAdministrator(adminUsername);
    await login(administrator, adminUsername);
    await administrator.goto("/admin");
    await expect(
      administrator.getByRole("heading", {
        name: /验证身份/u,
      }),
    ).toBeVisible();
    const totp = adminSecurityTest.codeForStep(
      enrollment.secret,
      Math.floor(Date.now() / 1_000 / 30),
    );
    await administrator.getByLabel("动态码或恢复码").fill(totp);
    await administrator.getByRole("button", { name: "进入后台" }).click();
    await expect(
      administrator.getByRole("heading", { name: "用户管理" }),
    ).toBeVisible();
    await expect(administrator.getByRole("region", { name: "账号概况" })).toBeVisible();
    await expect(
      administrator
        .getByRole("region", { name: "注册用户" })
        .locator("span")
        .filter({ hasText: `@${ownerUsername} ·` }),
    ).toBeVisible();

    await administrator.getByRole("navigation", { name: "管理功能" }).getByRole("button", { name: "内容审核" }).click();
    await expect(
      administrator.getByRole("heading", { name: "举报处理" }),
    ).toBeVisible();
    await administrator.getByRole("navigation", { name: "审核分类" }).getByRole("button", { name: "历史评价" }).click();
    await expect(
      administrator.getByRole("heading", { name: "历史评价" }),
    ).toBeVisible();
    const teacherReviewDesk = administrator.locator("section").filter({
      has: administrator.getByRole("heading", { name: "历史评价" }),
    });
    await teacherReviewDesk
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
      administrator.getByText(/已公开为历史评价/u),
    ).toBeVisible();

    await secondOwner.goto(`/teachers/${teacher.id}`);
    await expect(secondOwner.getByText(teacher.candidateBody)).toBeVisible();
    const legacyReviewArticle = secondOwner.locator("article").filter({ hasText: teacher.candidateBody });
    await expect(legacyReviewArticle.getByText("历史评价", { exact: true })).toBeVisible();
    await expect(legacyReviewArticle.locator("time, img")).toHaveCount(0);

    await administrator.getByRole("navigation", { name: "审核分类" }).getByRole("button", { name: "举报处理" }).click();
    const moderationDesk = administrator.locator("section").filter({
      has: administrator.getByRole("heading", { name: "举报处理" }),
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
    await restoredReviewArticle.getByRole("button", { name: "回复", exact: true }).click();
    await expect(restoredReviewArticle.getByText(teacherReplyBody)).toBeVisible();
    await restoredReviewArticle.getByRole("button", { name: "举报", exact: true }).click();
    const finalTeacherReport = secondOwner.getByRole("dialog", { name: "举报“教师评价回复”" });
    await finalTeacherReport.getByLabel(/补充说明/u).fill("恢复后再次举报，用于验证管理员最终删除的真实页面闭环。");
    await finalTeacherReport.getByRole("button", { name: "提交举报" }).click();
    await expect(secondOwner.getByRole("status")).toContainText("举报已提交");

    await administrator.reload();
    const refreshedModerationDesk = administrator.locator("section").filter({
      has: administrator.getByRole("heading", { name: "举报处理" }),
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
    await deletedReviewArticle.getByRole("button", { name: "回复", exact: true }).click();
    await expect(deletedReviewArticle.getByText("这条回复已不可见，讨论位置仍被保留。")).toBeVisible();
    await expect(deletedReviewArticle.getByText(teacherReplyBody)).toBeHidden();

    const finalModerationDesk = administrator.locator("section").filter({
      has: administrator.getByRole("heading", { name: "举报处理" }),
    });
    await finalModerationDesk.getByRole("button", { name: "待入案" }).click();
    await expect(
      finalModerationDesk.getByRole("button", { name: "待入案", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await finalModerationDesk
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
