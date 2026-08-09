import assert from "node:assert/strict";
import test from "node:test";

import { createAuthServer } from "../src/server.mjs";

const teacherId = "00000000-0000-4000-8000-000000000201";
const reviewId = "00000000-0000-4000-8000-000000000202";

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
  const summary = {
    id: teacherId,
    displayName: "测试教师",
    collegeName: "测试学院",
    courseCount: 2,
    reviewCount: 1,
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
  return {
    get calls() { return calls; },
    async health() {},
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
