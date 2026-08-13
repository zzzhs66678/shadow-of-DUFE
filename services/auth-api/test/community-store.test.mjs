import assert from "node:assert/strict";
import test from "node:test";
import {
  communityModerationAllowedActions,
  createCommunityStore,
} from "../src/community-store.mjs";

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

test("private community indexes page relationships and redact unavailable bookmarks", async () => {
  const blockedUserId = "00000000-0000-4000-8000-000000000012";
  const unavailableTopicId = "00000000-0000-4000-8000-000000000022";
  const pool = {
    async query(sql, values) {
      if (sql.includes("FROM community_topic_bookmarks")) {
        assert.deepEqual(values, [viewerId, null, null, 3]);
        return { rows: [
          {
            topic_id: topicId,
            bookmarked_at: new Date("2026-08-12T08:00:00.000Z"),
            title: "值得再读的讨论",
            body_preview: "只返回列表需要的正文摘要。",
            status: "published",
            author_user_id: blockedUserId,
            author_username: "student-b",
            author_display_name: "同学乙",
            author_avatar_url: null,
            blocked: false,
          },
          {
            topic_id: unavailableTopicId,
            bookmarked_at: new Date("2026-08-11T08:00:00.000Z"),
            title: "不应泄露",
            body_preview: "不应泄露",
            status: "hidden",
            author_user_id: blockedUserId,
            author_username: "student-b",
            author_display_name: "同学乙",
            author_avatar_url: null,
            blocked: false,
          },
          {
            topic_id: "00000000-0000-4000-8000-000000000023",
            bookmarked_at: new Date("2026-08-10T08:00:00.000Z"),
            status: "published",
            blocked: true,
          },
        ] };
      }
      assert.match(sql, /FROM community_user_blocks AS blocks/u);
      assert.deepEqual(values, [viewerId, null, null, 2]);
      return { rows: [{
        blocked_user_id: blockedUserId,
        blocked_at: new Date("2026-08-12T07:00:00.000Z"),
        username: "student-b",
        display_name: "同学乙",
        avatar_url: null,
      }] };
    },
  };
  const store = createCommunityStore(pool);
  const bookmarks = await store.listCommunityBookmarks({ userId: viewerId, limit: 2 });
  assert.equal(bookmarks.items.length, 2);
  assert.equal(bookmarks.items[0].status, "available");
  assert.equal(bookmarks.items[0].bodyPreview, "只返回列表需要的正文摘要。");
  assert.deepEqual(bookmarks.items[1], {
    topicId: unavailableTopicId,
    status: "unavailable",
    title: null,
    bodyPreview: null,
    author: null,
    publicPath: "/community",
    bookmarkedAt: "2026-08-11T08:00:00.000Z",
  });
  assert.deepEqual(bookmarks.nextCursor, {
    createdAt: "2026-08-11T08:00:00.000Z",
    id: unavailableTopicId,
  });

  const blocks = await store.listCommunityBlocks({ userId: viewerId, limit: 1 });
  assert.equal(blocks.items[0].user.id, blockedUserId);
  assert.equal(blocks.nextCursor, null);
});

test("community hot feed ranks real engagement against one bounded snapshot", async () => {
  const queries = [];
  const rankedAt = "2026-08-11T08:00:00.000Z";
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      return {
        rowCount: 3,
        rows: [
          topicRow({ hot_score: "18", ranked_at: new Date(rankedAt) }),
          topicRow({
            id: "00000000-0000-4000-8000-000000000022",
            created_at: new Date("2026-08-09T07:00:00.000Z"),
            hot_score: "16",
            ranked_at: new Date(rankedAt),
          }),
          topicRow({
            id: "00000000-0000-4000-8000-000000000023",
            created_at: new Date("2026-08-09T06:00:00.000Z"),
            hot_score: "15",
            ranked_at: new Date(rankedAt),
          }),
        ],
      };
    },
  };
  const store = createCommunityStore(pool);
  const result = await store.listCommunityTopics({
    viewerUserId: viewerId,
    sort: "hot",
    cursor: {
      id: "00000000-0000-4000-8000-000000000020",
      createdAt: "2026-08-09T09:00:00.000Z",
      rankedAt,
      score: "19",
    },
    limit: 2,
  });

  assert.equal(result.items.length, 2);
  assert.deepEqual(result.nextCursor, {
    id: "00000000-0000-4000-8000-000000000022",
    createdAt: "2026-08-09T07:00:00.000Z",
    rankedAt,
    score: "16",
  });
  assert.deepEqual(queries[0].values, [
    viewerId,
    rankedAt,
    "19",
    "2026-08-09T09:00:00.000Z",
    "00000000-0000-4000-8000-000000000020",
    3,
  ]);
  assert.match(queries[0].sql, /count\(\*\) \* 2/u);
  assert.match(queries[0].sql, /count\(\*\) \* 3/u);
  assert.match(queries[0].sql, /interval '14 days'/u);
  assert.match(
    queries[0].sql,
    /ORDER BY hot_topics\.hot_score DESC,[\s\S]*visible_topics\.created_at DESC/u,
  );
});

test("public profiles hide blocked accounts and list only public authored content", async () => {
  const calls = [];
  const profileUserId = "00000000-0000-4000-8000-000000000012";
  const profileCommentId = "00000000-0000-4000-8000-000000000041";
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("FROM app_users AS users")) {
        return {
          rowCount: 1,
          rows: [{
            id: profileUserId,
            username: "corridor-student",
            display_name: "回廊同学",
            avatar_url: null,
            created_at: new Date("2026-08-01T08:00:00Z"),
            topic_count: "2",
            comment_count: "3",
          }],
        };
      }
      if (
        sql.includes("FROM community_comments AS comments") &&
        sql.includes("JOIN community_topics AS topics ON topics.id = comments.topic_id")
      ) {
        return {
          rowCount: 1,
          rows: [{
            id: profileCommentId,
            topic_id: topicId,
            topic_title: "图书馆闭馆之后，你会去哪里？",
            body: "公开回复",
            created_at: new Date("2026-08-09T09:00:00Z"),
            edited_at: null,
            like_count: "4",
            viewer_liked: true,
          }],
        };
      }
      return { rowCount: 1, rows: [topicRow({ author_user_id: profileUserId })] };
    },
  };
  const store = createCommunityStore(pool);
  const profile = await store.getCommunityUserProfile({
    userId: profileUserId,
    viewerUserId: viewerId,
  });
  assert.deepEqual(profile, {
    id: profileUserId,
    username: "corridor-student",
    displayName: "回廊同学",
    avatarUrl: null,
    joinedAt: "2026-08-01T08:00:00.000Z",
    topicCount: 2,
    commentCount: 3,
  });
  assert.match(calls[0].sql, /users\.status = 'active'/u);
  assert.match(calls[0].sql, /community_user_blocks/u);

  const topics = await store.listCommunityUserContent({
    userId: profileUserId,
    viewerUserId: viewerId,
    kind: "topics",
    limit: 20,
  });
  assert.equal(topics.items[0].author.id, profileUserId);
  assert.match(calls[1].sql, /topics\.visibility = 'public'/u);
  assert.match(calls[1].sql, /profile_user\.status = 'active'/u);
  assert.deepEqual(calls[1].values, [viewerId, profileUserId, null, null, 21]);

  const comments = await store.listCommunityUserContent({
    userId: profileUserId,
    viewerUserId: viewerId,
    kind: "comments",
    limit: 20,
  });
  assert.deepEqual(comments.items[0], {
    id: profileCommentId,
    topicId,
    topicTitle: "图书馆闭馆之后，你会去哪里？",
    body: "公开回复",
    likeCount: 4,
    liked: true,
    createdAt: "2026-08-09T09:00:00.000Z",
    editedAt: null,
  });
  assert.match(calls[2].sql, /comments\.status = 'published'/u);
  assert.match(calls[2].sql, /topics\.visibility = 'public'/u);
  assert.match(calls[2].sql, /profile_user\.status = 'active'/u);
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
  assert.ok(
    calls.some(({ sql }) => sql.includes("INSERT INTO community_notifications")),
  );

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

test("likes are idempotent and verify account, content, and block state", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("sanction_type = 'ban'")) {
        return { rowCount: 1, rows: [{ status: "active", banned: false }] };
      }
      if (sql.includes("FROM community_topics AS topics")) {
        return {
          rowCount: 1,
          rows: [{
            id: topicId,
            author_user_id: "00000000-0000-4000-8000-000000000012",
            status: "published",
            blocked: false,
          }],
        };
      }
      if (sql.includes("INSERT INTO community_topic_likes")) {
        return { rowCount: 1, rows: [{ active: true, total: "3" }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  assert.deepEqual(
    await store.setCommunityLike({
      targetType: "topic",
      targetId: topicId,
      userId: viewerId,
      active: true,
    }),
    { active: true, total: 3 },
  );
  assert.match(
    calls.find(({ sql }) => sql.includes("INSERT INTO community_topic_likes")).sql,
    /ON CONFLICT DO NOTHING/u,
  );
  assert.ok(calls.some(({ sql }) => sql.includes("community_user_blocks")));
});

test("blocking a user removes bilateral reactions and the blocker's bookmark", async () => {
  const blockedUserId = "00000000-0000-4000-8000-000000000012";
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("sanction_type = 'ban'")) {
        return { rowCount: 1, rows: [{ status: "active", banned: true }] };
      }
      if (sql.includes("SELECT id FROM app_users")) {
        return { rowCount: 1, rows: [{ id: blockedUserId }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  assert.deepEqual(
    await store.setCommunityBlock({
      blockerUserId: viewerId,
      blockedUserId,
      active: true,
    }),
    { active: true },
  );
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO community_user_blocks")));
  assert.ok(calls.some(({ sql }) => sql.includes("DELETE FROM community_topic_likes")));
  assert.ok(calls.some(({ sql }) => sql.includes("DELETE FROM community_comment_likes")));
  assert.ok(calls.some(({ sql }) => sql.includes("DELETE FROM community_topic_bookmarks")));
  assert.ok(calls.some(({ sql }) => sql.includes("UPDATE community_notifications")));
});

test("duplicate open reports reuse immutable evidence instead of inserting another row", async () => {
  const otherUserId = "00000000-0000-4000-8000-000000000012";
  const reportId = "00000000-0000-4000-8000-000000000041";
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("sanction_type = 'ban'")) {
        return { rowCount: 1, rows: [{ status: "active", banned: true }] };
      }
      if (sql.includes("AS evidence_title")) {
        return {
          rowCount: 1,
          rows: [{
            evidence_title: "被举报的主题",
            evidence_body: "提交举报时看到的原始正文。",
            evidence_author_label: "另一位同学",
          }],
        };
      }
      if (sql.includes("FROM community_topics")) {
        return {
          rowCount: 1,
          rows: [{
            id: topicId,
            author_user_id: otherUserId,
            status: "published",
            blocked: false,
          }],
        };
      }
      if (sql.includes("INSERT INTO community_reports")) {
        return {
          rowCount: 1,
          rows: [{
            id: reportId,
            target_type: "topic",
            target_id: topicId,
            reason_code: "spam",
            status: "open",
            created: false,
            created_at: new Date("2026-08-09T10:00:00Z"),
            updated_at: new Date("2026-08-09T10:00:00Z"),
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  const report = await store.createCommunityReport({
    reporterUserId: viewerId,
    targetType: "topic",
    targetId: topicId,
    reasonCode: "spam",
    detail: "同一广告重复发布。",
  });
  assert.equal(report.id, reportId);
  assert.equal(report.created, false);
  assert.match(
    calls.find(({ sql }) => sql.includes("INSERT INTO community_reports")).sql,
    /ON CONFLICT \(reporter_user_id, target_type, target_id\)[\s\S]*?DO NOTHING/u,
  );
  const insert = calls.find(({ sql }) => sql.includes("INSERT INTO community_reports"));
  assert.match(insert.sql, /evidence_title, evidence_body, evidence_author_label/u);
  assert.deepEqual(insert.values.slice(5), [
    "被举报的主题",
    "提交举报时看到的原始正文。",
    "另一位同学",
  ]);
});

test("moderation queue exposes immutable evidence and state-safe actions", async () => {
  const reportId = "00000000-0000-4000-8000-000000000041";
  const pool = {
    async query(sql) {
      assert.match(sql, /reports\.evidence_body/u);
      assert.match(sql, /active_sanction/u);
      return {
        rowCount: 1,
        rows: [{
          id: reportId,
          target_type: "topic",
          target_id: topicId,
          target_label: "被举报的主题",
          target_status: "hidden",
          active_sanction_type: null,
          reporter_username: "reporter",
          reason_code: "harassment",
          detail: "包含针对个人的持续攻击。",
          status: "reviewing",
          case_id: "00000000-0000-4000-8000-000000000061",
          case_status: "reviewing",
          evidence_title: "被举报的主题",
          evidence_body: "提交举报时留存的原始正文。",
          evidence_author_label: "内容作者",
          evidence_captured_at: new Date("2026-08-09T09:00:00Z"),
          created_at: new Date("2026-08-09T09:00:00Z"),
          updated_at: new Date("2026-08-09T10:00:00Z"),
        }, {
          id: "00000000-0000-4000-8000-000000000042",
          target_type: "user",
          target_id: "00000000-0000-4000-8000-000000000043",
          target_label: "已停用用户",
          target_status: "disabled",
          active_sanction_type: null,
          reporter_username: "reporter",
          reason_code: "spam",
          detail: "该账号已经由账号值守流程停用。",
          status: "reviewing",
          case_id: "00000000-0000-4000-8000-000000000062",
          case_status: "reviewing",
          evidence_title: "已停用用户",
          evidence_body: null,
          evidence_author_label: "已停用用户",
          evidence_captured_at: new Date("2026-08-09T09:00:00Z"),
          created_at: new Date("2026-08-09T09:00:00Z"),
          updated_at: new Date("2026-08-09T10:00:00Z"),
        }],
      };
    },
  };
  const [report, disabledUser] = await createCommunityStore(pool).listCommunityReportQueue({
    status: "reviewing",
  });
  assert.equal(report.evidenceBody, "提交举报时留存的原始正文。");
  assert.deepEqual(report.allowedActions, ["restore", "delete"]);
  assert.deepEqual(disabledUser.allowedActions, ["dismiss"]);
});

test("moderation actions preserve a path to reverse active interventions", () => {
  assert.deepEqual(
    communityModerationAllowedActions("topic", "hidden"),
    ["restore", "delete"],
  );
  assert.deepEqual(
    communityModerationAllowedActions("user", "active", "ban"),
    ["unban"],
  );
  assert.deepEqual(
    communityModerationAllowedActions("user", "disabled", "ban"),
    ["dismiss"],
  );
});

test("topic mentions resolve normalized usernames and create deduplicated notifications", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("FROM app_users AS users") && sql.includes("sanctioned")) {
        return { rowCount: 1, rows: [{ status: "active", sanctioned: false }] };
      }
      if (sql.includes("INSERT INTO community_topics")) {
        return {
          rowCount: 1,
          rows: [{
            id: topicId,
            status: "published",
            visibility: "public",
            version: 1,
            created_at: new Date("2026-08-09T08:00:00Z"),
            updated_at: new Date("2026-08-09T08:00:00Z"),
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  await store.createCommunityTopic({
    userId: viewerId,
    title: "想问问图书馆闭馆时间",
    body: "@Student_01 你上周去过吗？再次提及 @student_01",
    visibility: "public",
  });
  const mention = calls.find(({ sql }) => sql.includes("INSERT INTO community_mentions"));
  assert.deepEqual(mention.values[0], ["student_01"]);
  assert.match(mention.sql, /ON CONFLICT DO NOTHING/u);
  assert.match(mention.sql, /INSERT INTO community_notifications/u);
  assert.match(mention.sql, /community_user_blocks/u);
});

test("notification reads and mutations remain scoped to the recipient", async () => {
  const notificationId = "00000000-0000-4000-8000-000000000051";
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("ORDER BY notifications.created_at")) {
        return {
          rowCount: 1,
          rows: [{
            id: notificationId,
            notification_type: "topic_reply",
            topic_id: topicId,
            comment_id: rootId,
            title: "有人回复了你的主题",
            body: "我也想知道。",
            fallback_path: `/community/topics/${topicId}`,
            actor_user_id: "00000000-0000-4000-8000-000000000012",
            actor_username: "another_student",
            actor_display_name: "另一位同学",
            actor_avatar_url: null,
            created_at: new Date("2026-08-09T11:00:00Z"),
            read_at: null,
          }],
        };
      }
      if (sql.includes("SET read_at = COALESCE") && sql.includes("RETURNING id, read_at")) {
        return {
          rowCount: 1,
          rows: [{
            id: notificationId,
            read_at: new Date("2026-08-09T12:00:00Z"),
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  const store = createCommunityStore(pool);
  const list = await store.listCommunityNotifications({
    userId: viewerId,
    limit: 20,
  });
  assert.equal(list.items[0].actor.displayName, "另一位同学");
  assert.equal(list.items[0].read, false);
  assert.match(calls[0].sql, /notifications\.recipient_user_id = \$1::uuid/u);
  assert.match(calls[0].sql, /community_user_blocks/u);

  const marked = await store.markCommunityNotificationRead({
    userId: viewerId,
    notificationId,
  });
  assert.equal(marked.id, notificationId);
  assert.deepEqual(calls[1].values, [notificationId, viewerId]);
  assert.match(calls[1].sql, /recipient_user_id = \$2::uuid/u);
});

test("system announcements recheck elevation and atomically fan out once", async () => {
  const adminId = "00000000-0000-4000-8000-000000000001";
  const announcementId = "00000000-0000-4000-8000-000000000091";
  const createdAt = new Date("2026-08-11T08:00:00Z");
  const calls = [];
  let stored = null;
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("JOIN admin_elevated_sessions")) {
        return {
          rowCount: 1,
          rows: [{ role: "admin", status: "active", actor_label: "值守员" }],
        };
      }
      if (sql.includes("FROM community_announcements") && sql.includes("WHERE id")) {
        return { rowCount: stored ? 1 : 0, rows: stored ? [stored] : [] };
      }
      if (sql.includes("INSERT INTO community_notifications")) {
        return { rowCount: 3, rows: [] };
      }
      if (sql.includes("INSERT INTO community_announcements")) {
        stored = {
          id: announcementId,
          title: values[1],
          body: values[2],
          fallback_path: values[3],
          audience: "all_active",
          delivery_count: values[4],
          created_by_admin_user_id: adminId,
          created_by_label: values[6],
          created_at: createdAt,
        };
        return { rowCount: 1, rows: [stored] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  const input = {
    actorUserId: adminId,
    actorSessionId: "00000000-0000-4000-8000-000000000071",
    actorElevationTokenHash: "elevation-hash",
    mutationId: announcementId,
    title: "选课服务维护提醒",
    body: "今晚二十三时起短暂停止同步，请提前保存。",
    fallbackPath: "/community?from=announcement",
    requestId: "00000000-0000-4000-8000-000000000081",
    ipHash: "ip-hash",
    userAgentHash: "ua-hash",
  };
  const created = await store.publishCommunityAnnouncement(input);
  assert.equal(created.deliveryCount, 3);
  assert.equal(created.duplicate, false);
  assert.ok(calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock")));
  assert.ok(calls.some(({ sql }) => sql.includes("users.status = 'active'")));
  assert.ok(calls.some(({ sql }) => sql.includes("actor_user_id, actor_role")));
  assert.equal(calls.at(-1).sql, "COMMIT");

  const deliveredBeforeRetry = calls.filter(({ sql }) =>
    sql.includes("INSERT INTO community_notifications")
  ).length;
  const retried = await store.publishCommunityAnnouncement(input);
  assert.equal(retried.duplicate, true);
  assert.equal(
    calls.filter(({ sql }) => sql.includes("INSERT INTO community_notifications")).length,
    deliveredBeforeRetry,
  );
  assert.equal(
    calls.filter(({ sql }) => sql.includes("INSERT INTO admin_audit_events")).length,
    1,
  );
});

test("system announcement delivery stops when administrator elevation is revoked", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("JOIN admin_elevated_sessions")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  await assert.rejects(
    store.publishCommunityAnnouncement({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      actorSessionId: "00000000-0000-4000-8000-000000000071",
      actorElevationTokenHash: "revoked",
      mutationId: "00000000-0000-4000-8000-000000000091",
      title: "选课服务维护提醒",
      body: "今晚二十三时起短暂停止同步，请提前保存。",
      fallbackPath: "/community",
      requestId: "00000000-0000-4000-8000-000000000081",
      ipHash: "ip-hash",
      userAgentHash: "ua-hash",
    }),
    (error) => error.code === "AUTH_ADMIN_FORBIDDEN",
  );
  assert.equal(
    calls.some(({ sql }) => sql.includes("INSERT INTO community_notifications")),
    false,
  );
  assert.equal(calls.at(-1).sql, "ROLLBACK");
});

test("soft-deleting a reply redacts its notification preview in the same transaction", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("FOR UPDATE OF comments")) {
        return {
          rowCount: 1,
          rows: [{
            id: rootId,
            topic_id: topicId,
            author_user_id: viewerId,
            parent_comment_id: null,
            root_comment_id: null,
            body: "准备删除的回复",
            status: "published",
            version: 1,
            actor_label: "东财同学",
          }],
        };
      }
      if (sql.includes("UPDATE community_comments")) {
        return {
          rowCount: 1,
          rows: [{
            id: rootId,
            topic_id: topicId,
            parent_comment_id: null,
            root_comment_id: null,
            status: "deleted",
            version: 2,
            created_at: new Date("2026-08-09T11:00:00Z"),
            updated_at: new Date("2026-08-09T12:00:00Z"),
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  const deleted = await store.deleteCommunityComment({
    commentId: rootId,
    userId: viewerId,
    expectedVersion: 1,
  });
  assert.equal(deleted.status, "deleted");
  const redaction = calls.find(
    ({ sql }) =>
      sql.includes("UPDATE community_notifications") &&
      sql.includes("相关回复已删除"),
  );
  assert.deepEqual(redaction.values, [rootId]);
  assert.match(redaction.sql, /body = NULL/u);
  assert.match(redaction.sql, /fallback_path = '\/community'/u);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("opening a moderation case rechecks elevation and appends both audit trails", async () => {
  const adminId = "00000000-0000-4000-8000-000000000001";
  const reportId = "00000000-0000-4000-8000-000000000041";
  const caseId = "00000000-0000-4000-8000-000000000061";
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("JOIN admin_elevated_sessions")) {
        return {
          rowCount: 1,
          rows: [{ role: "admin", status: "active", actor_label: "管理员" }],
        };
      }
      if (sql.includes("FROM community_reports") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            id: reportId,
            target_type: "topic",
            target_id: topicId,
            status: "open",
          }],
        };
      }
      if (sql.includes("INSERT INTO community_moderation_cases")) {
        return {
          rowCount: 1,
          rows: [{
            id: caseId,
            target_type: "topic",
            target_id: topicId,
            status: "open",
            assigned_moderator_id: adminId,
            created: true,
          }],
        };
      }
      if (sql.includes("INSERT INTO community_case_reports")) {
        return { rowCount: 1, rows: [{ report_id: reportId }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  const result = await store.openCommunityModerationCase({
    actorUserId: adminId,
    actorSessionId: "00000000-0000-4000-8000-000000000071",
    actorElevationTokenHash: "elevation-hash",
    reportId,
    reason: "举报需要进入人工审核流程",
    requestId: "00000000-0000-4000-8000-000000000081",
    ipHash: "ip-hash",
    userAgentHash: "ua-hash",
  });
  assert.equal(result.status, "reviewing");
  assert.ok(calls.some(({ sql }) => sql.includes("FOR UPDATE OF users, sessions, elevation")));
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO community_moderation_actions")));
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO admin_audit_events")));
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("active content listing stays bounded and does not require a report", async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      return {
        rowCount: 1,
        rows: [{
          id: topicId,
          title: "公开主题",
          body: "这是管理员主动巡查目录中的公开正文。",
          status: "published",
          author_label: "东财同学",
          topic_id: topicId,
          case_id: null,
          case_status: null,
          created_at: new Date("2026-08-09T08:00:00.000Z"),
          updated_at: new Date("2026-08-09T08:00:00.000Z"),
        }],
      };
    },
  };
  const result = await createCommunityStore(pool).listAdminCommunityContent({
    type: "topic",
    status: "published",
    query: "主动巡查",
    cursor: null,
    limit: 20,
  });
  assert.equal(result.items[0].id, topicId);
  assert.equal(result.items[0].publicPath, `/community/topics/${topicId}`);
  assert.equal(result.items[0].allowedActions.includes("hide"), true);
  assert.match(queries[0].sql, /community_moderation_cases/u);
  assert.doesNotMatch(queries[0].sql, /community_reports/u);
  assert.deepEqual(queries[0].values, ["topic", "published", "主动巡查", null, null, 20]);
});

test("direct moderation case rechecks content and writes both audit trails atomically", async () => {
  const adminId = "00000000-0000-4000-8000-000000000001";
  const caseId = "00000000-0000-4000-8000-000000000061";
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("JOIN admin_elevated_sessions")) {
        return { rowCount: 1, rows: [{ role: "admin", status: "active", actor_label: "管理员" }] };
      }
      if (sql.includes("FROM community_topics") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: topicId, status: "published" }] };
      }
      if (sql.includes("INSERT INTO community_moderation_cases")) {
        return { rowCount: 1, rows: [{ id: caseId, status: "open" }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const result = await createCommunityStore({ async connect() { return client; } })
    .openDirectCommunityModerationCase({
      actorUserId: adminId,
      actorSessionId: "00000000-0000-4000-8000-000000000071",
      actorElevationTokenHash: "elevation-hash",
      targetType: "topic",
      targetId: topicId,
      reason: "主动巡查发现该主题需要进一步审核",
      requestId: "00000000-0000-4000-8000-000000000081",
      ipHash: "ip-hash",
      userAgentHash: "ua-hash",
    });
  assert.equal(result.created, true);
  assert.deepEqual(result.allowedActions, ["hide", "delete", "warn", "dismiss"]);
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO community_moderation_actions")));
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO admin_audit_events")));
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("moderation hides content, keeps the case reviewable, notifies the author, and audits atomically", async () => {
  const adminId = "00000000-0000-4000-8000-000000000001";
  const authorId = "00000000-0000-4000-8000-000000000012";
  const caseId = "00000000-0000-4000-8000-000000000061";
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("JOIN admin_elevated_sessions")) {
        return {
          rowCount: 1,
          rows: [{ role: "admin", status: "active", actor_label: "管理员" }],
        };
      }
      if (sql.includes("FROM community_moderation_cases") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            id: caseId,
            target_type: "topic",
            target_id: topicId,
            status: "reviewing",
          }],
        };
      }
      if (sql.includes("FROM community_topics") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{ id: topicId, author_user_id: authorId, status: "published" }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  const result = await store.applyCommunityModerationAction({
    actorUserId: adminId,
    actorSessionId: "00000000-0000-4000-8000-000000000071",
    actorElevationTokenHash: "elevation-hash",
    caseId,
    action: "hide",
    reason: "内容包含针对个人的持续攻击，先隐藏处理",
    durationHours: null,
    requestId: "00000000-0000-4000-8000-000000000081",
    ipHash: "ip-hash",
    userAgentHash: "ua-hash",
  });
  assert.equal(result.action, "hide");
  assert.equal(result.status, "reviewing");
  assert.ok(
    calls.some(
      ({ sql }) =>
        sql.includes("UPDATE community_topics") &&
        sql.includes("status = 'hidden'"),
    ),
  );
  assert.ok(calls.some(({ sql }) => sql.includes("UPDATE community_reports AS reports")));
  assert.ok(
    calls.some(
      ({ sql, values }) =>
        sql.includes("UPDATE community_moderation_cases") &&
        values?.[1] === "reviewing",
    ),
  );
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO community_moderation_actions")));
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO admin_audit_events")));
  assert.ok(calls.some(({ sql }) => sql.includes("'content_moderated'")));
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("moderation cannot close a case while hidden content still needs restoration", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("JOIN admin_elevated_sessions")) {
        return {
          rowCount: 1,
          rows: [{ role: "admin", status: "active", actor_label: "管理员" }],
        };
      }
      if (sql.includes("FROM community_moderation_cases") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            id: "00000000-0000-4000-8000-000000000061",
            target_type: "topic",
            target_id: topicId,
            status: "reviewing",
          }],
        };
      }
      if (sql.includes("FROM community_topics") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{ id: topicId, author_user_id: viewerId, status: "hidden" }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  await assert.rejects(
    store.applyCommunityModerationAction({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      actorSessionId: "00000000-0000-4000-8000-000000000071",
      actorElevationTokenHash: "elevation-hash",
      caseId: "00000000-0000-4000-8000-000000000061",
      action: "dismiss",
      reason: "隐藏内容仍需明确恢复或删除，不能直接结案",
      requestId: "00000000-0000-4000-8000-000000000081",
      ipHash: "ip-hash",
      userAgentHash: "ua-hash",
    }),
    (error) => error.code === "COMMUNITY_MODERATION_STATE_CONFLICT",
  );
  assert.equal(
    calls.some((sql) => sql.includes("UPDATE community_moderation_cases")),
    false,
  );
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("moderation cannot close a sanctioned user case before unbanning", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("JOIN admin_elevated_sessions")) {
        return {
          rowCount: 1,
          rows: [{ role: "admin", status: "active", actor_label: "管理员" }],
        };
      }
      if (sql.includes("FROM community_moderation_cases") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            id: "00000000-0000-4000-8000-000000000061",
            target_type: "user",
            target_id: viewerId,
            status: "reviewing",
          }],
        };
      }
      if (sql.includes("FROM app_users") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: viewerId, status: "active" }] };
      }
      if (sql.includes("FROM community_user_sanctions")) {
        return { rowCount: 1, rows: [{ sanction_type: "ban" }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  await assert.rejects(
    store.applyCommunityModerationAction({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      actorSessionId: "00000000-0000-4000-8000-000000000071",
      actorElevationTokenHash: "elevation-hash",
      caseId: "00000000-0000-4000-8000-000000000061",
      action: "warn",
      reason: "仍有生效中的封禁，必须先执行解封动作",
      requestId: "00000000-0000-4000-8000-000000000081",
      ipHash: "ip-hash",
      userAgentHash: "ua-hash",
    }),
    (error) => error.code === "COMMUNITY_MODERATION_STATE_CONFLICT",
  );
  assert.equal(
    calls.some((sql) => sql.includes("UPDATE community_moderation_cases")),
    false,
  );
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("moderation mutations stop before target access when elevation was revoked", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("JOIN admin_elevated_sessions")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const store = createCommunityStore({ async connect() { return client; } });
  await assert.rejects(
    store.openCommunityModerationCase({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      actorSessionId: "00000000-0000-4000-8000-000000000071",
      actorElevationTokenHash: "revoked",
      reportId: "00000000-0000-4000-8000-000000000041",
      reason: "这是一条满足长度要求的审核原因",
      requestId: "00000000-0000-4000-8000-000000000081",
      ipHash: "ip-hash",
      userAgentHash: "ua-hash",
    }),
    (error) => error.code === "AUTH_ADMIN_FORBIDDEN",
  );
  assert.equal(
    calls.some(({ sql }) => sql.includes("FROM community_reports")),
    false,
  );
  assert.equal(calls.at(-1).sql, "ROLLBACK");
});
