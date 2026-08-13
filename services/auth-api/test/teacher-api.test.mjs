import assert from "node:assert/strict";
import test from "node:test";

import { createAuthServer } from "../src/server.mjs";
import { createOpaqueToken, tokenDigest } from "../src/tokens.mjs";

const teacherId = "00000000-0000-4000-8000-000000000201";
const reviewId = "00000000-0000-4000-8000-000000000202";
const userId = "00000000-0000-4000-8000-000000000203";
const secondTeacherId = "00000000-0000-4000-8000-000000000204";

const config = {
  tokenPepper: "teacher-api-test-pepper-that-is-at-least-thirty-two-characters",
  allowedOrigins: new Set(["https://dufesh.cn"]),
  sessionCookie: "__Host-dufesh_session",
  deviceCookie: "__Host-dufesh_device",
  oauthCookie: "__Host-dufesh_oauth",
  adminCookie: "__Host-dufesh_admin_elevation",
  adminEnabled: false,
  adminElevationTtlSeconds: 600,
  sessionMaxAgeSeconds: 2_592_000,
  deviceMaxAgeSeconds: 31_536_000,
  oauthTtlSeconds: 600,
  credentialsEnabled: false,
  passwordResetMode: "disabled",
  wechatMode: "disabled",
};

function createStore() {
  let calls = 0;
  let ownReview = null;
  const sessionToken = createOpaqueToken();
  const summary = {
    id: teacherId,
    displayName: "测试教师",
    collegeName: "测试学院",
    courseCount: 2,
    reviewCount: 1,
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
  return {
    sessionToken,
    get calls() { return calls; },
    async health() {},
    async getActiveSession(hash) {
      calls += 1;
      return hash === tokenDigest(sessionToken, config.tokenPepper)
        ? { id: "teacher-session", userId, role: "user" }
        : null;
    },
    async listPublicTeachers(input) {
      calls += 1;
      assert.equal(input.limit, 30);
      return [{
        ...summary,
        cursor: { normalizedName: "测试教师", normalizedCollege: "测试学院", id: teacherId },
      }];
    },
    async listPublicTeachersBySchedule(input) {
      calls += 1;
      assert.equal(input.catalogId, "C1");
      if (input.scheduleId === "fall-C1-01-empty") return [];
      assert.equal(input.scheduleId, "fall-C1-01-1");
      return [
        summary,
        { ...summary, id: secondTeacherId, displayName: "第二位教师" },
      ];
    },
    async getPublicTeacherDetail(id) {
      calls += 1;
      return id === teacherId ? {
        ...summary,
        ratings: {
          courseOrganization: null,
          contentClarity: null,
          assessmentExplanation: null,
          classroomInteraction: null,
          materialCompleteness: null,
        },
        sections: [{ id: "section-1", courseId: "C1", courseTitle: "课程一" }],
        textbooks: [{ id: "textbook-1", title: "教材一", selectionStatus: "specified" }],
      } : null;
    },
    async listPublicTeacherReviews(input) {
      calls += 1;
      assert.equal(input.teacherId, teacherId);
      assert.equal(typeof input.query, "string");
      assert.ok(["latest", "discussed", "relevant"].includes(input.sort));
      return [{
        id: reviewId,
        sourceType: "legacy_approved",
        authorLabel: "历史整理内容",
        body: "已经通过人工审核的历史评价。",
        ratings: null,
        discussionCount: 2,
        publishedAt: "2026-08-09T00:00:00.000Z",
        cursor: { publishedAt: "2026-08-09T00:00:00.000Z", id: reviewId },
      }];
    },
    async getUserTeacherReview(input) {
      calls += 1;
      assert.deepEqual(input, { teacherId, userId });
      return ownReview;
    },
    async saveUserTeacherReview(input) {
      calls += 1;
      assert.equal(input.teacherId, teacherId);
      assert.equal(input.userId, userId);
      ownReview = {
        id: reviewId,
        sourceType: "user",
        authorLabel: "已注册用户",
        body: input.body,
        ratings: input.ratings,
        status: "published",
        version: input.expectedVersion === null ? 1 : input.expectedVersion + 1,
        publishedAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      };
      return ownReview;
    },
    async deleteUserTeacherReview(input) {
      calls += 1;
      assert.equal(input.expectedVersion, ownReview.version);
      ownReview = null;
      return { id: reviewId, status: "deleted", version: input.expectedVersion + 1 };
    },
  };
}

async function withServer(callback, options = {}) {
  const store = createStore();
  const server = createAuthServer({
    store,
    config,
    wechatProvider: { mode: "disabled" },
    passwordService: null,
    avatarProcessor: null,
    adminSecurity: null,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("teacher index and detail expose only public catalog facts", async () => {
  await withServer(async (baseUrl) => {
    const list = await fetch(`${baseUrl}/api/teachers?q=%E6%B5%8B%E8%AF%95&limit=30`);
    assert.equal(list.status, 200);
    assert.match(list.headers.get("cache-control"), /max-age=60/u);
    const listBody = await list.json();
    assert.equal(listBody.items[0].id, teacherId);
    assert.equal(listBody.items[0].sourceDigest, undefined);
    assert.equal(listBody.items[0].identityStatus, undefined);
    assert.equal(listBody.nextCursor, null);

    const detail = await fetch(`${baseUrl}/api/teachers/${teacherId}`);
    assert.equal(detail.status, 200);
    const teacher = (await detail.json()).teacher;
    assert.equal(teacher.sections[0].courseTitle, "课程一");
    assert.equal(teacher.textbooks[0].title, "教材一");

    const reviews = await fetch(`${baseUrl}/api/teachers/${teacherId}/reviews?limit=20`);
    assert.equal(reviews.status, 200);
    const reviewBody = await reviews.json();
    assert.equal(reviewBody.items[0].authorLabel, "历史整理内容");
    assert.equal(reviewBody.items[0].ratings, null);
    assert.equal(reviewBody.items[0].discussionCount, 2);

    const searched = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/reviews?q=${encodeURIComponent("课堂组织")}&sort=relevant&limit=20`,
    );
    assert.equal(searched.status, 200);
  });
});

test("teacher schedule lookup returns zero or multiple explicit teacher UUIDs", async () => {
  await withServer(async (baseUrl) => {
    const multiple = await fetch(
      `${baseUrl}/api/teachers/by-schedule?catalogId=C1&scheduleId=fall-C1-01-1`,
    );
    assert.equal(multiple.status, 200);
    assert.match(multiple.headers.get("cache-control"), /max-age=60/u);
    assert.deepEqual(
      (await multiple.json()).items.map((teacher) => teacher.id),
      [teacherId, secondTeacherId],
    );

    const empty = await fetch(
      `${baseUrl}/api/teachers/by-schedule?catalogId=C1&scheduleId=fall-C1-01-empty`,
    );
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { items: [] });
  });
});

test("teacher routes reject malformed filters before data access", async () => {
  await withServer(async (baseUrl, store) => {
    const invalidQuery = await fetch(`${baseUrl}/api/teachers?limit=99`);
    assert.equal(invalidQuery.status, 400);
    const invalidId = await fetch(`${baseUrl}/api/teachers/not-a-uuid`);
    assert.equal(invalidId.status, 404);
    const invalidCursor = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/reviews?after=not-valid%21`,
    );
    assert.equal(invalidCursor.status, 400);
    const relevantWithoutQuery = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/reviews?sort=relevant`,
    );
    assert.equal(relevantWithoutQuery.status, 400);
    const repeatedQuery = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/reviews?q=a&q=b`,
    );
    assert.equal(repeatedQuery.status, 400);
    const invalidDiscussionCursor = Buffer.from(JSON.stringify({
      discussionCount: "not-a-count",
      publishedAt: "2026-08-09T00:00:00.000Z",
      id: reviewId,
    }), "utf8").toString("base64url");
    const invalidDiscussionPage = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/reviews?sort=discussed&after=${invalidDiscussionCursor}`,
    );
    assert.equal(invalidDiscussionPage.status, 400);
    const missingSchedule = await fetch(
      `${baseUrl}/api/teachers/by-schedule?catalogId=C1`,
    );
    assert.equal(missingSchedule.status, 400);
    const extraFilter = await fetch(
      `${baseUrl}/api/teachers/by-schedule?catalogId=C1&scheduleId=fall-C1-01-1&teacherName=guess`,
    );
    assert.equal(extraFilter.status, 400);
    assert.equal(store.calls, 0);
  });
});

test("signed-in users create, edit, and delete only their teacher review resource", async () => {
  await withServer(async (baseUrl, store) => {
    const headers = {
      "Content-Type": "application/json",
      Cookie: `${config.sessionCookie}=${store.sessionToken}`,
      Origin: "https://dufesh.cn",
    };
    const ratings = {
      courseOrganization: 5,
      contentClarity: 4,
      assessmentExplanation: 4,
      classroomInteraction: 3,
      materialCompleteness: 5,
    };

    const crossSite = await fetch(`${baseUrl}/api/teachers/${teacherId}/my-review`, {
      method: "PUT",
      headers: { ...headers, Origin: "https://attacker.example" },
      body: JSON.stringify({ body: "这是一条足够完整的跨站评价内容，不应进入数据层。", ratings }),
    });
    assert.equal(crossSite.status, 403);

    const created = await fetch(`${baseUrl}/api/teachers/${teacherId}/my-review`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ body: "课程结构清楚，课堂示例能帮助理解概念之间的关系。", ratings }),
    });
    assert.equal(created.status, 201);
    assert.match(created.headers.get("cache-control"), /no-store/u);
    const createdBody = await created.json();
    assert.equal(createdBody.review.version, 1);

    const mine = await fetch(`${baseUrl}/api/teachers/${teacherId}/my-review`, {
      headers: { Cookie: `${config.sessionCookie}=${store.sessionToken}` },
    });
    assert.equal(mine.status, 200);
    assert.equal((await mine.json()).review.body, "课程结构清楚,课堂示例能帮助理解概念之间的关系。");

    const updated = await fetch(`${baseUrl}/api/teachers/${teacherId}/my-review`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        body: "课程结构清楚，更新后的评价补充了作业反馈与课堂节奏。",
        ratings,
        expectedVersion: 1,
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).review.version, 2);

    const removed = await fetch(`${baseUrl}/api/teachers/${teacherId}/my-review`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ version: 2 }),
    });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).review.status, "deleted");
  });
});

test("teacher review input rejects mass assignment and unauthenticated writes", async () => {
  await withServer(async (baseUrl, store) => {
    const ratings = {
      courseOrganization: 5,
      contentClarity: 4,
      assessmentExplanation: 4,
      classroomInteraction: 3,
      materialCompleteness: 5,
    };
    const anonymous = await fetch(`${baseUrl}/api/teachers/${teacherId}/my-review`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "https://dufesh.cn" },
      body: JSON.stringify({ body: "这条匿名评价不会被接受，因为没有有效登录会话。", ratings }),
    });
    assert.equal(anonymous.status, 401);

    const massAssigned = await fetch(`${baseUrl}/api/teachers/${teacherId}/my-review`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${config.sessionCookie}=${store.sessionToken}`,
        Origin: "https://dufesh.cn",
      },
      body: JSON.stringify({
        body: "这条评价字段本身有效，但额外尝试指定发布状态。",
        ratings,
        status: "published",
      }),
    });
    assert.equal(massAssigned.status, 400);
  });
});

test("teacher review writes keep account and shared-network quotas independent", async () => {
  let accountCalls = 0;
  let networkCalls = 0;
  const accountLimiter = {
    consume() {
      accountCalls += 1;
      return accountCalls <= 6;
    },
  };
  const networkLimiter = {
    consume() {
      networkCalls += 1;
      return networkCalls <= 60;
    },
  };
  await withServer(async (baseUrl, store) => {
    const headers = {
      "Content-Type": "application/json",
      Cookie: `${config.sessionCookie}=${store.sessionToken}`,
      Origin: "https://dufesh.cn",
    };
    const body = JSON.stringify({
      body: "课程结构清楚，课堂示例能帮助理解概念之间的关系。",
      ratings: {
        courseOrganization: 5,
        contentClarity: 4,
        assessmentExplanation: 4,
        classroomInteraction: 3,
        materialCompleteness: 5,
      },
    });
    const statuses = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/teachers/${teacherId}/my-review`, {
        method: "PUT",
        headers,
        body,
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 201, 429]);
    assert.equal(accountCalls, 7);
    assert.equal(networkCalls, 6);
  }, {
    rateLimiters: {
      read: { consume: () => true },
      write: { consume: () => true },
      teacherReviewWrite: accountLimiter,
      teacherReviewIp: networkLimiter,
    },
  });
});
