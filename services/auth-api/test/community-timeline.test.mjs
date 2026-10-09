import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createCommunityStore } from "../src/community-store.mjs";
import { validateTopicCreate, validateTopicUpdate } from "../src/community-contract.mjs";
import { __test as cursors } from "../src/community-routes.mjs";

const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const viewer = id(1);
const author = id(2);
const replier = id(3);
const blocked = id(4);
const reverseBlocked = id(5);
const topic = (value) => id(100 + value);
const comment = (value) => id(200 + value);
const at = (seconds, micros = "000000") => `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.${micros}Z`;
const migrations = new URL("../../../ops/postgres/migrations/", import.meta.url);
const migration = "0027_community_reply_timeline.sql";

async function databaseFor(t, { beforeMigration = false } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.waitReady;
  const files = (await fs.readdir(migrations)).filter((file) =>
    file.endsWith(".sql") && (file < "0025" || (!beforeMigration && file === migration))).sort();
  // This community slice does not depend on parallel agents' reserved 0025/26.
  for (const file of files) await db.exec(await fs.readFile(new URL(file, migrations), "utf8"));
  for (const [index, userId] of [viewer, author, replier, blocked, reverseBlocked].entries()) {
    await db.query(`INSERT INTO app_users
      (id, status, role, display_name, username, normalized_username, registered_via)
      VALUES ($1, 'active', 'user', '时间线测试', $2, $2, 'credential')`, [userId, `timeline-${index}`]);
  }
  // Adapt PGlite's affectedRows to node-postgres's rowCount (notably SELECT).
  const pool = { async query(sql, values) {
    const result = await db.query(sql, values);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  } };
  return { db, store: createCommunityStore(pool) };
}

async function addTopic(db, number, createdAt, { authorId = author, visibility = "public", status = "published" } = {}) {
  await db.query(`INSERT INTO community_topics
    (id, author_user_id, title, body, created_at, visibility, status, deleted_at)
    VALUES ($1, $2, '原有主题标题', '正文', $3, $4, $5, CASE WHEN $5 = 'deleted' THEN now() END)`,
  [topic(number), authorId, createdAt, visibility, status]);
}

async function addReply(db, number, topicNumber, createdAt, { authorId = replier, status = "published", parent = null } = {}) {
  await db.query(`INSERT INTO community_comments
    (id, topic_id, author_user_id, body, created_at, status, deleted_at, parent_comment_id, root_comment_id)
    VALUES ($1, $2, $3, '回复', $4, $5, CASE WHEN $5 = 'deleted' THEN now() END, $6, $6)`,
  [comment(number), topic(topicNumber), authorId, createdAt, status, parent ? comment(parent) : null]);
}

async function allPages(store, sort, limit, viewerUserId = null) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await store.listCommunityTopics({ sort, limit, viewerUserId, cursor });
    items.push(...result.items);
    if (!result.nextCursor) {
      assert.equal(new Set(items.map((item) => item.id)).size, items.length, "no duplicate topic joins or page boundaries");
      return items;
    }
    cursor = cursors.decodeTopicCursor(cursors.encodeCursor(result.nextCursor), sort);
    assert.ok(cursor, "store cursors survive the real route decoder");
  }
  assert.fail("pagination did not terminate");
}

test("0027 preserves old topics/audit guards and enables one-visible-character body-first posts", async (t) => {
  const { db, store } = await databaseFor(t, { beforeMigration: true });
  await addTopic(db, 1, at(1));
  const old = (await db.query("SELECT * FROM community_topics")).rows;
  await assert.rejects(db.query("UPDATE community_topics SET title = '好'"), /community_topics_title_check/u);
  await db.exec(await fs.readFile(new URL(migration, migrations), "utf8"));
  assert.deepEqual((await db.query("SELECT * FROM community_topics")).rows, old);
  for (const title of ["", "字".repeat(121)]) {
    await assert.rejects(db.query("UPDATE community_topics SET title = $1", [title]), /community_topics_title_check/u);
  }
  await assert.rejects(db.query("DELETE FROM community_topics"), /soft-deleted/u);
  const input = validateTopicCreate({ title: "", body: "好" });
  const created = await store.createCommunityTopic({ userId: author, ...input });
  assert.equal(created.title, "好");
  const saved = await store.getCommunityTopic({ topicId: created.id, viewerUserId: viewer });
  assert.equal(saved.title, "好");
  assert.equal(saved.body, "好");
  assert.equal(saved.lastReplyAt, null);
  assert.equal(saved.latestActivityAt, saved.createdAt);
  await store.updateCommunityTopic({ topicId: created.id, userId: author,
    ...validateTopicUpdate({ body: "修改后的正文", version: 1 }) });
  assert.equal((await store.getCommunityTopic({ topicId: created.id })).title, "好", "body edits never rewrite existing titles");
  assert.equal((await db.query("SELECT count(*) AS n FROM community_content_edits")).rows[0].n, 1);
  assert.equal((await db.query("SELECT indexname FROM pg_indexes WHERE indexname = 'community_comments_visible_activity_idx'")).rows.length, 1);
});

test("latest/replied use SQL keysets with same-second, identical timestamp and microsecond ties", async (t) => {
  const { db, store } = await databaseFor(t);
  for (const [number, time] of [[1, at(0)], [2, at(1)], [3, at(3)], [4, at(4)],
    [5, at(4, "000001")], [6, at(4, "000001")], [7, at(4, "000002")]]) {
    await addTopic(db, number, time);
  }
  await addReply(db, 1, 1, at(10, "000001"));
  await addReply(db, 2, 1, at(10, "000002"), { parent: 1 });
  await addReply(db, 3, 2, at(10, "000002"));
  for (const limit of [1, 2, 3, 30]) {
    const latest = await allPages(store, "latest", limit);
    assert.deepEqual(latest.map((item) => item.id), [7, 6, 5, 4, 3, 2, 1].map(topic));
    const replied = await allPages(store, "replied", limit);
    assert.deepEqual(replied.map((item) => item.id), [2, 1, 7, 6, 5, 4, 3].map(topic));
    assert.equal(replied[1].commentCount, 2);
    assert.equal(replied[1].lastReplyAt, at(10).replace("000000", "000"));
    assert.equal(replied[2].lastReplyAt, null);
    assert.equal(replied[2].latestActivityAt, replied[2].createdAt);
  }
  const page = await store.listCommunityTopics({ sort: "latest", limit: 1 });
  assert.equal(page.nextCursor.createdAt, at(4, "000002"));
  const replyPage = await store.listCommunityTopics({ sort: "replied", limit: 1 });
  assert.equal(replyPage.nextCursor.activityAt, at(10, "000002"));
});

test("reply activity excludes hidden/deleted/unlisted topics and bilateral blocks without hiding visible children", async (t) => {
  const { db, store } = await databaseFor(t);
  for (let n = 1; n <= 5; n += 1) await addTopic(db, n, at(n));
  await addTopic(db, 6, at(6), { authorId: blocked });
  await addTopic(db, 7, at(7), { authorId: reverseBlocked });
  await addTopic(db, 8, at(8), { visibility: "unlisted" });
  await addTopic(db, 9, at(9), { status: "hidden" });
  await addTopic(db, 10, at(10), { status: "deleted" });
  await addTopic(db, 11, at(1));
  await addReply(db, 1, 1, at(10));
  await addReply(db, 13, 1, at(58), { status: "hidden" });
  await addReply(db, 14, 1, at(59), { status: "deleted" });
  await addReply(db, 2, 2, at(20), { status: "hidden" });
  await addReply(db, 3, 3, at(30), { status: "deleted" });
  await addReply(db, 4, 4, at(40), { authorId: blocked });
  await addReply(db, 5, 5, at(50), { authorId: reverseBlocked });
  for (const n of [8, 9, 10]) await addReply(db, n, n, at(59));
  await addReply(db, 11, 11, at(12), { status: "hidden" });
  await addReply(db, 12, 11, at(13), { parent: 11 });
  await store.setCommunityBlock({ blockerUserId: viewer, blockedUserId: blocked, active: true });
  await store.setCommunityBlock({ blockerUserId: reverseBlocked, blockedUserId: viewer, active: true });
  const signedIn = await allPages(store, "replied", 2, viewer);
  assert.deepEqual(signedIn.map((item) => item.id), [11, 1, 5, 4, 3, 2].map(topic));
  for (const n of [2, 3, 4, 5]) {
    const item = signedIn.find((row) => row.id === topic(n));
    assert.equal(item.lastReplyAt, null);
    assert.equal(item.latestActivityAt, item.createdAt);
    assert.equal(item.commentCount, 0);
    const detail = await store.getCommunityTopic({ topicId: topic(n), viewerUserId: viewer });
    assert.equal(detail.lastReplyAt, null);
    assert.equal(detail.commentCount, 0);
  }
  assert.equal(signedIn[0].commentCount, 1, "published child survives its hidden root's tombstone");
  const anonymous = await allPages(store, "replied", 2);
  assert.deepEqual(anonymous.map((item) => item.id), [5, 4, 11, 1, 7, 6, 3, 2].map(topic));
  const otherViewer = await allPages(store, "replied", 2, replier);
  assert.deepEqual(otherViewer.map((item) => item.id), anonymous.map((item) => item.id));
  assert.ok((await allPages(store, "hot", 2, viewer)).every((item) => ![6, 7, 8, 9, 10].map(topic).includes(item.id)));
});

test("new replies freeze out of a continued snapshot; editing and liking do not bump topics", async (t) => {
  const { db, store } = await databaseFor(t);
  for (let n = 1; n <= 3; n += 1) await addTopic(db, n, at(n));
  await addReply(db, 1, 1, at(10));
  const first = await store.listCommunityTopics({ sort: "replied", viewerUserId: viewer, limit: 1 });
  const initialOrder = (await allPages(store, "replied", 10, viewer)).map((item) => item.id);
  await store.updateCommunityTopic({ topicId: topic(2), userId: author, expectedVersion: 1, body: "编辑内容" });
  await store.updateCommunityComment({ commentId: comment(1), userId: replier, expectedVersion: 1, body: "编辑回复" });
  await store.setCommunityLike({ targetType: "topic", targetId: topic(2), userId: viewer, active: true });
  await store.setCommunityLike({ targetType: "comment", targetId: comment(1), userId: viewer, active: true });
  assert.deepEqual((await allPages(store, "replied", 10, viewer)).map((item) => item.id), initialOrder);
  await store.createCommunityComment({ topicId: topic(2), userId: replier, body: "新回复", replyToCommentId: null });
  const continued = await store.listCommunityTopics({ sort: "replied", viewerUserId: viewer, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(continued.items.map((item) => item.id), [3, 2].map(topic));
  assert.equal(continued.items[1].lastReplyAt, null);
  assert.equal(continued.items[1].commentCount, 0);
  assert.deepEqual((await allPages(store, "replied", 10, viewer)).map((item) => item.id), [2, 1, 3].map(topic));
  assert.deepEqual((await allPages(store, "latest", 10, viewer)).map((item) => item.id), [3, 2, 1].map(topic));
});

test("moderation, deletion, visibility and block changes invalidate stale replied pages instead of repeating posts", async (t) => {
  const { db, store } = await databaseFor(t);
  for (let n = 1; n <= 3; n += 1) await addTopic(db, n, at(n));
  await addReply(db, 1, 1, at(10));
  const first = () => store.listCommunityTopics({ sort: "replied", viewerUserId: viewer, limit: 1 });
  const rejectsCursor = (cursor, viewerUserId = viewer) => assert.rejects(
    store.listCommunityTopics({ sort: "replied", viewerUserId, cursor, limit: 1 }),
    (error) => error.code === "COMMUNITY_CURSOR_STALE",
  );
  let page = await first();
  await rejectsCursor(page.nextCursor, replier);
  await db.query("UPDATE community_comments SET status = 'hidden' WHERE id = $1", [comment(1)]);
  await rejectsCursor(page.nextCursor);
  assert.deepEqual((await allPages(store, "replied", 10, viewer)).map((item) => item.id), [3, 2, 1].map(topic));
  await db.query("UPDATE community_comments SET status = 'published' WHERE id = $1", [comment(1)]);
  page = await first();
  await store.setCommunityBlock({ blockerUserId: viewer, blockedUserId: replier, active: true });
  await rejectsCursor(page.nextCursor);
  await store.setCommunityBlock({ blockerUserId: viewer, blockedUserId: replier, active: false });
  page = await first();
  await store.deleteCommunityComment({ commentId: comment(1), userId: replier, expectedVersion: 1 });
  await rejectsCursor(page.nextCursor);
  page = await first();
  await store.updateCommunityTopic({ topicId: topic(2), userId: author, expectedVersion: 1, visibility: "unlisted" });
  await rejectsCursor(page.nextCursor);
  page = await first();
  await db.query("UPDATE community_topics SET status = 'hidden'");
  await rejectsCursor(page.nextCursor);
  assert.deepEqual((await first()).items, [], "empty feeds still distinguish stale cursors");
});
