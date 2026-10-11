import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { createCommunityStore } from "../services/auth-api/src/community-store.mjs";

const viewerId = "00000000-0000-4000-8000-000000000801";
const authorId = "00000000-0000-4000-8000-000000000802";
const topicId = "00000000-0000-4000-8000-000000000803";

test("saved community relationships execute against the migrated database", async () => {
  const database = new PGlite();
  await database.waitReady;
  try {
    const directory = path.resolve("ops/postgres/migrations");
    const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    for (const file of files) await database.exec(await fs.readFile(path.join(directory, file), "utf8"));
    await database.query(
      `INSERT INTO app_users (id, status, display_name, role, username, normalized_username, registered_via)
       VALUES ($1, 'active', '收藏者', 'user', 'saved-viewer', 'saved-viewer', 'credential'),
              ($2, 'active', '主题作者', 'user', 'saved-author', 'saved-author', 'credential')`,
      [viewerId, authorId],
    );
    await database.query(
      `INSERT INTO community_topics (id, author_user_id, title, body)
       VALUES ($1, $2, '值得收藏的选课讨论', '这段正文用于验证收藏列表真实查询。')`,
      [topicId, authorId],
    );
    const store = createCommunityStore(database);
    await store.setCommunityBookmark({ topicId, userId: viewerId, active: true });
    const bookmarks = await store.listCommunityBookmarks({ userId: viewerId, limit: 20 });
    assert.equal(bookmarks.items[0].topicId, topicId);
    assert.equal(bookmarks.items[0].status, "available");

    await store.setCommunityBlock({ blockerUserId: viewerId, blockedUserId: authorId, active: true });
    assert.deepEqual((await store.listCommunityBookmarks({ userId: viewerId })).items, []);
    assert.equal((await store.listCommunityBlocks({ userId: viewerId })).items[0].user.id, authorId);

    await store.setCommunityBlock({ blockerUserId: viewerId, blockedUserId: authorId, active: false });
    assert.deepEqual((await store.listCommunityBlocks({ userId: viewerId })).items, []);
  } finally {
    await database.close();
  }
});
