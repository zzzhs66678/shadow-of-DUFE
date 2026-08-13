import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { __test, createAdminSecurity } from "../src/admin-security.mjs";
import { createTokenBucket } from "../src/rate-limit.mjs";
import { createAuthServer } from "../src/server.mjs";
import { createOpaqueToken, tokenDigest } from "../src/tokens.mjs";

const now = 1_700_000_000_000;
const tokenPepper = "test-token-pepper-that-is-longer-than-thirty-two-chars";
const recoveryPepper =
  "test-recovery-pepper-that-is-longer-than-thirty-two-chars";
const activeKeyId = "test-v1";
const keyring = { [activeKeyId]: randomBytes(32).toString("base64") };
const adminId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const reportId = "00000000-0000-4000-8000-000000000003";
const moderationCaseId = "00000000-0000-4000-8000-000000000004";
const teacherReviewCandidateId = "00000000-0000-4000-8000-000000000005";
const announcementId = "00000000-0000-4000-8000-000000000008";
const adminSecurity = createAdminSecurity({
  activeKeyId,
  keyring,
  recoveryPepper,
  now: () => now,
});

const config = {
  tokenPepper,
  allowedOrigins: new Set(["https://dufesh.cn"]),
  sessionCookie: "__Host-dufesh_session",
  deviceCookie: "__Host-dufesh_device",
  oauthCookie: "__Host-dufesh_oauth",
  adminCookie: "__Host-dufesh_admin_elevation",
  adminEnabled: true,
  adminElevationTtlSeconds: 600,
  sessionMaxAgeSeconds: 2_592_000,
  deviceMaxAgeSeconds: 31_536_000,
  oauthTtlSeconds: 600,
  credentialsEnabled: false,
  passwordResetMode: "disabled",
  wechatMode: "disabled",
};

function createAdminStore() {
  const adminTokenOne = createOpaqueToken();
  const adminTokenTwo = createOpaqueToken();
  const userToken = createOpaqueToken();
  const enrollment = adminSecurity.createEnrollment({
    userId: adminId,
    accountLabel: "admin@dufesh.cn",
  });
  const sessions = new Map([
    [
      tokenDigest(adminTokenOne, tokenPepper),
      { id: "admin-session-1", userId: adminId, role: "admin" },
    ],
    [
      tokenDigest(adminTokenTwo, tokenPepper),
      { id: "admin-session-2", userId: adminId, role: "admin" },
    ],
    [
      tokenDigest(userToken, tokenPepper),
      { id: "user-session-1", userId, role: "user" },
    ],
  ]);
  const elevations = new Map();
  const recoveryHashes = new Set(enrollment.recoveryCodeHashes);
  const audit = [];
  let lastTotpStep = null;
  let sensitiveCalls = 0;
  let teacherReviewStatus = "pending";
  const announcements = [];
  const adminInputs = [];
  const target = {
    id: userId,
    username: "student",
    displayName: "学生",
    email: "student@example.com",
    emailVerified: false,
    schoolAccountVerified: false,
    status: "active",
    role: "user",
    createdAt: new Date(0).toISOString(),
    lastLoginAt: null,
  };

  return {
    tokens: { adminTokenOne, adminTokenTwo, userToken },
    enrollment,
    audit,
    adminInputs,
    get sensitiveCalls() {
      return sensitiveCalls;
    },
    async health() {},
    async getActiveSession(hash) {
      return sessions.get(hash) ?? null;
    },
    async getAdminAccessState(input) {
      sensitiveCalls += 1;
      const elevation = input.elevationTokenHash
        ? elevations.get(input.elevationTokenHash)
        : null;
      return {
        mfaConfigured: true,
        elevated:
          elevation?.userId === input.userId &&
          elevation?.sessionId === input.sessionId,
        elevatedUntil: elevation?.expiresAt?.toISOString() ?? null,
      };
    },
    async getAdminMfaCredential() {
      sensitiveCalls += 1;
      return {
        factorId: enrollment.factorId,
        encrypted: enrollment.encrypted,
        lastTotpStep,
      };
    },
    async createAdminElevationFromTotp(input) {
      sensitiveCalls += 1;
      if (lastTotpStep !== null && input.matchedStep <= lastTotpStep) {
        return false;
      }
      lastTotpStep = input.matchedStep;
      elevations.set(input.tokenHash, input);
      audit.push({ action: "admin.elevation.created", method: "totp" });
      return true;
    },
    async createAdminElevationFromRecovery(input) {
      sensitiveCalls += 1;
      if (!recoveryHashes.delete(input.recoveryCodeHash)) return false;
      elevations.set(input.tokenHash, input);
      audit.push({
        action: "admin.elevation.created",
        method: "recovery_code",
      });
      return true;
    },
    async revokeAdminElevation(input) {
      sensitiveCalls += 1;
      return elevations.delete(input.elevationTokenHash);
    },
    async getAdminOverview() {
      sensitiveCalls += 1;
      return {
        totalUsers: 2,
        activeUsers: target.status === "active" ? 2 : 1,
        disabledUsers: target.status === "disabled" ? 1 : 0,
        administrators: 1,
        verifiedEmails: 0,
        registrationTrend: Array.from({ length: 30 }, (_, index) => {
          const date = new Date(Date.UTC(2023, 9, 16 + index));
          return {
            date: date.toISOString().slice(0, 10),
            count: index === 29 ? 2 : 0,
          };
        }),
      };
    },
    async listAdminUsers(input) {
      sensitiveCalls += 1;
      adminInputs.push(["listAdminUsers", structuredClone(input)]);
      return {
        users: [structuredClone(target)],
        nextCursor: {
          createdAt: target.createdAt,
          id: target.id,
        },
      };
    },
    async getAdminUserPublicProfile(input) {
      sensitiveCalls += 1;
      adminInputs.push(["getAdminUserPublicProfile", structuredClone(input)]);
      if (input.userId !== target.id) return null;
      return {
        profile: {
          id: target.id,
          username: target.username,
          displayName: target.displayName,
          avatarUrl: null,
          joinedAt: target.createdAt,
          topicCount: 1,
          commentCount: 1,
          accountStatus: target.status,
        },
        items: input.kind === "comments"
          ? [{
              kind: "comment",
              id: reportId,
              topicId: moderationCaseId,
              topicTitle: "公开主题",
              body: "公开回复",
              publicPath: `/community/topics/${moderationCaseId}`,
              createdAt: target.createdAt,
              editedAt: null,
            }]
          : [{
              kind: "topic",
              id: moderationCaseId,
              title: "公开主题",
              body: "公开正文",
              publicPath: `/community/topics/${moderationCaseId}`,
              createdAt: target.createdAt,
              updatedAt: target.createdAt,
              editedAt: null,
            }],
        nextCursor: null,
      };
    },
    async listAdminAudit() {
      sensitiveCalls += 1;
      return structuredClone(audit);
    },
    async listAdminCommunityAnnouncements() {
      sensitiveCalls += 1;
      return structuredClone(announcements);
    },
    async publishCommunityAnnouncement(input) {
      sensitiveCalls += 1;
      const existing = announcements.find((item) => item.id === input.mutationId);
      if (existing) {
        if (
          existing.title !== input.title ||
          existing.body !== input.body ||
          existing.fallbackPath !== input.fallbackPath
        ) {
          const error = new Error("announcement mutation conflict");
          error.code = "COMMUNITY_ANNOUNCEMENT_MUTATION_CONFLICT";
          throw error;
        }
        return { ...structuredClone(existing), duplicate: true };
      }
      const announcement = {
        id: input.mutationId,
        title: input.title,
        body: input.body,
        fallbackPath: input.fallbackPath,
        audience: "all_active",
        deliveryCount: 2,
        createdByLabel: "值守员",
        createdAt: new Date(now).toISOString(),
      };
      announcements.unshift(announcement);
      audit.push({
        action: "admin.community.announcement_published",
        targetId: input.mutationId,
      });
      return { ...structuredClone(announcement), duplicate: false };
    },
    async listAdminTeacherReviewCandidates(input) {
      sensitiveCalls += 1;
      if (input.status !== teacherReviewStatus) return [];
      return [{
        id: teacherReviewCandidateId,
        teacher: {
          id: "00000000-0000-4000-8000-000000000006",
          displayName: "测试教师",
          collegeName: "测试学院",
        },
        body: "这是一条已经脱敏并等待人工判断的历史评价。",
        riskFlags: ["time_sensitive_assessment_claim"],
        status: teacherReviewStatus,
        moderationReason: null,
        moderatedAt: null,
        publicReviewId: null,
        createdAt: new Date(now).toISOString(),
      }];
    },
    async moderateAdminTeacherReviewCandidate(input) {
      sensitiveCalls += 1;
      if (input.candidateId !== teacherReviewCandidateId) {
        const error = new Error("candidate not found");
        error.code = "TEACHER_REVIEW_CANDIDATE_NOT_FOUND";
        throw error;
      }
      if (teacherReviewStatus !== "pending") {
        const error = new Error("candidate conflict");
        error.code = "TEACHER_REVIEW_CANDIDATE_CONFLICT";
        throw error;
      }
      teacherReviewStatus = input.decision === "approve" ? "approved" : "rejected";
      const publicReviewId = input.decision === "approve"
        ? "00000000-0000-4000-8000-000000000007"
        : null;
      audit.push({
        action: `admin.teacher_review.${input.decision}`,
        candidateId: input.candidateId,
        reason: input.reason,
      });
      return {
        id: input.candidateId,
        status: teacherReviewStatus,
        publicReviewId,
        moderatedAt: new Date(now).toISOString(),
      };
    },
    async listCommunityReportQueue(input) {
      sensitiveCalls += 1;
      return [{
        id: reportId,
        targetType: "user",
        targetId: userId,
        targetLabel: "student",
        targetStatus: "active",
        activeSanctionType: null,
        allowedActions: ["warn", "suspend", "ban", "dismiss"],
        evidenceTitle: "student",
        evidenceBody: null,
        evidenceAuthorLabel: "student",
        evidenceCapturedAt: new Date(now).toISOString(),
        reasonCode: "harassment",
        detail: "持续发布针对个人的攻击内容。",
        status: input.status,
        caseId: null,
      }];
    },
    async openCommunityModerationCase(input) {
      sensitiveCalls += 1;
      audit.push({
        action: "admin.community.case_opened",
        reportId: input.reportId,
        reason: input.reason,
      });
      return {
        id: moderationCaseId,
        targetType: "user",
        targetId: userId,
        status: "reviewing",
        created: true,
      };
    },
    async applyCommunityModerationAction(input) {
      sensitiveCalls += 1;
      audit.push({
        action: `admin.community.${input.action}`,
        caseId: input.caseId,
        reason: input.reason,
      });
      return {
        id: moderationCaseId,
        targetType: "user",
        targetId: userId,
        status: "resolved",
        action: input.action,
      };
    },
    async updateAdminUserStatus(input) {
      sensitiveCalls += 1;
      if (input.targetUserId !== target.id) return null;
      if (input.expectedStatus && input.expectedStatus !== target.status) {
        return { conflict: true, currentStatus: target.status };
      }
      const previous = target.status;
      target.status = input.status;
      if (input.status === "disabled") {
        for (const [hash, session] of sessions) {
          if (session.userId === target.id) sessions.delete(hash);
        }
        for (const [hash, elevation] of elevations) {
          if (elevation.userId === target.id) elevations.delete(hash);
        }
      }
      audit.push({
        action: "admin.user.status_changed",
        targetId: target.id,
        before: previous,
        after: target.status,
      });
      return {
        conflict: false,
        user: {
          id: target.id,
          username: target.username,
          status: target.status,
          role: target.role,
        },
      };
    },
  };
}

async function withAdminServer(callback, options = {}) {
  const store = createAdminStore();
  const rateLimiters = options.rateLimiters;
  const server = createAuthServer({
    store,
    config,
    wechatProvider: { mode: "disabled" },
    passwordService: null,
    avatarProcessor: null,
    adminSecurity,
    ...(rateLimiters ? { rateLimiters } : {}),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback({
      baseUrl: `http://127.0.0.1:${address.port}`,
      store,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function baseCookie(token) {
  return `${config.sessionCookie}=${token}`;
}

function adminCookieFrom(response) {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${config.adminCookie}=`));
}

async function elevatedCookie(baseUrl, store) {
  const code = __test.codeForStep(
    store.enrollment.secret,
    Math.floor(now / 1_000 / 30),
  );
  const response = await fetch(`${baseUrl}/api/admin/elevation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://dufesh.cn",
      Cookie: baseCookie(store.tokens.adminTokenOne),
    },
    body: JSON.stringify({ code }),
  });
  assert.equal(response.status, 200);
  return `${baseCookie(store.tokens.adminTokenOne)}; ${
    adminCookieFrom(response).split(";", 1)[0]
  }`;
}

test("admin routes reject anonymous and ordinary users before sensitive queries", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const anonymous = await fetch(`${baseUrl}/api/admin/users`);
    assert.equal(anonymous.status, 401);

    const ordinary = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Cookie: baseCookie(store.tokens.userToken) },
    });
    assert.equal(ordinary.status, 403);
    assert.deepEqual(await ordinary.json(), { error: "admin_forbidden" });
    const community = await fetch(
      `${baseUrl}/api/admin/community/reports`,
      { headers: { Cookie: baseCookie(store.tokens.userToken) } },
    );
    assert.equal(community.status, 403);
    const teacherReviews = await fetch(
      `${baseUrl}/api/admin/teacher-reviews/candidates`,
      { headers: { Cookie: baseCookie(store.tokens.userToken) } },
    );
    assert.equal(teacherReviews.status, 403);
    assert.equal(store.sensitiveCalls, 0);
  });
});

test("TOTP elevation is strict-cookie bound to one base session and rejects replay", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const step = Math.floor(now / 1_000 / 30);
    const code = __test.codeForStep(store.enrollment.secret, step);
    const elevated = await fetch(`${baseUrl}/api/admin/elevation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: baseCookie(store.tokens.adminTokenOne),
      },
      body: JSON.stringify({ code }),
    });
    assert.equal(elevated.status, 200);
    const elevationCookie = adminCookieFrom(elevated);
    assert.match(elevationCookie, /HttpOnly/u);
    assert.match(elevationCookie, /Secure/u);
    assert.match(elevationCookie, /SameSite=Strict/u);
    const elevationPair = elevationCookie.split(";", 1)[0];

    const authorized = await fetch(`${baseUrl}/api/admin/users`, {
      headers: {
        Cookie: `${baseCookie(store.tokens.adminTokenOne)}; ${elevationPair}`,
      },
    });
    assert.equal(authorized.status, 200);
    const users = (await authorized.json()).users;
    assert.equal(users[0].email, undefined);
    assert.equal(users[0].emailMasked, "st***@example.com");

    const crossSession = await fetch(`${baseUrl}/api/admin/users`, {
      headers: {
        Cookie: `${baseCookie(store.tokens.adminTokenTwo)}; ${elevationPair}`,
      },
    });
    assert.equal(crossSession.status, 403);
    assert.deepEqual(await crossSession.json(), {
      error: "admin_mfa_required",
    });

    const replay = await fetch(`${baseUrl}/api/admin/elevation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: baseCookie(store.tokens.adminTokenTwo),
      },
      body: JSON.stringify({ code }),
    });
    assert.equal(replay.status, 403);
    assert.deepEqual(await replay.json(), { error: "admin_mfa_invalid" });
  });
});

test("admin overview exposes a zero-filled 30-day registration trend", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const cookie = await elevatedCookie(baseUrl, store);
    const response = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    const { overview } = await response.json();
    assert.equal(overview.registrationTrend.length, 30);
    assert.deepEqual(overview.registrationTrend[0], {
      date: "2023-10-16",
      count: 0,
    });
    assert.deepEqual(overview.registrationTrend.at(-1), {
      date: "2023-11-14",
      count: 2,
    });

    const unknown = await fetch(`${baseUrl}/api/admin/overview?days=90`, {
      headers: { Cookie: cookie },
    });
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), {
      error: "invalid_admin_overview_query",
    });
  });
});

test("admin user listing validates filters and returns an opaque keyset cursor", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const cookie = await elevatedCookie(baseUrl, store);
    const response = await fetch(
      `${baseUrl}/api/admin/users?query=%EF%BC%B3tudent&role=user&status=active&registeredFrom=2023-01-01&registeredTo=2023-12-31&limit=20`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.users.length, 1);
    assert.equal(payload.users[0].email, undefined);
    assert.equal(payload.users[0].emailMasked, "st***@example.com");
    assert.equal(typeof payload.nextCursor, "string");
    assert.ok(payload.nextCursor.length > 10);
    assert.deepEqual(store.adminInputs.at(-1), [
      "listAdminUsers",
      {
        query: "Student",
        role: "user",
        status: "active",
        registeredFrom: "2023-01-01",
        registeredTo: "2023-12-31",
        cursor: null,
        limit: 20,
      },
    ]);

    const next = await fetch(
      `${baseUrl}/api/admin/users?cursor=${encodeURIComponent(payload.nextCursor)}&limit=1`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(next.status, 200);
    assert.deepEqual(store.adminInputs.at(-1)[1].cursor, {
      createdAt: new Date(0).toISOString(),
      id: userId,
    });

    const invalidQueries = [
      "role=owner",
      "status=deleted",
      "registeredFrom=2023-02-30",
      "registeredFrom=2023-12-31&registeredTo=2023-01-01",
      "limit=0",
      "limit=51",
      "cursor=not-a-cursor",
      "unknown=true",
      "role=user&role=admin",
    ];
    for (const query of invalidQueries) {
      const invalid = await fetch(`${baseUrl}/api/admin/users?${query}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(invalid.status, 400, query);
      assert.deepEqual(await invalid.json(), { error: "invalid_admin_query" });
    }
  });
});

test("admin public profile is paged, ignores community blocks and leaks no private account fields", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const cookie = await elevatedCookie(baseUrl, store);
    const response = await fetch(
      `${baseUrl}/api/admin/users/${userId}/public-profile?kind=comments&limit=12`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.kind, "comments");
    assert.equal(payload.profile.accountStatus, "active");
    assert.equal(payload.profile.email, undefined);
    assert.equal(payload.profile.emailMasked, undefined);
    assert.equal(payload.profile.role, undefined);
    assert.equal(payload.profile.lastLoginAt, undefined);
    assert.equal(payload.profile.schoolAccount, undefined);
    assert.equal(payload.items[0].kind, "comment");
    assert.equal(
      payload.items[0].publicPath,
      `/community/topics/${moderationCaseId}`,
    );
    assert.equal(payload.nextCursor, null);
    assert.deepEqual(store.adminInputs.at(-1), [
      "getAdminUserPublicProfile",
      {
        userId,
        kind: "comments",
        cursor: null,
        limit: 12,
      },
    ]);

    for (const query of ["kind=private", "limit=51", "blocked=true"]) {
      const invalid = await fetch(
        `${baseUrl}/api/admin/users/${userId}/public-profile?${query}`,
        { headers: { Cookie: cookie } },
      );
      assert.equal(invalid.status, 400, query);
      assert.deepEqual(await invalid.json(), {
        error: "invalid_admin_public_profile_query",
      });
    }

    const missing = await fetch(
      `${baseUrl}/api/admin/users/00000000-0000-4000-8000-000000000099/public-profile`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "admin_user_not_found" });
  });
});

test("recovery codes are single-use and untrusted origins never reach MFA storage", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const rejected = await fetch(`${baseUrl}/api/admin/elevation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        Cookie: baseCookie(store.tokens.adminTokenOne),
      },
      body: JSON.stringify({ code: store.enrollment.recoveryCodes[0] }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(store.sensitiveCalls, 0);

    const useRecovery = () =>
      fetch(`${baseUrl}/api/admin/elevation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://dufesh.cn",
          Cookie: baseCookie(store.tokens.adminTokenOne),
        },
        body: JSON.stringify({ code: store.enrollment.recoveryCodes[0] }),
      });
    const first = await useRecovery();
    const second = await useRecovery();
    assert.equal(first.status, 200);
    assert.equal(second.status, 403);
  });
});

test("elevated administrators disable users with audit and optimistic status checks", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const code = __test.codeForStep(
      store.enrollment.secret,
      Math.floor(now / 1_000 / 30),
    );
    const elevated = await fetch(`${baseUrl}/api/admin/elevation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: baseCookie(store.tokens.adminTokenOne),
      },
      body: JSON.stringify({ code }),
    });
    const elevationPair = adminCookieFrom(elevated).split(";", 1)[0];
    const cookie = `${baseCookie(store.tokens.adminTokenOne)}; ${elevationPair}`;

    const disabled = await fetch(
      `${baseUrl}/api/admin/users/${userId}/status`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://dufesh.cn",
          Cookie: cookie,
        },
        body: JSON.stringify({
          status: "disabled",
          expectedStatus: "active",
          reason: "测试账号异常行为，暂停访问等待复核",
        }),
      },
    );
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).user.status, "disabled");
    assert.equal(
      store.audit.filter(
        (event) => event.action === "admin.user.status_changed",
      ).length,
      1,
    );

    const oldUserSession = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Cookie: baseCookie(store.tokens.userToken) },
    });
    assert.equal(oldUserSession.status, 401);
    assert.deepEqual(await oldUserSession.json(), {
      error: "authentication_required",
    });
  });
});

test("elevated administrators open and resolve community cases with audit", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const cookie = await elevatedCookie(baseUrl, store);
    const reports = await fetch(
      `${baseUrl}/api/admin/community/reports?status=open`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(reports.status, 200);
    assert.equal((await reports.json()).reports[0].id, reportId);

    const opened = await fetch(
      `${baseUrl}/api/admin/community/reports/${reportId}/case`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://dufesh.cn",
          Cookie: cookie,
        },
        body: JSON.stringify({ reason: "举报内容需要进入人工复核流程" }),
      },
    );
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).case.status, "reviewing");

    const acted = await fetch(
      `${baseUrl}/api/admin/community/cases/${moderationCaseId}/actions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://dufesh.cn",
          Cookie: cookie,
        },
        body: JSON.stringify({
          action: "suspend",
          durationHours: 24,
          reason: "确认存在持续骚扰行为，暂停发布一天",
        }),
      },
    );
    assert.equal(acted.status, 200);
    assert.equal((await acted.json()).case.action, "suspend");
    assert.ok(
      store.audit.some(
        (event) => event.action === "admin.community.case_opened",
      ),
    );
    assert.ok(
      store.audit.some(
        (event) => event.action === "admin.community.suspend",
      ),
    );
  });
});

test("system announcements require strict input and retry without duplicate delivery", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const cookie = await elevatedCookie(baseUrl, store);
    const request = (body, origin = "https://dufesh.cn") =>
      fetch(`${baseUrl}/api/admin/community/announcements`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      });
    const payload = {
      mutationId: announcementId,
      title: "  选课服务维护提醒  ",
      body: "  今晚二十三时起短暂停止同步，请提前保存。  ",
      fallbackPath: "/community?from=announcement",
    };

    const crossSite = await request(payload, "https://evil.example");
    assert.equal(crossSite.status, 403);
    const invalid = await request({ ...payload, role: "admin" });
    assert.equal(invalid.status, 400);

    const created = await request(payload);
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.announcement.title, "选课服务维护提醒");
    assert.equal(createdBody.announcement.deliveryCount, 2);
    assert.equal(createdBody.announcement.duplicate, false);

    const retried = await request({
      ...payload,
      title: "选课服务维护提醒",
      body: "今晚二十三时起短暂停止同步，请提前保存。",
    });
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).announcement.duplicate, true);
    assert.equal(
      store.audit.filter(
        (event) => event.action === "admin.community.announcement_published",
      ).length,
      1,
    );

    const listed = await fetch(
      `${baseUrl}/api/admin/community/announcements`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(listed.status, 200);
    assert.match(listed.headers.get("cache-control"), /no-store/u);
    assert.equal((await listed.json()).announcements.length, 1);
  });
});

test("community moderation rejects cross-site and mass-assigned actions", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const cookie = await elevatedCookie(baseUrl, store);
    const crossSite = await fetch(
      `${baseUrl}/api/admin/community/reports/${reportId}/case`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          Cookie: cookie,
        },
        body: JSON.stringify({ reason: "这是一条满足长度要求的原因" }),
      },
    );
    assert.equal(crossSite.status, 403);

    const before = store.audit.length;
    const invalid = await fetch(
      `${baseUrl}/api/admin/community/cases/${moderationCaseId}/actions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://dufesh.cn",
          Cookie: cookie,
        },
        body: JSON.stringify({
          action: "hide",
          durationHours: 24,
          reason: "不能把无关持续时间塞进隐藏操作",
          targetId: userId,
        }),
      },
    );
    assert.equal(invalid.status, 400);
    assert.equal(store.audit.length, before);
  });
});

test("elevated administrators review sanitized teacher candidates once", async () => {
  await withAdminServer(async ({ baseUrl, store }) => {
    const cookie = await elevatedCookie(baseUrl, store);
    const list = await fetch(
      `${baseUrl}/api/admin/teacher-reviews/candidates?status=pending&limit=50`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(list.status, 200);
    assert.match(list.headers.get("cache-control"), /no-store/u);
    const listed = await list.json();
    assert.equal(listed.candidates[0].id, teacherReviewCandidateId);
    assert.equal(listed.candidates[0].body.includes("脱敏"), true);
    assert.equal(listed.nextCursor, null);

    const crossSite = await fetch(
      `${baseUrl}/api/admin/teacher-reviews/candidates/${teacherReviewCandidateId}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          Cookie: cookie,
        },
        body: JSON.stringify({ decision: "approve", reason: "人工核对后允许作为历史整理内容公开" }),
      },
    );
    assert.equal(crossSite.status, 403);

    const approve = () => fetch(
      `${baseUrl}/api/admin/teacher-reviews/candidates/${teacherReviewCandidateId}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://dufesh.cn",
          Cookie: cookie,
        },
        body: JSON.stringify({ decision: "approve", reason: "人工核对后允许作为历史整理内容公开" }),
      },
    );
    const accepted = await approve();
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.candidate.status, "approved");
    assert.ok(acceptedBody.candidate.publicReviewId);

    const conflict = await approve();
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      error: "teacher_review_candidate_conflict",
    });
    assert.equal(
      store.audit.filter((event) => event.action === "admin.teacher_review.approve").length,
      1,
    );
  });
});

test("MFA elevation has an independent, injectable rate limit", async () => {
  const permissive = () => createTokenBucket({ capacity: 100, refillPerSecond: 1 });
  await withAdminServer(
    async ({ baseUrl, store }) => {
      const request = () =>
        fetch(`${baseUrl}/api/admin/elevation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://dufesh.cn",
            Cookie: baseCookie(store.tokens.adminTokenOne),
          },
          body: JSON.stringify({ code: "000000" }),
        });
      assert.equal((await request()).status, 403);
      const limited = await request();
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "60");
    },
    {
      rateLimiters: {
        read: permissive(),
        write: permissive(),
        adminMfa: createTokenBucket({
          capacity: 1,
          refillPerSecond: 1 / 60,
        }),
      },
    },
  );
});

test("system announcement publishing has an independent persistent-ready rate limit", async () => {
  const permissive = () => createTokenBucket({ capacity: 100, refillPerSecond: 1 });
  await withAdminServer(
    async ({ baseUrl, store }) => {
      const cookie = await elevatedCookie(baseUrl, store);
      const publish = (mutationId) => fetch(
        `${baseUrl}/api/admin/community/announcements`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://dufesh.cn",
            Cookie: cookie,
          },
          body: JSON.stringify({
            mutationId,
            title: "系统维护提醒",
            body: "请提前保存当前修改。",
            fallbackPath: "/community",
          }),
        },
      );
      assert.equal((await publish(announcementId)).status, 201);
      const limited = await publish("00000000-0000-4000-8000-000000000009");
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "600");
    },
    {
      rateLimiters: {
        read: permissive(),
        write: permissive(),
        adminMfa: permissive(),
        adminAnnouncement: createTokenBucket({
          capacity: 1,
          refillPerSecond: 1 / 600,
        }),
      },
    },
  );
});
