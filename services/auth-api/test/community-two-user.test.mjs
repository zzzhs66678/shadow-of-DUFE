import assert from "node:assert/strict";
import test from "node:test";
import { createAuthServer } from "../src/server.mjs";
import { createOpaqueToken, tokenDigest } from "../src/tokens.mjs";

const tokenPepper = "two-user-community-pepper-longer-than-thirty-two";
const sessionCookie = "__Host-dufesh_session";
const ownerId = "00000000-0000-4000-8000-000000000011";
const replierId = "00000000-0000-4000-8000-000000000012";
const topicId = "00000000-0000-4000-8000-000000000021";
const commentId = "00000000-0000-4000-8000-000000000031";
const notificationId = "00000000-0000-4000-8000-000000000051";

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

test("a reply from user B reaches user A and can be marked read", async () => {
  const ownerToken = createOpaqueToken();
  const replierToken = createOpaqueToken();
  const sessions = new Map([
    [tokenDigest(ownerToken, tokenPepper), { id: "session-a", userId: ownerId }],
    [tokenDigest(replierToken, tokenPepper), { id: "session-b", userId: replierId }],
  ]);
  const notifications = [];
  const store = {
    async getActiveSession(hash) {
      return sessions.get(hash) ?? null;
    },
    async createCommunityComment(input) {
      assert.equal(input.userId, replierId);
      assert.equal(input.topicId, topicId);
      notifications.push({
        id: notificationId,
        recipientUserId: ownerId,
        type: "topic_reply",
        readAt: null,
      });
      return { id: commentId, topicId, status: "published", version: 1 };
    },
    async getCommunityUnreadCount(userId) {
      return notifications.filter(
        (item) => item.recipientUserId === userId && !item.readAt,
      ).length;
    },
    async listCommunityNotifications({ userId }) {
      return {
        items: notifications
          .filter((item) => item.recipientUserId === userId)
          .map((item) => ({
            id: item.id,
            type: item.type,
            read: Boolean(item.readAt),
            fallbackPath: `/community/topics/${topicId}`,
          })),
        nextCursor: null,
      };
    },
    async markCommunityNotificationRead({ userId, notificationId: targetId }) {
      const item = notifications.find(
        (candidate) =>
          candidate.id === targetId && candidate.recipientUserId === userId,
      );
      if (!item) return null;
      item.readAt = "2026-08-09T12:00:00.000Z";
      return { id: item.id, readAt: item.readAt };
    },
  };
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
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const reply = await fetch(
      `${baseUrl}/api/community/topics/${topicId}/comments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${sessionCookie}=${replierToken}`,
          Origin: "https://dufesh.cn",
        },
        body: JSON.stringify({ body: "我也想知道闭馆后的去处。" }),
      },
    );
    assert.equal(reply.status, 201);

    const ownerHeaders = { Cookie: `${sessionCookie}=${ownerToken}` };
    const unread = await fetch(
      `${baseUrl}/api/community/notifications/unread-count`,
      { headers: ownerHeaders },
    );
    assert.deepEqual(await unread.json(), { unread: 1 });
    const list = await fetch(`${baseUrl}/api/community/notifications`, {
      headers: ownerHeaders,
    });
    assert.equal((await list.json()).items[0].type, "topic_reply");

    const marked = await fetch(
      `${baseUrl}/api/community/notifications/${notificationId}`,
      {
        method: "PUT",
        headers: {
          ...ownerHeaders,
          Origin: "https://dufesh.cn",
        },
      },
    );
    assert.equal(marked.status, 200);
    const after = await fetch(
      `${baseUrl}/api/community/notifications/unread-count`,
      { headers: ownerHeaders },
    );
    assert.deepEqual(await after.json(), { unread: 0 });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
