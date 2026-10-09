import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

import { createAuthStore } from "../services/auth-api/src/db.mjs";
import { createAuthServer } from "../services/auth-api/src/server.mjs";
import { createApiRateLimiters } from "../services/auth-api/src/rate-limit.mjs";
import { createOpaqueToken, tokenDigest } from "../services/auth-api/src/tokens.mjs";
import { createDataFeedbackStore } from "../services/auth-api/src/data-feedback-store.mjs";
import { buildDataFeedbackContext } from "../services/auth-api/src/data-feedback-contract.mjs";
import { validateTopicCreate, validateTopicUpdate } from "../services/auth-api/src/community-contract.mjs";
import { __test as cursors } from "../services/auth-api/src/community-routes.mjs";

// Run AFTER the existing CI migration step. Never use a live database:
// POSTGRES_INTEGRATION=true node --test tests/postgres-product-extensions.test.mjs
// The configured database is only a control connection. All fixture data, DDL,
// runtime requests and failure injection use a freshly created disposable DB.
// Generated roles keep the grant runner from changing any existing CI roles.
const enabled = process.env.POSTGRES_INTEGRATION === "true";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const migrations = new URL("../ops/postgres/migrations/", import.meta.url);
const origin = "https://product-extensions.test";
const config = {
  tokenPepper: "synthetic-native-product-extensions-token-pepper",
  allowedOrigins: new Set([origin]), sessionCookie: "__Host-product-session",
  adminCookie: "__Host-product-admin", deviceCookie: "__Host-product-device",
  oauthCookie: "__Host-product-oauth", adminEnabled: true,
  passwordResetMode: "disabled", emailVerificationMode: "disabled",
  wechatMode: "disabled", credentialsEnabled: false,
};
const quote = value => `"${value.replaceAll('"', '""')}"`;
const digest = value => createHash("sha256").update(value).digest("hex");

function poolFor(database, user, password) {
  return new pg.Pool({
    host: process.env.PGHOST ?? "127.0.0.1", port: Number(process.env.PGPORT ?? 5432),
    database, user, password, max: 8, connectionTimeoutMillis: 3_000, query_timeout: 10_000,
  });
}

async function fixture(t) {
  // Fail, rather than silently skip or fall back to PGlite, when native CI is
  // requested but its connection/runtime prerequisites are unavailable.
  assert.match(process.env.POSTGRES_DB ?? "", /(?:^|_)ci(?:_|$)/u, "requires a disposable CI database name");
  assert.ok(["127.0.0.1", "localhost", "::1", "postgres"].includes(process.env.PGHOST ?? "127.0.0.1"), "native tests must stay local");
  for (const name of ["POSTGRES_USER", "POSTGRES_PASSWORD", "MIGRATION_DB_ROLE", "MIGRATION_DB_USER", "MIGRATION_DB_PASSWORD", "AUTH_DB_USER", "AUTH_DB_PASSWORD", "IMPORT_DB_USER", "IMPORT_DB_PASSWORD", "BACKUP_DB_USER", "BACKUP_DB_PASSWORD"]) {
    assert.ok(process.env[name], `${name} is required`);
  }
  const suffix = randomUUID().replaceAll("-", "");
  const database = `product_extensions_${suffix}`;
  const roles = Object.fromEntries(["schema", "migrator", "runtime", "import", "backup"].map(kind => [kind, `pgext_${kind}_${suffix}`]));
  const control = poolFor(process.env.POSTGRES_DB, process.env.POSTGRES_USER, process.env.POSTGRES_PASSWORD);
  const pools = [];
  let created = false;
  let server;
  t.after(async () => {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      try {
        await Promise.all(pools.map(pool => pool.end()));
        if (created) {
          assert.match(database, /^product_extensions_[0-9a-f]{32}$/u);
          assert.notEqual(database, process.env.POSTGRES_DB);
          // Drop only this test's generated database, never the shared CI DB.
          await control.query(`DROP DATABASE ${quote(database)}`);
          for (const role of Object.values(roles)) {
            assert.match(role, /^pgext_(schema|migrator|runtime|import|backup)_[0-9a-f]{32}$/u);
            await control.query(`DROP ROLE IF EXISTS ${quote(role)}`);
          }
        }
      } finally { await control.end(); }
    }
  });
  const version = await control.query("SHOW server_version_num");
  assert.ok(Number(version.rows[0].server_version_num) >= 170000, "requires native PostgreSQL 17+");
  await control.query(`CREATE DATABASE ${quote(database)} TEMPLATE template0`);
  created = true;
  await control.query(`CREATE ROLE ${quote(roles.schema)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const connect = (user, password) => {
    const pool = poolFor(database, user, password);
    pools.push(pool);
    return pool;
  };
  const owner = connect(process.env.POSTGRES_USER, process.env.POSTGRES_PASSWORD);
  const runtime = connect(roles.runtime, process.env.AUTH_DB_PASSWORD);
  const importer = connect(roles.import, process.env.IMPORT_DB_PASSWORD);
  const backup = connect(roles.backup, process.env.BACKUP_DB_PASSWORD);
  const names = (await readdir(migrations)).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
  assert.equal(new Set(names.map(name => name.slice(0, 4))).size, names.length);
  for (const name of ["0025_material_bookmarks.sql", "0026_data_feedback.sql", "0027_community_reply_timeline.sql"]) assert.ok(names.includes(name));

  // Build the exact pre-release schema, and seed old rows BEFORE 0025-27. The
  // actual checked-in shell runner performs the upgrade and final role grants.
  const client = await owner.connect();
  try {
    await client.query(`ALTER SCHEMA public OWNER TO ${quote(roles.schema)}`);
    await client.query(`SET ROLE ${quote(roles.schema)}`);
    await client.query("CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of names.filter(name => name < "0025")) {
      const sql = await readFile(new URL(name, migrations), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)", [name, digest(sql)]);
    }
  } finally {
    try { await client.query("ROLLBACK"); await client.query("RESET ROLE"); }
    finally { client.release(); }
  }

  const users = {};
  for (const name of ["legacy", "owner", "other", "admin", "viewer", "author", "replier", "blocked", "reverseBlocked"]) {
    const userId = randomUUID(), sessionId = randomUUID(), token = createOpaqueToken();
    const username = `pgext-${userId.replaceAll("-", "").slice(0, 16)}`;
    await owner.query("INSERT INTO app_users(id,role,display_name,username,normalized_username,registered_via) VALUES ($1,$2,'合成测试用户',$3,$3,'credential')", [userId, name === "admin" ? "admin" : "user", username]);
    await owner.query("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [sessionId, userId, tokenDigest(token, config.tokenPepper)]);
    users[name] = { userId, sessionId, token, cookie: `${config.sessionCookie}=${token}` };
  }
  const legacyTopic = randomUUID();
  await owner.query("INSERT INTO community_topics(id,author_user_id,title,body,visibility) VALUES ($1,$2,'旧版兼容标题','升级前合成正文','unlisted')", [legacyTopic, users.legacy.userId]);
  const legacyRows = async () => {
    const result = {};
    for (const table of ["app_users", "user_sessions", "community_topics"]) {
      result[table] = (await owner.query(`SELECT to_jsonb(row) AS data FROM ${table} AS row ORDER BY id`)).rows;
    }
    return result;
  };
  const before = await legacyRows();
  const legacyColumns = async () => (await owner.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('app_users','user_sessions','community_topics','community_comments')
    ORDER BY table_name,ordinal_position`)).rows;
  const columnsBefore = await legacyColumns();
  async function migrate() {
    // Do not print child-process output: the role setup contains CI passwords.
    try {
      await exec("sh", ["ops/postgres/run-migrations.sh"], {
        cwd: root, env: {
          ...process.env, POSTGRES_DB: database, MIGRATIONS_DIR: fileURLToPath(migrations),
          MIGRATION_DB_ROLE: roles.schema, MIGRATION_DB_USER: roles.migrator,
          AUTH_DB_USER: roles.runtime, IMPORT_DB_USER: roles.import, BACKUP_DB_USER: roles.backup,
        },
        timeout: 90_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      });
    } catch (error) {
      throw new Error(`isolated migration runner failed (exit ${error.code ?? "unknown"}, signal ${error.signal ?? "none"}); inspect runner in the separate CI migration step`);
    }
  }
  await migrate();
  const ledger = (await owner.query("SELECT * FROM schema_migrations ORDER BY version")).rows;
  await migrate();
  assert.deepEqual((await owner.query("SELECT * FROM schema_migrations ORDER BY version")).rows, ledger, "second runner execution must be a no-op for migration ledger");
  assert.deepEqual(ledger.map(row => row.version), names);
  for (const row of ledger) assert.equal(row.checksum, digest(await readFile(new URL(row.version, migrations), "utf8")), row.version);
  assert.deepEqual(await legacyRows(), before, "upgrade must preserve all pre-existing fixture rows");
  assert.deepEqual(await legacyColumns(), columnsBefore, "old app/auth column contracts must remain unchanged");

  const elevation = createOpaqueToken();
  const elevationTokenHash = tokenDigest(elevation, config.tokenPepper);
  await owner.query("INSERT INTO admin_elevated_sessions(user_id,base_session_id,token_hash,method,expires_at) VALUES ($1,$2,$3,'totp',now()+interval '10 minutes')", [users.admin.userId, users.admin.sessionId, elevationTokenHash]);
  users.admin.elevatedCookie = `${users.admin.cookie}; ${config.adminCookie}=${elevation}`;
  const adminInput = () => ({ ...users.admin, elevationTokenHash, requestId: randomUUID(), ipHash: "a".repeat(64), userAgentHash: "b".repeat(64) });
  // No test-only spreads: this exercises the production store/server registration.
  const store = createAuthStore(runtime);
  server = createAuthServer({ store, config, adminSecurity: {}, rateLimiters: createApiRateLimiters({ store }) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  async function call(path, { user = "owner", elevated = false, method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, signal: AbortSignal.timeout(10_000), headers: {
        Origin: origin, "Content-Type": "application/json",
        ...(user ? { Cookie: elevated ? users[user].elevatedCookie : users[user].cookie, "X-Material-Bookmark-Owner": users[user].userId } : {}),
        ...headers,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { owner, runtime, importer, backup, roles, store, users, call, adminInput, legacyTopic };
}

test("native PostgreSQL product extensions: upgrade, runtime HTTP/ACL, timeline and rollback schema contracts", {
  skip: !enabled, timeout: 240_000,
}, async t => {
  const f = await fixture(t);
  const materialId = randomUUID().replaceAll("-", "").slice(0, 20);
  const bookmarks = "/api/material-bookmarks", own = "/api/auth/data-feedback", admin = "/api/admin/data-feedback";
  const draft = () => ({ ...buildDataFeedbackContext({ type: "material", materialId }), message: "合成资料无法打开，请核对。", requestKey: randomUUID() });
  const count = async (table, column, id) => (await f.owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [id])).rows[0].n;
  let feedbackId;

  await t.test("runner grants: non-owner runtime, import/public isolation, read-only backup and append-only logs", async () => {
    for (const pool of [f.runtime, f.importer, f.backup]) {
      assert.deepEqual((await pool.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0], { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    }
    const privilege = async (pool, table, operation) => (await pool.query("SELECT has_table_privilege(current_user,$1,$2) AS allowed", [table, operation])).rows[0].allowed;
    for (const table of ["material_bookmarks", "material_bookmark_events", "data_feedback", "data_feedback_actions"]) {
      const isLog = ["material_bookmark_events", "data_feedback_actions"].includes(table);
      assert.notEqual((await f.owner.query("SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename=$1", [table])).rows[0].tableowner, f.roles.runtime);
      for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        assert.equal(await privilege(f.runtime, table, operation), ["SELECT", "INSERT"].includes(operation) || (!isLog && ["UPDATE", "DELETE"].includes(operation)), `runtime ${table} ${operation}`);
        assert.equal(await privilege(f.importer, table, operation), false, `import ${table} ${operation}`);
        assert.equal(await privilege(f.backup, table, operation), operation === "SELECT", `backup ${table} ${operation}`);
      }
      assert.equal((await f.owner.query(`SELECT count(*)::int AS n FROM pg_class AS c,
        LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) AS acl
        WHERE c.oid=$1::regclass AND acl.grantee=0`, [table])).rows[0].n, 0, `${table} must not grant PUBLIC`);
      await assert.rejects(f.importer.query(`SELECT * FROM ${table} LIMIT 0`), { code: "42501" });
      await f.backup.query(`SELECT * FROM ${table} LIMIT 0`);
      if (isLog) {
        // Roll back even if an ACL regresses; no destructive probe can persist.
        const client = await f.runtime.connect();
        try {
          for (const sql of [`UPDATE ${table} SET created_at=created_at WHERE false`, `DELETE FROM ${table} WHERE false`, `TRUNCATE ${table}`]) {
            await client.query("BEGIN");
            try { await assert.rejects(client.query(sql), { code: "42501" }); }
            finally { await client.query("ROLLBACK"); }
          }
        } finally { client.release(); }
      }
    }
    for (const sequence of ["material_bookmark_events_id_seq", "data_feedback_actions_id_seq"]) {
      assert.equal((await f.runtime.query("SELECT has_sequence_privilege(current_user,$1,'USAGE') AS allowed", [sequence])).rows[0].allowed, true);
    }
    for (const table of ["schema_migrations", "api_rate_limit_buckets"]) await assert.rejects(f.runtime.query(`SELECT * FROM ${table} LIMIT 0`), { code: "42501" });
  });

  await t.test("createAuthServer protects anonymous and foreign-origin extension traffic", async () => {
    for (const [path, method, body] of [[bookmarks, "GET"], [`${bookmarks}/${materialId}`, "PUT", {}], [own, "GET"], [own, "POST", draft()], [admin, "GET"]]) {
      const response = await f.call(path, { user: null, method, body });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.body.error, "authentication_required");
      assert.match(response.headers.get("cache-control"), /no-store/u);
    }
    for (const [path, method, body] of [[`${bookmarks}/${materialId}`, "PUT", {}], [own, "POST", draft()]]) {
      for (const Origin of ["https://foreign.test", ""]) assert.equal((await f.call(path, { method, body, headers: { Origin } })).status, 403);
    }
  });

  await t.test("bookmarks isolate accounts and serialize duplicate add/remove with exactly-once audit", async () => {
    const path = `${bookmarks}/${materialId}`;
    for (const response of await Promise.all([f.call(path, { method: "PUT", body: {} }), f.call(path, { method: "PUT", body: {} })])) {
      assert.equal(response.status, 200); assert.equal(response.body.bookmarked, true);
    }
    assert.deepEqual((await f.call(bookmarks, { user: "other" })).body.items, []);
    assert.equal((await f.call(bookmarks)).body.items[0].materialId, materialId);
    assert.equal((await f.call(path, { user: "other", method: "PUT", body: {} })).status, 200);
    assert.equal((await f.call(path, { user: "other", method: "DELETE", body: {}, headers: { "X-Material-Bookmark-Owner": f.users.owner.userId } })).status, 409);
    assert.equal((await f.call(`${bookmarks}?userId=${f.users.other.userId}`)).status, 400);
    for (const response of await Promise.all([f.call(path, { method: "DELETE", body: {} }), f.call(path, { method: "DELETE", body: {} })])) assert.equal(response.status, 200);
    assert.deepEqual((await f.call(bookmarks)).body.items, []);
    assert.equal((await f.call(bookmarks, { user: "other" })).body.items[0].materialId, materialId);
    const events = (await f.owner.query("SELECT actor_user_id,action FROM material_bookmark_events WHERE material_id=$1 ORDER BY id", [materialId])).rows;
    assert.deepEqual(events.filter(row => row.actor_user_id === f.users.owner.userId).map(row => row.action), ["added", "removed"]);
    assert.deepEqual(events.filter(row => row.actor_user_id === f.users.other.userId).map(row => row.action), ["added"]);
    await assert.rejects(f.store.listMaterialBookmarks({ userId: f.users.owner.userId, sessionId: f.users.other.sessionId }), { code: "MATERIAL_BOOKMARK_SESSION_INVALID" });
  });

  await t.test("feedback real receipts/retries are owner-only; admin dispatch precedes generic admin and requires MFA", async () => {
    const data = draft();
    const created = await f.call(own, { method: "POST", body: data });
    assert.equal(created.status, 201); assert.equal(created.body.created, true);
    feedbackId = created.body.feedback.id;
    assert.equal(created.body.feedback.status, "open");
    const retry = await f.call(own, { method: "POST", body: data });
    assert.equal(retry.status, 200); assert.equal(retry.body.created, false); assert.equal(retry.body.feedback.id, feedbackId);
    assert.equal((await f.call(`${own}/${feedbackId}`, { user: "other" })).status, 404);
    assert.deepEqual((await f.call(own, { user: "other" })).body.items, []);
    assert.equal((await f.call(`${own}?userId=${f.users.other.userId}`)).status, 400);
    for (const [user, error] of [["owner", "admin_forbidden"], ["admin", "admin_mfa_required"]]) {
      const denied = await f.call(admin, { user });
      assert.equal(denied.status, 403); assert.equal(denied.body.error, error);
    }
    const queue = await f.call(admin, { user: "admin", elevated: true });
    assert.equal(queue.status, 200, "generic /api/admin/* must not swallow feedback");
    assert.equal(queue.body.items[0].id, feedbackId); assert.ok(queue.body.elevatedUntil);
    assert.equal((await f.call("/api/admin/session", { user: "admin", elevated: true })).status, 200);
    await assert.rejects(f.store.getAdminDataFeedback({ ...f.adminInput(), sessionId: f.users.other.sessionId, feedbackId }), { code: "AUTH_ADMIN_FORBIDDEN" });
    await assert.rejects(f.store.getAdminDataFeedback({ ...f.adminInput(), elevationTokenHash: "invalid", feedbackId }), { code: "AUTH_ADMIN_FORBIDDEN" });
  });

  await t.test("feedback status, processing log and audit commit atomically; concurrent stale versions cannot double-process", async () => {
    assert.ok(feedbackId);
    const change = { status: "resolved", version: 1, note: "合成核对记录：链接已修复。" };
    // Fail the audit SQL on a REAL pg transaction after status/log writes.
    // Keep query/release bound: pg clients have prototype methods.
    const failing = createDataFeedbackStore({ connect: async () => {
      const client = await f.runtime.connect();
      return {
        query: (sql, values) => /INSERT INTO admin_audit_events/u.test(sql)
          ? client.query("SELECT 1/0") : client.query(sql, values),
        release: () => client.release(),
      };
    } });
    await assert.rejects(failing.resolveDataFeedback({ ...f.adminInput(), feedbackId, change }), { code: "22012" });
    assert.deepEqual((await f.owner.query("SELECT status,version FROM data_feedback WHERE id=$1", [feedbackId])).rows[0], { status: "open", version: 1 });
    assert.equal(await count("data_feedback_actions", "feedback_id", feedbackId), 0);
    assert.equal((await f.owner.query("SELECT count(*)::int AS n FROM admin_audit_events WHERE target_id=$1 AND action='admin.data_feedback.status_changed'", [feedbackId])).rows[0].n, 0);
    const responses = await Promise.all([1, 2].map(() => f.call(`${admin}/${feedbackId}`, { user: "admin", elevated: true, method: "PATCH", body: change })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(responses.find(response => response.status === 409).body.error, "data_feedback_version_conflict");
    const detail = await f.call(`${admin}/${feedbackId}`, { user: "admin", elevated: true });
    assert.equal(detail.status, 200); assert.equal(detail.body.feedback.status, "resolved");
    assert.equal(detail.body.feedback.version, 2); assert.equal(detail.body.feedback.actions.length, 1);
    assert.equal(detail.body.feedback.actions[0].note, change.note);
    const audits = (await f.owner.query("SELECT metadata FROM admin_audit_events WHERE target_id=$1 AND action='admin.data_feedback.status_changed'", [feedbackId])).rows;
    assert.deepEqual(audits, [{ metadata: { fromStatus: "open", toStatus: "resolved", version: 2 } }]);
    const receipt = (await f.call(`${own}/${feedbackId}`)).body.feedback;
    assert.equal(receipt.status, "resolved"); assert.equal(Object.hasOwn(receipt, "actions"), false);
    assert.equal((await f.call(`${admin}/${feedbackId}`, { user: "admin", elevated: true, method: "PATCH", body: { status: "open", version: 2, note: "合成复核：重新打开。" } })).status, 200);
    assert.equal(await count("data_feedback_actions", "feedback_id", feedbackId), 2);
    await f.owner.query("UPDATE admin_elevated_sessions SET expires_at=now()-interval '1 second' WHERE base_session_id=$1", [f.users.admin.sessionId]);
    await assert.rejects(f.store.resolveDataFeedback({ ...f.adminInput(), feedbackId, change: { status: "resolved", version: 3, note: "过期不可提交" } }), { code: "AUTH_ADMIN_FORBIDDEN" });
    assert.equal((await f.call(admin, { user: "admin", elevated: true })).status, 403);
    assert.deepEqual((await f.owner.query("SELECT status,version FROM data_feedback WHERE id=$1", [feedbackId])).rows[0], { status: "open", version: 3 });
    assert.equal(await count("data_feedback_actions", "feedback_id", feedbackId), 2);
  });

  await t.test("revocation denies both APIs; runtime account deletion cascades receipts/actions but retains audit snapshots", async () => {
    await f.store.setMaterialBookmark({ ...f.users.owner, materialId, active: true });
    await f.owner.query("UPDATE user_sessions SET revoked_at=now() WHERE id=$1", [f.users.owner.sessionId]);
    for (const path of [bookmarks, own]) assert.equal((await f.call(path)).status, 401);
    await f.runtime.query("DELETE FROM app_users WHERE id=$1", [f.users.owner.userId]);
    for (const table of ["material_bookmarks", "data_feedback"]) assert.equal(await count(table, "user_id", f.users.owner.userId), 0);
    assert.equal(await count("data_feedback_actions", "feedback_id", feedbackId), 0);
    assert.ok(await count("material_bookmark_events", "actor_user_id", f.users.owner.userId) > 0);
    assert.ok(await count("admin_audit_events", "target_id", feedbackId) > 0);
    assert.equal((await f.call(bookmarks, { user: "other" })).body.items[0].materialId, materialId);
  });

  await t.test("native replied keysets exclude hidden/deleted/bilateral blocks, preserve microseconds and invalidate changed visibility", async () => {
    const prefix = randomUUID().slice(0, 24);
    const id = n => `${prefix}${String(n).padStart(12, "0")}`;
    const at = (seconds, micros = "000000") => `2020-01-01T00:00:${String(seconds).padStart(2, "0")}.${micros}Z`;
    async function topic(n, options = {}) {
      await f.owner.query(`INSERT INTO community_topics(id,author_user_id,title,body,created_at,visibility,status,deleted_at)
        VALUES ($1,$2,'原有主题标题','合成正文',$3,$4,$5,CASE WHEN $5='deleted' THEN now() END)`,
      [id(n), f.users[options.author ?? "author"].userId, options.at ?? at(n), options.visibility ?? "public", options.status ?? "published"]);
    }
    async function reply(n, topicNumber, time, options = {}) {
      await f.owner.query(`INSERT INTO community_comments(id,topic_id,author_user_id,body,created_at,status,deleted_at)
        VALUES ($1,$2,$3,'合成回复',$4,$5,CASE WHEN $5='deleted' THEN now() END)`,
      [id(100 + n), id(topicNumber), f.users[options.author ?? "replier"].userId, time, options.status ?? "published"]);
    }
    for (let n = 1; n <= 5; n++) await topic(n);
    await topic(6, { author: "blocked" }); await topic(7, { author: "reverseBlocked" });
    await topic(8, { visibility: "unlisted" }); await topic(9, { status: "hidden" }); await topic(10, { status: "deleted" });
    await reply(1, 1, at(10, "000001")); await reply(2, 1, at(59), { status: "hidden" });
    await reply(3, 1, at(58), { status: "deleted" }); await reply(4, 2, at(30), { status: "hidden" });
    await reply(5, 3, at(40), { status: "deleted" }); await reply(6, 4, at(50), { author: "blocked" });
    await reply(7, 5, at(55), { author: "reverseBlocked" });
    for (const n of [8, 9, 10]) await reply(n, n, at(59));
    await topic(11, { at: at(1) }); await reply(11, 11, at(10, "000002"));
    const viewerUserId = f.users.viewer.userId;
    await f.store.setCommunityBlock({ blockerUserId: viewerUserId, blockedUserId: f.users.blocked.userId, active: true });
    await f.store.setCommunityBlock({ blockerUserId: f.users.reverseBlocked.userId, blockedUserId: viewerUserId, active: true });
    async function pages(viewer = viewerUserId, sort = "replied") {
      const items = [];
      let cursor = null;
      for (let page = 0; page < 20; page++) {
        const result = await f.store.listCommunityTopics({ viewerUserId: viewer, sort, cursor, limit: 2 });
        items.push(...result.items);
        if (!result.nextCursor) {
          assert.equal(new Set(items.map(row => row.id)).size, items.length);
          return items;
        }
        cursor = cursors.decodeTopicCursor(cursors.encodeCursor(result.nextCursor), sort);
        assert.ok(cursor);
      }
      assert.fail("native keyset pagination did not terminate");
    }
    const visible = await pages();
    assert.deepEqual(visible.map(row => row.id), [11, 1, 5, 4, 3, 2].map(id));
    for (const n of [2, 3, 4, 5]) {
      const row = visible.find(item => item.id === id(n));
      assert.equal(row.commentCount, 0); assert.equal(row.lastReplyAt, null); assert.equal(row.latestActivityAt, row.createdAt);
    }
    assert.equal(visible.find(row => row.id === id(1)).commentCount, 1);
    assert.deepEqual((await pages(null)).map(row => row.id), [5, 4, 11, 1, 7, 6, 3, 2].map(id));
    assert.deepEqual((await pages(viewerUserId, "latest")).map(row => row.id), [5, 4, 3, 2, 11, 1].map(id));
    const first = await f.store.listCommunityTopics({ sort: "replied", viewerUserId, limit: 1 });
    assert.equal(first.nextCursor.activityAt, at(10, "000002"));
    await f.store.updateCommunityTopic({ topicId: id(2), userId: f.users.author.userId, expectedVersion: 1, body: "编辑不顶帖" });
    await f.store.setCommunityLike({ targetType: "topic", targetId: id(2), userId: viewerUserId, active: true });
    assert.deepEqual((await pages()).map(row => row.id), visible.map(row => row.id));
    await f.store.createCommunityComment({ topicId: id(2), userId: f.users.replier.userId, body: "快照之后的新回复", replyToCommentId: null });
    const continued = await f.store.listCommunityTopics({ sort: "replied", viewerUserId, limit: 20, cursor: first.nextCursor });
    assert.deepEqual(continued.items.map(row => row.id), [1, 5, 4, 3, 2].map(id));
    assert.equal(continued.items.at(-1).commentCount, 0);
    assert.equal((await pages())[0].id, id(2));
    await f.owner.query("UPDATE community_comments SET status='hidden' WHERE id=$1", [id(101)]);
    await assert.rejects(f.store.listCommunityTopics({ sort: "replied", viewerUserId, limit: 20, cursor: first.nextCursor }), { code: "COMMUNITY_CURSOR_STALE" });
  });

  await t.test("post-0027 schema supports V23 auth/V24 app SQL shapes; retained short-title data is not a reversible down-migration", async () => {
    // These are the legacy column/payload contracts, NOT execution of old app
    // binaries. A real rollback smoke must retain schema 27 and current grants.
    const session = await f.runtime.query(`SELECT sessions.id,users.id AS user_id,users.role
      FROM user_sessions AS sessions JOIN app_users AS users ON users.id=sessions.user_id
      WHERE sessions.token_hash=$1 AND sessions.revoked_at IS NULL AND sessions.expires_at>now() AND users.status='active'`,
    [tokenDigest(f.users.legacy.token, config.tokenPepper)]);
    assert.equal(session.rows[0].user_id, f.users.legacy.userId);
    assert.equal((await f.store.getActiveSession(tokenDigest(f.users.legacy.token, config.tokenPepper))).userId, f.users.legacy.userId);
    const updated = await f.runtime.query(`UPDATE community_topics SET title=COALESCE($3,title),body=COALESCE($4,body),
      visibility=COALESCE($5,visibility),version=version+1,updated_at=now(),edited_at=now()
      WHERE id=$1::uuid AND author_user_id=$2::uuid RETURNING id,title,body,status,visibility,version,created_at,updated_at`,
    [f.legacyTopic, f.users.legacy.userId, "旧版编辑标题", "旧版正文更新", "unlisted"]);
    assert.equal(updated.rows[0].version, 2); assert.equal(updated.rows[0].title, "旧版编辑标题");
    const input = validateTopicCreate({ body: "问", visibility: "unlisted" });
    assert.equal(input.title, "问");
    const created = await f.store.createCommunityTopic({ userId: f.users.legacy.userId, ...input });
    assert.equal((await f.runtime.query("SELECT title,body FROM community_topics WHERE id=$1", [created.id])).rows[0].title, "问", "legacy SELECT still reads new short-title rows");
    await f.store.updateCommunityTopic({ topicId: created.id, userId: f.users.legacy.userId, ...validateTopicUpdate({ body: "只改正文", version: 1 }) });
    assert.equal((await f.store.getCommunityTopic({ topicId: created.id, viewerUserId: f.users.legacy.userId })).title, "问");
    // V24's form sends title on every edit and requires >=4 characters; V23's
    // validator has the same bound. Preserve this known rollback limitation.
    assert.equal(validateTopicUpdate({ title: "问", body: "旧表单正文", version: 2 }), null);
    assert.ok(validateTopicUpdate({ title: "补齐旧版标题", body: "旧表单正文", version: 2 }));
    const client = await f.owner.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query("ALTER TABLE community_topics ADD CONSTRAINT legacy_title_probe CHECK(char_length(title) BETWEEN 4 AND 120)"), { code: "23514" });
    } finally { await client.query("ROLLBACK"); client.release(); }
    await assert.rejects(f.runtime.query("DELETE FROM community_topics WHERE id=$1", [f.legacyTopic]), { code: "42501" });
    await assert.rejects(f.owner.query("DELETE FROM community_topics WHERE id=$1", [f.legacyTopic]), /soft-deleted/u);
    assert.equal((await f.owner.query("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname='community_comments_visible_activity_idx'")).rows[0].n, 1);
    for (const table of ["material_bookmark_events", "data_feedback_actions"]) {
      assert.equal((await f.runtime.query("SELECT has_table_privilege(current_user,$1,'UPDATE') OR has_table_privilege(current_user,$1,'DELETE') AS mutable", [table])).rows[0].mutable, false, "image rollback must not rerun the old broad GRANT script");
    }
  });
});
