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
  return {
    sessionToken,
    calls,
    async getActiveSession(hash) {
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
  };
}

async function withServer(callback) {
  const store = createCommunityStore();
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
