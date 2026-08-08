import assert from "node:assert/strict";
import test from "node:test";
import { __test } from "../src/community-routes.mjs";
import { createAuthServer } from "../src/server.mjs";
import { createOpaqueToken, tokenDigest } from "../src/tokens.mjs";

const tokenPepper = "community-test-pepper-that-is-longer-than-thirty-two";
const sessionCookie = "__Host-dufesh_session";
const userId = "00000000-0000-4000-8000-000000000011";
const topicId = "00000000-0000-4000-8000-000000000021";
const commentId = "00000000-0000-4000-8000-000000000031";
const nextTopicId = "00000000-0000-4000-8000-000000000022";

const config = {
  tokenPepper,
  allowedOrigins: new Set(["https://dufesh.cn"]),
  sessionCookie,
  deviceCookie: "__Host-dufesh_device",
  oauthCookie: "__Host-dufesh_oauth",
  adminCookie: "__Host-dufesh_admin_elevation",
  adminEnabled: false,
  sessionMaxAgeSeconds: 2_592_000,
  deviceMaxAgeSeconds: 31_536_000,
  oauthTtlSeconds: 600,
  credentialsEnabled: false,
  passwordResetMode: "disabled",
  emailVerificationMode: "disabled",
  wechatMode: "disabled",
};

function createCommunityStore() {
  const sessionToken = createOpaqueToken();
  const calls = [];
  let sessionLookups = 0;
  return {
    sessionToken,
    calls,
    get sessionLookups() {
      return sessionLookups;
    },
    async getActiveSession(hash) {
      sessionLookups += 1;
      if (hash !== tokenDigest(sessionToken, tokenPepper)) return null;
      return { id: "session-1", userId, role: "user" };
    },
    async listCommunityTopics(input) {
      calls.push(["listCommunityTopics", structuredClone(input)]);
      return {
        items: [{ id: topicId, title: "选课之后，你会怎样整理一周？" }],
        nextCursor: {
          id: nextTopicId,
          createdAt: "2026-08-09T08:00:00.000Z",
        },
      };
    },
    async getCommunityTopic(input) {
      calls.push(["getCommunityTopic", structuredClone(input)]);
      if (input.topicId === nextTopicId) {
        return {
          id: nextTopicId,
          status: "deleted",
          fallbackPath: "/community",
        };
      }
      if (input.topicId !== topicId) return null;
      return { id: topicId, status: "published", title: "主题" };
    },
    async listCommunityComments(input) {
      calls.push(["listCommunityComments", structuredClone(input)]);
      return {
        items: [{ id: commentId, topicId, body: "把课表先排清楚。" }],
        nextCursor: null,
      };
    },
    async createCommunityTopic(input) {
      calls.push(["createCommunityTopic", structuredClone(input)]);
      return { id: topicId, status: "published", version: 1 };
    },
    async updateCommunityTopic(input) {
      calls.push(["updateCommunityTopic", structuredClone(input)]);
      if (input.expectedVersion === 99) {
        throw Object.assign(new Error("conflict"), {
          code: "COMMUNITY_VERSION_CONFLICT",
          currentVersion: 2,
        });
      }
      return { id: topicId, status: "published", version: 2 };
    },
    async deleteCommunityTopic(input) {
      calls.push(["deleteCommunityTopic", structuredClone(input)]);
      return { id: topicId, status: "deleted", version: 3 };
    },
    async createCommunityComment(input) {
      calls.push(["createCommunityComment", structuredClone(input)]);
      return { id: commentId, topicId, status: "published", version: 1 };
    },
    async updateCommunityComment(input) {
      calls.push(["updateCommunityComment", structuredClone(input)]);
      return { id: commentId, topicId, status: "published", version: 2 };
    },
    async deleteCommunityComment(input) {
      calls.push(["deleteCommunityComment", structuredClone(input)]);
      return { id: commentId, topicId, status: "deleted", version: 3 };
    },
  };
}

async function withServer(callback, options = {}) {
  const store = createCommunityStore();
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
    await callback({ baseUrl: `http://127.0.0.1:${address.port}`, store });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("community cursors are bounded, opaque, and schema-checked", () => {
  const encoded = __test.encodeCursor({
    id: topicId,
    createdAt: "2026-08-09T08:00:00.000Z",
  });
  assert.deepEqual(__test.decodeCursor(encoded), {
    id: topicId,
    createdAt: "2026-08-09T08:00:00.000Z",
  });
  assert.equal(__test.decodeCursor("not-json"), false);
  assert.equal(__test.decodeCursor("a".repeat(257)), false);
  assert.equal(__test.pageLimit("30"), 30);
  assert.equal(__test.pageLimit("31"), null);
});

test("topic list is public and authenticated viewers receive scoped state", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const anonymous = await fetch(`${baseUrl}/api/community/topics?limit=12`);
    assert.equal(anonymous.status, 200);
    const first = await anonymous.json();
    assert.equal(first.items[0].id, topicId);
    assert.equal(typeof first.nextCursor, "string");
    assert.deepEqual(store.calls[0][1], {
      viewerUserId: null,
      cursor: null,
      limit: 12,
    });

    const signedIn = await fetch(`${baseUrl}/api/community/topics`, {
      headers: { Cookie: `${sessionCookie}=${store.sessionToken}` },
    });
    assert.equal(signedIn.status, 200);
    assert.equal(store.calls[1][1].viewerUserId, userId);
  });
});

test("invalid community queries fail before data access", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const invalidLimit = await fetch(
      `${baseUrl}/api/community/topics?limit=999`,
    );
    assert.equal(invalidLimit.status, 400);
    const invalidSort = await fetch(
      `${baseUrl}/api/community/topics?sort=hot`,
    );
    assert.equal(invalidSort.status, 400);
    assert.equal(store.calls.length, 0);
  });
});

test("topic detail and root-page comments preserve unavailable fallbacks", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const detail = await fetch(
      `${baseUrl}/api/community/topics/${topicId}`,
    );
    assert.equal(detail.status, 200);

    const comments = await fetch(
      `${baseUrl}/api/community/topics/${topicId}/comments`,
    );
    assert.equal(comments.status, 200);
    assert.equal((await comments.json()).items[0].id, commentId);

    const deleted = await fetch(
      `${baseUrl}/api/community/topics/${nextTopicId}`,
    );
    assert.equal(deleted.status, 410);
    assert.deepEqual(await deleted.json(), {
      error: "community_topic_unavailable",
      status: "deleted",
      fallbackPath: "/community",
    });
    assert.ok(store.calls.some(([name]) => name === "listCommunityComments"));
  });
});

test("community writes reject cross-site and anonymous requests before mutation", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const crossSite = await fetch(`${baseUrl}/api/community/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookie}=${store.sessionToken}`,
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ title: "这是一个主题", body: "正文" }),
    });
    assert.equal(crossSite.status, 403);
    assert.equal(store.sessionLookups, 0);

    const anonymous = await fetch(`${baseUrl}/api/community/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
      },
      body: JSON.stringify({ title: "这是一个主题", body: "正文" }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal(
      store.calls.some(([name]) => name === "createCommunityTopic"),
      false,
    );
  });
});

test("signed-in users create, edit, and soft-delete topics with exact input", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const headers = {
      "Content-Type": "application/json",
      Cookie: `${sessionCookie}=${store.sessionToken}`,
      Origin: "https://dufesh.cn",
    };
    const created = await fetch(`${baseUrl}/api/community/topics`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "  图书馆闭馆后去哪？ ",
        body: " 想找个安静的地方。 ",
        visibility: "public",
      }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(
      store.calls.find(([name]) => name === "createCommunityTopic")[1],
      {
        userId,
        title: "图书馆闭馆后去哪?",
        body: "想找个安静的地方。",
        visibility: "public",
      },
    );

    const massAssignment = await fetch(`${baseUrl}/api/community/topics`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "这是另一个主题",
        body: "正文",
        authorUserId: nextTopicId,
      }),
    });
    assert.equal(massAssignment.status, 400);

    const edited = await fetch(
      `${baseUrl}/api/community/topics/${topicId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body: "更新后的正文", version: 1 }),
      },
    );
    assert.equal(edited.status, 200);

    const deleted = await fetch(
      `${baseUrl}/api/community/topics/${topicId}`,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({ version: 2 }),
      },
    );
    assert.equal(deleted.status, 200);
    assert.ok(store.calls.some(([name]) => name === "deleteCommunityTopic"));
  });
});

test("comment writes preserve reply targets and version conflicts are explicit", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const headers = {
      "Content-Type": "application/json",
      Cookie: `${sessionCookie}=${store.sessionToken}`,
      Origin: "https://dufesh.cn",
    };
    const reply = await fetch(
      `${baseUrl}/api/community/topics/${topicId}/comments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "我也会去那里。", replyToCommentId: commentId }),
      },
    );
    assert.equal(reply.status, 201);
    assert.deepEqual(
      store.calls.find(([name]) => name === "createCommunityComment")[1],
      { topicId, userId, body: "我也会去那里。", replyToCommentId: commentId },
    );

    const conflict = await fetch(
      `${baseUrl}/api/community/topics/${topicId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body: "冲突修改", version: 99 }),
      },
    );
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      error: "community_version_conflict",
      currentVersion: 2,
    });

    const edited = await fetch(`${baseUrl}/api/community/comments/${commentId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body: "修改后的回复", version: 1 }),
    });
    assert.equal(edited.status, 200);
    const deleted = await fetch(`${baseUrl}/api/community/comments/${commentId}`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ version: 2 }),
    });
    assert.equal(deleted.status, 200);
  });
});

test("community mutations consume independent user and IP rate-limit keys", async () => {
  const keys = [];
  const allow = { consume: () => true };
  await withServer(async ({ baseUrl, store }) => {
    const response = await fetch(`${baseUrl}/api/community/topics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookie}=${store.sessionToken}`,
        Origin: "https://dufesh.cn",
      },
      body: JSON.stringify({ title: "这是限流测试主题", body: "正文" }),
    });
    assert.equal(response.status, 201);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  }, {
    rateLimiters: {
      read: allow,
      write: allow,
      communityWrite: {
        consume(key) {
          keys.push(key);
          return true;
        },
      },
    },
  });
});
