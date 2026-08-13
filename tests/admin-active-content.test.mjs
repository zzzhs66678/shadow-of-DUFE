import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { createCommunityStore } from "../services/auth-api/src/community-store.mjs";

const adminId = "00000000-0000-4000-8000-000000000701";
const authorId = "00000000-0000-4000-8000-000000000702";
const sessionId = "00000000-0000-4000-8000-000000000703";
const topicId = "00000000-0000-4000-8000-000000000704";
const commentId = "00000000-0000-4000-8000-000000000705";

async function createDatabase() {
  const database = new PGlite();
  await database.waitReady;
  const directory = path.resolve("ops/postgres/migrations");
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) await database.exec(await fs.readFile(path.join(directory, file), "utf8"));
  await database.query(
    `INSERT INTO app_users (id, status, display_name, role, username, normalized_username, registered_via)
     VALUES ($1, 'active', '值守员', 'admin', 'content-admin', 'content-admin', 'credential'),
            ($2, 'active', '内容作者', 'user', 'content-author', 'content-author', 'credential')`,
    [adminId, authorId],
  );
  await database.query(
    `INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, 'active-content-session', now() + interval '1 day')`,
    [sessionId, adminId],
  );
  await database.query(
    `INSERT INTO admin_elevated_sessions (user_id, base_session_id, token_hash, method, expires_at)
     VALUES ($1, $2, 'active-content-elevation', 'totp', now() + interval '10 minutes')`,
    [adminId, sessionId],
  );
  await database.query(
    `INSERT INTO community_topics (id, author_user_id, title, body)
     VALUES ($1, $2, '校园夜间自习地点', '主动巡查可以按主题标题与正文找到这一项。')`,
    [topicId, authorId],
  );
  await database.query(
    `INSERT INTO community_comments (id, topic_id, author_user_id, body)
     VALUES ($1, $2, $3, '回复正文也必须能够独立进入主动巡查目录。')`,
    [commentId, topicId, authorId],
  );
  return database;
}

test("active content review executes topic and comment queries and creates an audited case", async () => {
  const database = await createDatabase();
  try {
    const store = createCommunityStore(database);
    const topics = await store.listAdminCommunityContent({
      type: "topic",
      status: "published",
      query: "夜间自习",
      cursor: null,
      limit: 20,
    });
    assert.deepEqual(topics.items.map((item) => item.id), [topicId]);
    const comments = await store.listAdminCommunityContent({
      type: "comment",
      status: "published",
      query: "主动巡查",
      cursor: null,
      limit: 20,
    });
    assert.deepEqual(comments.items.map((item) => item.id), [commentId]);

    const opened = await store.openDirectCommunityModerationCase({
      actorUserId: adminId,
      actorSessionId: sessionId,
      actorElevationTokenHash: "active-content-elevation",
      targetType: "comment",
      targetId: commentId,
      reason: "主动巡查发现该回复需要进入统一治理流程",
      requestId: "00000000-0000-4000-8000-000000000706",
      ipHash: "active-content-ip-hash",
      userAgentHash: "active-content-user-agent-hash",
    });
    assert.equal(opened.created, true);
    assert.equal(opened.status, "reviewing");
    const evidence = await database.query(
      `SELECT
         (SELECT count(*)::int FROM community_moderation_actions WHERE case_id = $1) AS actions,
         (SELECT count(*)::int FROM admin_audit_events
          WHERE action = 'admin.community.case_opened' AND target_id = $2) AS audits`,
      [opened.id, commentId],
    );
    assert.deepEqual(evidence.rows[0], { actions: 1, audits: 1 });
  } finally {
    await database.close();
  }
});
