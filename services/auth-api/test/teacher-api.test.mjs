import assert from "node:assert/strict";
import test from "node:test";

import { createAuthServer } from "../src/server.mjs";
import { createOpaqueToken, tokenDigest } from "../src/tokens.mjs";

const teacherId = "00000000-0000-4000-8000-000000000201";
const reviewId = "00000000-0000-4000-8000-000000000202";
const userId = "00000000-0000-4000-8000-000000000203";

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
      return [{
        id: reviewId,
        sourceType: "legacy_approved",
        authorLabel: "历史整理内容",
        body: "已经通过人工审核的历史评价。",
        ratings: null,
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

async function withServer(callback) {
  const store = createStore();
  const server = createAuthServer({
    store,
    config,
    wechatProvider: { mode: "disabled" },
    passwordService: null,
    avatarProcessor: null,
    adminSecurity: null,
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
