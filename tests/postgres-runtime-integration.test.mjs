import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import {
  __test as adminSecurityTest,
  createAdminSecurity,
} from "../services/auth-api/src/admin-security.mjs";
import { createAvatarProcessor } from "../services/auth-api/src/avatars.mjs";
import { loadConfig } from "../services/auth-api/src/config.mjs";
import {
  createAuthStore,
  createDatabasePool,
} from "../services/auth-api/src/db.mjs";
import { createPasswordService } from "../services/auth-api/src/passwords.mjs";
import { createWechatProvider } from "../services/auth-api/src/providers/mock-wechat.mjs";
import { createApiRateLimiters } from "../services/auth-api/src/rate-limit.mjs";
import { createAuthServer } from "../services/auth-api/src/server.mjs";

const enabled = process.env.POSTGRES_INTEGRATION === "true";
const { Pool } = pg;

function poolFor(user, password) {
  return new Pool({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.POSTGRES_DB,
    user,
    password,
    max: 20,
    connectionTimeoutMillis: 3_000,
    query_timeout: 10_000,
  });
}

async function denied(pool, statement) {
  await assert.rejects(
    pool.query(statement),
    (error) => error?.code === "42501",
  );
}

function integrationConfig() {
  const mfaKey = Buffer.alloc(32, 0x44).toString("base64");
  return loadConfig({
    NODE_ENV: "test",
    AUTH_API_PORT: "3100",
    AUTH_TOKEN_PEPPER: "ci-token-pepper-that-is-longer-than-thirty-two-characters",
    AUTH_ALLOWED_ORIGINS: "https://dufesh.cn",
    AUTH_PUBLIC_ORIGIN: "https://dufesh.cn",
    AUTH_DB_USER: process.env.AUTH_DB_USER,
    AUTH_DB_PASSWORD: process.env.AUTH_DB_PASSWORD,
    POSTGRES_DB: process.env.POSTGRES_DB,
    PGHOST: process.env.PGHOST ?? "127.0.0.1",
    PGPORT: process.env.PGPORT ?? "5432",
    AUTH_WECHAT_MODE: "disabled",
    AUTH_PASSWORD_RESET_MODE: "response",
    AUTH_EMAIL_VERIFICATION_MODE: "response",
    AUTH_ADMIN_ENABLED: "true",
    AUTH_ADMIN_MFA_ACTIVE_KEY_ID: "ci-key",
    AUTH_ADMIN_MFA_KEYS: JSON.stringify({ "ci-key": mfaKey }),
    AUTH_ADMIN_RECOVERY_PEPPER:
      "ci-recovery-pepper-that-is-longer-than-thirty-two-characters",
  });
}

function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function closeServer(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("PostgreSQL 17 migrations and role boundaries hold under runtime traffic", {
  skip: !enabled,
  timeout: 30_000,
}, async () => {
  const owner = poolFor(process.env.POSTGRES_USER, process.env.POSTGRES_PASSWORD);
  const runtime = poolFor(process.env.AUTH_DB_USER, process.env.AUTH_DB_PASSWORD);
  const importer = poolFor(process.env.IMPORT_DB_USER, process.env.IMPORT_DB_PASSWORD);
  const digestA = Buffer.alloc(32, 0x41);
  const digestB = Buffer.alloc(32, 0x42);

  try {
    const version = await owner.query("SHOW server_version_num");
    assert.equal(Number(version.rows[0].server_version_num) >= 170000, true);

    const migrations = await owner.query(
      "SELECT count(*)::integer AS count FROM schema_migrations",
    );
    assert.equal(migrations.rows[0].count, 16);

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        runtime.query(
          `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
          ["ci-credential", digestA, 5, 1e-9],
        ),
      ),
    );
    assert.equal(
      attempts.filter((result) => result.rows[0].allowed).length,
      5,
    );

    await runtime.end();
    const restartedRuntime = poolFor(
      process.env.AUTH_DB_USER,
      process.env.AUTH_DB_PASSWORD,
    );
    try {
      const persisted = await restartedRuntime.query(
        `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
        ["ci-credential", digestA, 5, 1e-9],
      );
      assert.equal(persisted.rows[0].allowed, false);
      const separateKey = await restartedRuntime.query(
        `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
        ["ci-credential", digestB, 5, 1e-9],
      );
      const separateScope = await restartedRuntime.query(
        `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
        ["ci-password-reset", digestA, 5, 1e-9],
      );
      assert.equal(separateKey.rows[0].allowed, true);
      assert.equal(separateScope.rows[0].allowed, true);
      await denied(
        restartedRuntime,
        "SELECT * FROM api_rate_limit_buckets LIMIT 1",
      );
      await denied(
        restartedRuntime,
        "UPDATE admin_audit_events SET action = action",
      );
    } finally {
      await restartedRuntime.end();
    }

    await denied(importer, "SELECT * FROM app_users LIMIT 1");
    await denied(importer, "SELECT * FROM user_sessions LIMIT 1");
    await denied(importer, "SELECT * FROM teacher_review_candidate_decisions LIMIT 1");
    await denied(
      importer,
      `SELECT consume_api_rate_limit(
         'ci-importer-denied',
         decode(repeat('43', 32), 'hex'),
         1,
         1
       )`,
    );
  } finally {
    await Promise.allSettled([owner.end(), runtime.end(), importer.end()]);
  }
});

test("real auth, community, and admin HTTP flows persist on PostgreSQL", {
  skip: !enabled,
  timeout: 45_000,
}, async () => {
  const config = integrationConfig();
  const fixtureOwner = poolFor(
    process.env.POSTGRES_USER,
    process.env.POSTGRES_PASSWORD,
  );
  const store = createAuthStore(createDatabasePool(config));
  const adminSecurity = createAdminSecurity({
    activeKeyId: config.adminMfaActiveKeyId,
    keyring: config.adminMfaKeys,
    recoveryPepper: config.adminRecoveryPepper,
  });
  const server = createAuthServer({
    store,
    config,
    wechatProvider: createWechatProvider(config),
    passwordService: createPasswordService(),
    avatarProcessor: createAvatarProcessor(),
    adminSecurity,
    rateLimiters: createApiRateLimiters({ store }),
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const suffix = randomUUID().slice(0, 8);
  const teacherId = randomUUID();
  const requestHeaders = {
    "Content-Type": "application/json",
    Origin: "https://dufesh.cn",
  };

  async function register(label) {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        username: `ci-${label}-${suffix}`,
        email: `ci-${label}-${suffix}@example.com`,
        password: "Moonlight!2026",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.authenticated, true);
    assert.equal(body.user.username, `ci-${label}-${suffix}`);
    const cookie = cookieHeader(response);
    assert.match(cookie, /__Host-dufesh_session=/u);
    assert.match(cookie, /__Host-dufesh_device=/u);
    return { body, cookie };
  }

  try {
    await fixtureOwner.query(
      `INSERT INTO teachers (
         id, display_name, normalized_name, college_name,
         normalized_college, identity_status
       ) VALUES ($1::uuid, $2, $3, $4, $5, 'active')`,
      [
        teacherId,
        "原生集成教师",
        `原生集成教师-${suffix}`,
        "测试学院",
        `测试学院-${suffix}`,
      ],
    );

    const owner = await register("owner");
    const replier = await register("replier");
    const administrator = await register("admin");

    const health = await fetch(`${baseUrl}/api/auth/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const ownerSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: owner.cookie },
    });
    const ownerSessionBody = await ownerSession.json();
    assert.equal(ownerSession.status, 200);
    assert.equal(ownerSessionBody.authenticated, true);
    assert.equal(ownerSessionBody.user.id, owner.body.user.id);

    const verificationRequest = await fetch(
      `${baseUrl}/api/auth/email/verification/request`,
      {
        method: "POST",
        headers: { Origin: "https://dufesh.cn", Cookie: owner.cookie },
      },
    );
    const verificationRequestBody = await verificationRequest.json();
    assert.equal(verificationRequest.status, 202);
    assert.match(verificationRequestBody.debugToken, /^[A-Za-z0-9_-]{43}$/u);
    const verificationAttempts = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetch(`${baseUrl}/api/auth/email/verification/confirm`, {
          method: "POST",
          headers: { ...requestHeaders, Cookie: owner.cookie },
          body: JSON.stringify({ token: verificationRequestBody.debugToken }),
        })
      ),
    );
    assert.deepEqual(
      verificationAttempts.map((response) => response.status).sort(),
      [200, 400],
    );
    const verifiedSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: owner.cookie },
    });
    assert.equal((await verifiedSession.json()).user.emailVerified, true);

    const forbiddenAdmin = await fetch(`${baseUrl}/api/admin/session`, {
      headers: { Cookie: owner.cookie },
    });
    assert.equal(forbiddenAdmin.status, 403);
    assert.deepEqual(await forbiddenAdmin.json(), { error: "admin_forbidden" });

    const topicResponse = await fetch(`${baseUrl}/api/community/topics`, {
      method: "POST",
      headers: { ...requestHeaders, Cookie: owner.cookie },
      body: JSON.stringify({
        title: "PostgreSQL 集成测试主题",
        body: "这条主题通过真实 HTTP、会话与数据库写入。",
        visibility: "public",
      }),
    });
    const topicBody = await topicResponse.json();
    assert.equal(topicResponse.status, 201);
    assert.equal(topicBody.topic.version, 1);

    const unauthorizedEdit = await fetch(
      `${baseUrl}/api/community/topics/${topicBody.topic.id}`,
      {
        method: "PATCH",
        headers: { ...requestHeaders, Cookie: replier.cookie },
        body: JSON.stringify({
          body: "另一个账号不能改写原作者主题。",
          version: 1,
        }),
      },
    );
    assert.equal(unauthorizedEdit.status, 404);
    assert.deepEqual(await unauthorizedEdit.json(), {
      error: "community_content_not_found",
    });

    const replyResponse = await fetch(
      `${baseUrl}/api/community/topics/${topicBody.topic.id}/comments`,
      {
        method: "POST",
        headers: { ...requestHeaders, Cookie: replier.cookie },
        body: JSON.stringify({ body: "这是第二个真实账号提交的回复。" }),
      },
    );
    const replyBody = await replyResponse.json();
    assert.equal(replyResponse.status, 201);
    assert.equal(replyBody.comment.version, 1);

    const topicAfterEditAttempt = await fetch(
      `${baseUrl}/api/community/topics/${topicBody.topic.id}`,
      { headers: { Cookie: replier.cookie } },
    );
    const topicAfterEditAttemptBody = await topicAfterEditAttempt.json();
    assert.equal(topicAfterEditAttempt.status, 200);
    assert.equal(
      topicAfterEditAttemptBody.topic.author.id,
      owner.body.user.id,
    );
    assert.equal(
      topicAfterEditAttemptBody.topic.body,
      "这条主题通过真实 HTTP、会话与数据库写入。",
    );

    const comments = await fetch(
      `${baseUrl}/api/community/topics/${topicBody.topic.id}/comments`,
      { headers: { Cookie: owner.cookie } },
    );
    const commentsBody = await comments.json();
    assert.equal(comments.status, 200);
    assert.equal(commentsBody.items.length, 1);
    assert.equal(commentsBody.items[0].id, replyBody.comment.id);
    assert.equal(commentsBody.items[0].author.id, replier.body.user.id);

    const unread = await fetch(
      `${baseUrl}/api/community/notifications/unread-count`,
      { headers: { Cookie: owner.cookie } },
    );
    assert.equal(unread.status, 200);
    assert.deepEqual(await unread.json(), { unread: 1 });

    const notifications = await fetch(
      `${baseUrl}/api/community/notifications?limit=10`,
      { headers: { Cookie: owner.cookie } },
    );
    const notificationsBody = await notifications.json();
    assert.equal(notifications.status, 200);
    assert.equal(notificationsBody.items.length, 1);
    assert.equal(notificationsBody.items[0].type, "topic_reply");
    assert.equal(notificationsBody.items[0].actor.id, replier.body.user.id);

    const marked = await fetch(
      `${baseUrl}/api/community/notifications/${notificationsBody.items[0].id}`,
      {
        method: "PUT",
        headers: { Origin: "https://dufesh.cn", Cookie: owner.cookie },
      },
    );
    assert.equal(marked.status, 200);

    const afterRead = await fetch(
      `${baseUrl}/api/community/notifications/unread-count`,
      { headers: { Cookie: owner.cookie } },
    );
    assert.deepEqual(await afterRead.json(), { unread: 0 });

    const syncState = {
      profile: {
        entranceYear: 2026,
        college: "测试学院",
        majorId: "ci-major",
        className: "测试2601",
      },
      skipped: false,
      plans: [{
        id: "default",
        name: "默认课表",
        scheduleIds: ["ci-section-meeting-1", "ci-section-meeting-2"],
      }],
      activePlanId: "default",
      activities: [],
      assignments: [],
      favoriteRooms: ["之远楼401"],
      recentRooms: ["笃行楼302"],
      preferredTerm: "fall",
      theme: "system",
    };
    const syncMutation = {
      mutationId: `ci-sync-${suffix}-0001`,
      baseRevision: 0,
      clientUpdatedAt: new Date().toISOString(),
      state: syncState,
    };
    const syncWrite = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: { ...requestHeaders, Cookie: owner.cookie },
      body: JSON.stringify(syncMutation),
    });
    const syncWriteBody = await syncWrite.json();
    assert.equal(syncWrite.status, 200);
    assert.equal(syncWriteBody.revision, 1);
    assert.equal(syncWriteBody.state.plans[0].scheduleIds.length, 2);

    const syncRetry = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: { ...requestHeaders, Cookie: owner.cookie },
      body: JSON.stringify(syncMutation),
    });
    assert.equal(syncRetry.status, 200);
    assert.equal((await syncRetry.json()).deduplicated, true);

    const isolatedSync = await fetch(`${baseUrl}/api/auth/sync`, {
      headers: { Cookie: replier.cookie },
    });
    const isolatedSyncBody = await isolatedSync.json();
    assert.equal(isolatedSync.status, 200);
    assert.equal(isolatedSyncBody.revision, 0);

    const staleSync = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: { ...requestHeaders, Cookie: owner.cookie },
      body: JSON.stringify({
        ...syncMutation,
        mutationId: `ci-sync-${suffix}-0002`,
      }),
    });
    assert.equal(staleSync.status, 409);
    assert.equal((await staleSync.json()).revision, 1);

    const ratings = {
      courseOrganization: 5,
      contentClarity: 4,
      assessmentExplanation: 4,
      classroomInteraction: 3,
      materialCompleteness: 5,
    };
    const reviewCreated = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/my-review`,
      {
        method: "PUT",
        headers: { ...requestHeaders, Cookie: owner.cookie },
        body: JSON.stringify({
          body: "课程结构清楚，课堂示例能帮助理解概念之间的关系。",
          ratings,
        }),
      },
    );
    const reviewCreatedBody = await reviewCreated.json();
    assert.equal(reviewCreated.status, 201);
    assert.equal(reviewCreatedBody.review.version, 1);

    const otherUsersReview = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/my-review`,
      { headers: { Cookie: replier.cookie } },
    );
    assert.equal(otherUsersReview.status, 200);
    assert.deepEqual(await otherUsersReview.json(), { review: null });

    const competingUpdates = await Promise.all([
      "第一次并发更新补充了作业反馈与课堂节奏。",
      "第二次并发更新补充了例题难度与讲解速度。",
    ].map((body) =>
      fetch(`${baseUrl}/api/teachers/${teacherId}/my-review`, {
        method: "PUT",
        headers: { ...requestHeaders, Cookie: owner.cookie },
        body: JSON.stringify({ body, ratings, expectedVersion: 1 }),
      })
    ));
    assert.deepEqual(
      competingUpdates.map((response) => response.status).sort(),
      [200, 409],
    );

    const publicReviews = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/reviews?limit=20`,
    );
    const publicReviewsBody = await publicReviews.json();
    assert.equal(publicReviews.status, 200);
    assert.equal(publicReviewsBody.items.length, 1);
    assert.equal(publicReviewsBody.items[0].sourceType, "user");

    const enrollment = adminSecurity.createEnrollment({
      userId: administrator.body.user.id,
      accountLabel: administrator.body.user.email,
    });
    await store.bootstrapAdmin({
      userId: administrator.body.user.id,
      enrollment,
    });

    const revokedBootstrapSession = await fetch(
      `${baseUrl}/api/auth/session`,
      { headers: { Cookie: administrator.cookie } },
    );
    assert.equal(revokedBootstrapSession.status, 200);
    assert.equal((await revokedBootstrapSession.json()).authenticated, false);

    const adminLogins = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({
            identifier: `ci-admin-${suffix}@example.com`,
            password: "Moonlight!2026",
          }),
        })
      ),
    );
    assert.deepEqual(adminLogins.map((response) => response.status), [200, 200]);
    const adminBaseCookies = adminLogins.map(cookieHeader);

    const totp = adminSecurityTest.codeForStep(
      enrollment.secret,
      Math.floor(Date.now() / 1_000 / 30),
    );
    const elevationAttempts = await Promise.all(
      adminBaseCookies.map((cookie) =>
        fetch(`${baseUrl}/api/admin/elevation`, {
          method: "POST",
          headers: { ...requestHeaders, Cookie: cookie },
          body: JSON.stringify({ code: totp }),
        })
      ),
    );
    assert.deepEqual(
      elevationAttempts.map((response) => response.status).sort(),
      [200, 403],
    );
    const elevationIndex = elevationAttempts.findIndex(
      (response) => response.status === 200,
    );
    const elevation = elevationAttempts[elevationIndex];
    const adminBaseCookie = adminBaseCookies[elevationIndex];
    const elevationCookie = cookieHeader(elevation);
    assert.match(elevationCookie, /__Host-dufesh_admin_elevation=/u);
    const elevatedAdminCookie = `${adminBaseCookie}; ${elevationCookie}`;

    const recoveryAttempts = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetch(`${baseUrl}/api/admin/elevation`, {
          method: "POST",
          headers: { ...requestHeaders, Cookie: adminBaseCookie },
          body: JSON.stringify({ code: enrollment.recoveryCodes[0] }),
        })
      ),
    );
    assert.deepEqual(
      recoveryAttempts.map((response) => response.status).sort(),
      [200, 403],
    );

    const adminSession = await fetch(`${baseUrl}/api/admin/session`, {
      headers: { Cookie: elevatedAdminCookie },
    });
    assert.equal(adminSession.status, 200);
    assert.deepEqual(
      { role: (await adminSession.json()).role },
      { role: "admin" },
    );

    const reportResponse = await fetch(`${baseUrl}/api/community/reports`, {
      method: "POST",
      headers: { ...requestHeaders, Cookie: replier.cookie },
      body: JSON.stringify({
        targetType: "topic",
        targetId: topicBody.topic.id,
        reasonCode: "spam",
        detail: "原生 PostgreSQL 管理流程使用的测试举报。",
      }),
    });
    const reportBody = await reportResponse.json();
    assert.equal(reportResponse.status, 201);

    const reports = await fetch(
      `${baseUrl}/api/admin/community/reports?status=open`,
      { headers: { Cookie: elevatedAdminCookie } },
    );
    const reportsBody = await reports.json();
    assert.equal(reports.status, 200);
    assert.equal(reportsBody.reports.length, 1);
    assert.equal(reportsBody.reports[0].id, reportBody.report.id);
    assert.equal(reportsBody.reports[0].evidenceBody.includes("真实 HTTP"), true);

    const openedCase = await fetch(
      `${baseUrl}/api/admin/community/reports/${reportBody.report.id}/case`,
      {
        method: "POST",
        headers: { ...requestHeaders, Cookie: elevatedAdminCookie },
        body: JSON.stringify({ reason: "测试举报进入管理员人工复核流程" }),
      },
    );
    const openedCaseBody = await openedCase.json();
    assert.equal(openedCase.status, 200);
    assert.equal(openedCaseBody.case.status, "reviewing");

    const hidden = await fetch(
      `${baseUrl}/api/admin/community/cases/${openedCaseBody.case.id}/actions`,
      {
        method: "POST",
        headers: { ...requestHeaders, Cookie: elevatedAdminCookie },
        body: JSON.stringify({
          action: "hide",
          reason: "验证隐藏、通知与双审计位于同一事务",
        }),
      },
    );
    const hiddenBody = await hidden.json();
    assert.equal(hidden.status, 200);
    assert.equal(hiddenBody.case.action, "hide");

    const hiddenTopic = await fetch(
      `${baseUrl}/api/community/topics/${topicBody.topic.id}`,
    );
    assert.equal(hiddenTopic.status, 404);
    assert.deepEqual(await hiddenTopic.json(), {
      error: "community_topic_unavailable",
      status: "hidden",
      fallbackPath: "/community",
    });

    const audit = await fetch(`${baseUrl}/api/admin/audit`, {
      headers: { Cookie: elevatedAdminCookie },
    });
    const auditBody = await audit.json();
    assert.equal(audit.status, 200);
    assert.equal(
      auditBody.events.some(
        (event) => event.action === "admin.community.hide",
      ),
      true,
    );
  } finally {
    await closeServer(server);
    await store.close();
    await fixtureOwner.end();
  }
});
