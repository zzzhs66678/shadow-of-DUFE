import assert from "node:assert/strict";
import test from "node:test";
import { createCommunityStore } from "../src/community-store.mjs";

const viewerId = "00000000-0000-4000-8000-000000000011";
const topicId = "00000000-0000-4000-8000-000000000021";
const rootId = "00000000-0000-4000-8000-000000000031";
const replyId = "00000000-0000-4000-8000-000000000032";

function topicRow(overrides = {}) {
  return {
    id: topicId,
    author_user_id: viewerId,
    title: "图书馆闭馆之后，你会去哪里？",
    body: "想找一个晚上还能安静写作业的地方。",
    status: "published",
    visibility: "public",
    version: 1,
    created_at: new Date("2026-08-09T08:00:00.000Z"),
    updated_at: new Date("2026-08-09T08:00:00.000Z"),
    edited_at: null,
    author_username: "student",
    author_display_name: "东财同学",
    author_avatar_url: null,
    blocked_by_viewer: false,
    viewer_blocked_by_author: false,
    like_count: "2",
    comment_count: "1",
    viewer_liked: true,
    viewer_bookmarked: false,
    ...overrides,
  };
}

test("community store uses bounded keyset pagination and maps viewer state", async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      return {
        rowCount: 3,
        rows: [
          topicRow(),
          topicRow({
            id: "00000000-0000-4000-8000-000000000022",
            created_at: new Date("2026-08-09T07:00:00.000Z"),
          }),
          topicRow({
            id: "00000000-0000-4000-8000-000000000023",
            created_at: new Date("2026-08-09T06:00:00.000Z"),
          }),
        ],
      };
    },
  };
  const store = createCommunityStore(pool);
  const result = await store.listCommunityTopics({
    viewerUserId: viewerId,
    cursor: null,
    limit: 2,
  });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].likeCount, 2);
  assert.equal(result.items[0].liked, true);
  assert.equal(result.items[0].author.displayName, "东财同学");
  assert.deepEqual(result.nextCursor, {
    id: "00000000-0000-4000-8000-000000000022",
    createdAt: "2026-08-09T07:00:00.000Z",
  });
  assert.deepEqual(queries[0].values, [viewerId, null, null, 3]);
  assert.match(queries[0].sql, /topics\.created_at, topics\.id/u);
  assert.match(queries[0].sql, /community_user_blocks/u);
});

test("blocked and removed topic details expose only a local fallback", async () => {
  const rows = [
    topicRow({ blocked_by_viewer: true }),
    topicRow({ status: "deleted", body: "不应公开", author_user_id: null }),
  ];
  const pool = {
    async query() {
      const row = rows.shift();
      return { rowCount: 1, rows: [row] };
    },
  };
  const store = createCommunityStore(pool);

  assert.deepEqual(
    await store.getCommunityTopic({ topicId, viewerUserId: viewerId }),
    {
      id: topicId,
      status: "blocked",
      createdAt: "2026-08-09T08:00:00.000Z",
      fallbackPath: "/community",
    },
  );
  assert.deepEqual(
    await store.getCommunityTopic({ topicId, viewerUserId: null }),
    {
      id: topicId,
      status: "deleted",
      createdAt: "2026-08-09T08:00:00.000Z",
      fallbackPath: "/community",
    },
  );
});

test("comment pagination includes one reply level and hides deleted bodies", async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (calls.length === 1) {
        return {
          rowCount: 1,
          rows: [{ id: rootId, created_at: new Date("2026-08-09T08:00:00Z") }],
        };
      }
      return {
        rowCount: 2,
        rows: [
          {
            id: rootId,
            topic_id: topicId,
            author_user_id: viewerId,
            parent_comment_id: null,
            root_comment_id: null,
            reply_to_user_id: null,
            body: "根评论",
            status: "published",
            version: 1,
            created_at: new Date("2026-08-09T08:00:00Z"),
            updated_at: new Date("2026-08-09T08:00:00Z"),
            edited_at: null,
            author_username: "student",
            author_display_name: "东财同学",
            author_avatar_url: null,
            blocked_by_viewer: false,
            like_count: "1",
            viewer_liked: false,
          },
          {
            id: replyId,
            topic_id: topicId,
            author_user_id: null,
            parent_comment_id: rootId,
            root_comment_id: rootId,
            reply_to_user_id: viewerId,
            body: "已经删除",
            status: "deleted",
            version: 2,
            created_at: new Date("2026-08-09T08:05:00Z"),
            updated_at: new Date("2026-08-09T08:06:00Z"),
            edited_at: null,
            author_username: null,
            author_display_name: null,
            author_avatar_url: null,
            blocked_by_viewer: false,
            like_count: "0",
            viewer_liked: false,
          },
        ],
      };
    },
  };
  const store = createCommunityStore(pool);
  const result = await store.listCommunityComments({
    topicId,
    viewerUserId: viewerId,
    limit: 20,
  });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].rootCommentId, rootId);
  assert.equal(result.items[1].body, null);
  assert.equal(result.items[1].author, null);
  assert.deepEqual(calls[1].values, [topicId, viewerId, [rootId]]);
  assert.match(calls[1].sql, /comments\.root_comment_id = ANY/u);
});

test("topic creation checks active sanctions inside the write transaction", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("FROM app_users AS users")) {
        return { rowCount: 1, rows: [{ status: "active", sanctioned: false }] };
      }
      if (sql.includes("INSERT INTO community_topics")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: topicId,
              status: "published",
              visibility: "public",
              version: 1,
              created_at: new Date("2026-08-09T08:00:00Z"),
              updated_at: new Date("2026-08-09T08:00:00Z"),
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {
      calls.push({ sql: "RELEASE" });
    },
  };
  const store = createCommunityStore({ async connect() { return client; } });
  const topic = await store.createCommunityTopic({
    userId: viewerId,
    title: "图书馆闭馆之后去哪里",
    body: "想找一个安静的地方。",
    visibility: "public",
  });

  assert.equal(topic.id, topicId);
  assert.equal(topic.version, 1);
  assert.equal(calls[0].sql, "BEGIN");
  assert.match(calls[1].sql, /community_user_sanctions/u);
  assert.match(calls[2].sql, /INSERT INTO community_topics/u);
  assert.equal(calls[3].sql, "COMMIT");
  assert.equal(calls[4].sql, "RELEASE");
});

test("replying to a reply flattens under its root and conflict edits roll back", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("FROM app_users AS users")) {
        return { rowCount: 1, rows: [{ status: "active", sanctioned: false }] };
      }
      if (sql.includes("FROM community_topics AS topics") && sql.includes("blocked")) {
        return {
          rowCount: 1,
          rows: [{ id: topicId, author_user_id: viewerId, status: "published", blocked: false }],
        };
      }
      if (sql.includes("FROM community_comments") && sql.includes("FOR SHARE")) {
        return {
          rowCount: 1,
          rows: [{
            id: replyId,
            author_user_id: "00000000-0000-4000-8000-000000000012",
            parent_comment_id: rootId,
            root_comment_id: rootId,
            status: "published",
            blocked: false,
          }],
        };
      }
      if (sql.includes("INSERT INTO community_comments")) {
        return {
          rowCount: 1,
          rows: [{
            id: "00000000-0000-4000-8000-000000000033",
            topic_id: topicId,
            parent_comment_id: rootId,
            root_comment_id: rootId,
            status: "published",
            version: 1,
            created_at: new Date("2026-08-09T08:10:00Z"),
            updated_at: new Date("2026-08-09T08:10:00Z"),
          }],
        };
      }
      if (sql.includes("FOR UPDATE OF topics")) {
        return {
          rowCount: 1,
          rows: [{
            ...topicRow(),
            actor_label: "东财同学",
            version: 2,
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {
      calls.push({ sql: "RELEASE" });
    },
  };
  const store = createCommunityStore({ async connect() { return client; } });
  const comment = await store.createCommunityComment({
    topicId,
    userId: viewerId,
    body: "回复第二层评论",
    replyToCommentId: replyId,
  });
  assert.equal(comment.parentCommentId, rootId);
  const insert = calls.find(({ sql }) => sql.includes("INSERT INTO community_comments"));
  assert.equal(insert.values[2], rootId);
  assert.equal(insert.values[3], "00000000-0000-4000-8000-000000000012");

  await assert.rejects(
    store.updateCommunityTopic({
      topicId,
      userId: viewerId,
      expectedVersion: 1,
      body: "过期修改",
    }),
    (error) =>
      error.code === "COMMUNITY_VERSION_CONFLICT" &&
      error.currentVersion === 2,
  );
  assert.equal(calls.filter(({ sql }) => sql === "ROLLBACK").length, 1);
  assert.equal(
    calls.some(({ sql }) => sql.includes("INSERT INTO community_content_edits")),
    false,
  );
});
