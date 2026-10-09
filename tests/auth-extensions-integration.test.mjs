import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createAuthStore } from "../services/auth-api/src/db.mjs";
import { createAuthServer } from "../services/auth-api/src/server.mjs";
import { createOpaqueToken, tokenDigest } from "../services/auth-api/src/tokens.mjs";
import { createApiRateLimiters } from "../services/auth-api/src/rate-limit.mjs";
import { buildDataFeedbackContext } from "../services/auth-api/src/data-feedback-contract.mjs";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const origin = "https://auth-extensions.test";
const materialId = "296a21c75a1a00ba39a4";
const config = {
  tokenPepper: "synthetic-auth-extensions-pepper-not-a-production-secret",
  allowedOrigins: new Set([origin]), sessionCookie: "__Host-test-session", adminCookie: "__Host-test-admin",
  deviceCookie: "__Host-test-device", oauthCookie: "__Host-test-oauth", adminEnabled: true,
  passwordResetMode: "disabled", emailVerificationMode: "disabled", wechatMode: "disabled", credentialsEnabled: false,
};
const roles = {
  schema_owner: "extension_schema", migration_user: "extension_migrator", migration_password: "synthetic-migrator",
  runtime_user: "extension_runtime", runtime_password: "synthetic-runtime",
  import_user: "extension_import", import_password: "synthetic-import",
  backup_user: "extension_backup", backup_password: "synthetic-backup",
};
const draft = () => ({ ...buildDataFeedbackContext({ type: "material", materialId }), message: "资料打不开，请核对公开文件。", requestKey: randomUUID() });

// Run the checked-in runner's actual role/ACL SQL, including SELECT format ...
// \gexec expansion, in isolated PostgreSQL. This does not invoke shell/psql, use
// environment credentials, or copy the GRANT policy into a potentially stale fixture.
async function psqlRoleBlock(db, block) {
  const rendered = block.replace(/:'([a-z_]+)'/gu, (_, key) => {
    assert.ok(Object.hasOwn(roles, key), `unknown test role variable ${key}`);
    return `'${roles[key].replaceAll("'", "''")}'`;
  });
  const pieces = rendered.split("\\gexec");
  for (let index = 0; index < pieces.length; index++) {
    const sql = pieces[index].trim();
    if (!sql) continue;
    const results = await db.exec(sql);
    if (index === pieces.length - 1) continue;
    for (const result of results) for (const row of result.rows) {
      assert.deepEqual(Object.keys(row), ["format"], "role runner gexec result must be generated SQL");
      // PGlite has one embedded database and does not implement database ACL
      // changes reliably. Only CONNECT/database-level grants are excluded; all
      // schema/table/sequence/function/default privileges run unchanged below.
      if (/^(?:GRANT|REVOKE) .+ ON DATABASE /u.test(row.format)) continue;
      await db.exec(row.format);
    }
  }
}

async function fixture() {
  const db = new PGlite();
  try {
    await db.waitReady;
    const runner = await read("ops/postgres/run-migrations.sh");
    const blocks = [...runner.matchAll(/<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/gu)].map(match => match[1]);
    const setup = blocks.find(block => block.includes("CREATE ROLE %I NOLOGIN"));
    const grants = blocks.find(block => block.includes("CREATE ROLE %I LOGIN', :'runtime_user'"));
    assert.ok(setup && grants, "runner must expose schema/runtime role blocks");
    await psqlRoleBlock(db, setup);
    await db.exec(`SET ROLE ${roles.schema_owner}`);
    await db.exec("CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const names = (await readdir(new URL("../ops/postgres/migrations/", import.meta.url))).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
    assert.equal(new Set(names.map(name => name.slice(0, 4))).size, names.length, "migration numbers must not collide");
    for (const name of names) {
      const sql = await read(`ops/postgres/migrations/${name}`);
      await db.exec(sql);
      await db.query("INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)", [name, createHash("sha256").update(sql).digest("hex")]);
    }
    await db.exec("RESET ROLE");
    await psqlRoleBlock(db, grants);
    await db.exec("CREATE ROLE extension_untrusted NOLOGIN NOSUPERUSER NOBYPASSRLS");

    // One leased transaction at a time for PGlite's single connection. All app
    // queries execute as the real non-owner runtime role, not as fixture owner.
    let tail = Promise.resolve();
    async function lease(role) {
      const previous = tail;
      let unlock;
      tail = new Promise(resolve => { unlock = resolve; });
      await previous;
      try { await db.exec(`SET ROLE ${role}`); } catch (error) { unlock(); throw error; }
      return {
        async query(sql, params) { const r = await db.query(sql, params); return { ...r, rowCount: r.rows.length || r.affectedRows || 0 }; },
        async release() { try { await db.exec("RESET ROLE"); } finally { unlock(); } },
      };
    }
    async function queryAs(role, sql, params) {
      const client = await lease(role);
      try { return await client.query(sql, params); } finally { await client.release(); }
    }
    const ownerQuery = (sql, params) => queryAs(roles.schema_owner, sql, params);
    const pool = { query: (sql, params) => queryAs(roles.runtime_user, sql, params), connect: () => lease(roles.runtime_user) };
    // Deliberately NO spreads from either extension's store or route factories.
    // The production createAuthStore/createAuthServer must register everything.
    const store = createAuthStore(pool);
    const users = {};
    for (const name of ["owner", "other", "admin"]) {
      const userId = randomUUID(), sessionId = randomUUID(), token = createOpaqueToken();
      await ownerQuery("INSERT INTO app_users(id,role) VALUES ($1,$2)", [userId, name === "admin" ? "admin" : "user"]);
      await ownerQuery("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [sessionId, userId, tokenDigest(token, config.tokenPepper)]);
      users[name] = { userId, sessionId, token, cookie: `${config.sessionCookie}=${token}` };
    }
    const elevationToken = createOpaqueToken();
    await ownerQuery("INSERT INTO admin_elevated_sessions(user_id,base_session_id,token_hash,method,expires_at) VALUES ($1,$2,$3,'totp',now()+interval '10 minutes')", [users.admin.userId, users.admin.sessionId, tokenDigest(elevationToken, config.tokenPepper)]);
    users.admin.elevatedCookie = `${users.admin.cookie}; ${config.adminCookie}=${elevationToken}`;
    const calls = [];
    for (const name of ["getActiveSession", "getDataFeedbackSession", "listAdminDataFeedback", "createDataFeedback", "listMaterialBookmarks", "setMaterialBookmark"]) {
      if (typeof store[name] !== "function") continue;
      const real = store[name];
      store[name] = (...args) => { calls.push(name); return real(...args); };
    }
    const rates = createApiRateLimiters({ store });
    const server = createAuthServer({ store, config, adminSecurity: {}, rateLimiters: rates });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    async function call(path, { user = "owner", cookie, method = "GET", body, headers = {} } = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method, headers: {
          ...(cookie !== undefined ? { Cookie: cookie } : user ? { Cookie: users[user].cookie } : {}),
          Origin: origin, "Content-Type": "application/json",
          ...(user ? { "X-Material-Bookmark-Owner": users[user].userId } : {}), ...headers,
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    }
    return { db, names, runner, pool, store, users, rates, calls, call, ownerQuery, queryAs,
      async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await tail; await db.close(); } };
  } catch (error) { await db.close(); throw error; }
}

test("createAuthServer dispatches bookmarks/feedback through registered stores and migrated runtime permissions", { timeout: 60000 }, async t => {
  const f = await fixture();
  t.after(() => f.close());
  let feedbackId;
  const own = "/api/auth/data-feedback", admin = "/api/admin/data-feedback", bookmarks = "/api/material-bookmarks";

  await t.test("production store factory installs both extensions without test-only composition", () => {
    for (const name of ["getDataFeedbackSession", "createDataFeedback", "listOwnDataFeedback", "getOwnDataFeedback", "listAdminDataFeedback", "getAdminDataFeedback", "resolveDataFeedback", "listMaterialBookmarks", "setMaterialBookmark"]) {
      assert.equal(typeof f.store[name], "function", `createAuthStore is missing ${name}`);
    }
  });
  await t.test("anonymous reads/writes and cross-origin mutations are denied by the main server", async () => {
    for (const [path, method, body] of [[bookmarks, "GET"], [`${bookmarks}/${materialId}`, "PUT", {}], [own, "GET"], [`${own}/session`, "GET"], [own, "POST", draft()], [admin, "GET"]]) {
      const response = await f.call(path, { user: null, method, body });
      assert.equal(response.status, 401, `${method} ${path}`); assert.equal(response.body.error, "authentication_required");
      assert.match(response.headers.get("cache-control"), /no-store/u);
    }
    for (const [path, method, body] of [[`${bookmarks}/${materialId}`, "PUT", {}], [own, "POST", draft()]]) {
      assert.equal((await f.call(path, { method, body, headers: { Origin: "https://foreign.test" } })).status, 403);
      assert.equal((await f.call(path, { method, body, headers: { Origin: "" } })).status, 403);
    }
  });
  await t.test("bookmark add/read/delete are persistent, isolated and owner-header bound", async () => {
    const added = await f.call(`${bookmarks}/${materialId}`, { method: "PUT", body: {} });
    assert.equal(added.status, 200); assert.equal(added.body.bookmarked, true);
    assert.equal((await f.call(`${bookmarks}/${materialId}`, { method: "PUT", body: {} })).status, 200);
    const mine = await f.call(bookmarks);
    assert.equal(mine.status, 200); assert.equal(mine.body.userId, f.users.owner.userId);
    assert.deepEqual(mine.body.items.map(item => item.materialId), [materialId]);
    assert.equal(mine.headers.get("vary"), "Cookie");
    assert.deepEqual((await f.call(bookmarks, { user: "other" })).body.items, []);
    assert.equal((await f.call(`${bookmarks}/${materialId}`, { user: "other", method: "DELETE", body: {}, headers: { "X-Material-Bookmark-Owner": f.users.owner.userId } })).status, 409);
    assert.equal((await f.call(`${bookmarks}?userId=${f.users.other.userId}`)).status, 400);
    assert.equal((await f.ownerQuery("SELECT count(*)::int AS n FROM material_bookmark_events")).rows[0].n, 1);
    assert.equal((await f.call(`${bookmarks}/${materialId}`, { method: "DELETE", body: {} })).status, 200);
    assert.deepEqual((await f.call(bookmarks)).body.items, []);
    assert.equal((await f.call(`${bookmarks}/${materialId}`, { method: "PUT", body: {} })).status, 200);
  });
  await t.test("feedback creates real receipts; retries are idempotent and another account gets 404", async () => {
    const body = draft();
    f.calls.length = 0;
    const created = await f.call(own, { method: "POST", body });
    assert.equal(created.status, 201); feedbackId = created.body.feedback.id;
    assert.equal(created.body.created, true); assert.equal(created.body.feedback.status, "open");
    assert.ok(f.calls.includes("getDataFeedbackSession")); assert.equal(f.calls.includes("getActiveSession"), false, "feedback must not invoke the registration-field session reader");
    const replay = await f.call(own, { method: "POST", body });
    assert.equal(replay.status, 200); assert.equal(replay.body.feedback.id, feedbackId); assert.equal(replay.body.created, false);
    assert.equal((await f.call(`${own}/${feedbackId}`, { user: "other" })).status, 404);
    assert.deepEqual((await f.call(own, { user: "other" })).body.items, []);
    assert.equal((await f.call(own)).body.items[0].id, feedbackId);
    assert.equal((await f.call(`${own}?userId=${f.users.other.userId}`)).status, 400);
  });
  await t.test("specific admin feedback dispatch precedes generic admin; MFA and audit survive registration", async () => {
    assert.ok(feedbackId, "receipt must have been persisted through the main server");
    const denied = await f.call(admin);
    assert.equal(denied.status, 403); assert.equal(denied.body.error, "admin_forbidden");
    const unelevated = await f.call(admin, { user: "admin" });
    assert.equal(unelevated.status, 403); assert.equal(unelevated.body.error, "admin_mfa_required");
    f.calls.length = 0;
    const elevated = { user: "admin", cookie: f.users.admin.elevatedCookie };
    const queue = await f.call(admin, elevated);
    assert.equal(queue.status, 200, "404 here means generic /api/admin/* swallowed the extension");
    assert.equal(queue.body.items[0].id, feedbackId); assert.ok(queue.body.elevatedUntil);
    assert.ok(f.calls.includes("listAdminDataFeedback")); assert.equal(f.calls.includes("getActiveSession"), false);
    const resolved = await f.call(`${admin}/${feedbackId}`, { ...elevated, method: "PATCH", body: { status: "resolved", version: 1, note: "确认文件已恢复访问。" } });
    assert.equal(resolved.status, 200); assert.equal(resolved.body.feedback.status, "resolved");
    const detail = await f.call(`${admin}/${feedbackId}`, elevated);
    assert.equal(detail.status, 200); assert.equal(detail.body.feedback.actions.length, 1);
    assert.equal((await f.call(`${own}/${feedbackId}`)).body.feedback.status, "resolved");
    assert.equal(Object.hasOwn((await f.call(`${own}/${feedbackId}`)).body.feedback, "actions"), false);
    const audit = await f.ownerQuery("SELECT metadata FROM admin_audit_events WHERE action='admin.data_feedback.status_changed' AND target_id=$1", [feedbackId]);
    assert.equal(audit.rowCount, 1); assert.deepEqual(audit.rows[0].metadata, { fromStatus: "open", toStatus: "resolved", version: 2 });
    assert.equal((await f.call("/api/admin/session", elevated)).status, 200, "generic admin routes must remain registered");
    assert.equal((await f.call("/api/admin/not-a-real-route", elevated)).status, 404);
    await f.ownerQuery("UPDATE admin_elevated_sessions SET expires_at=now()-interval '1 second'");
    const expired = await f.call(admin, elevated);
    assert.equal(expired.status, 403); assert.equal(expired.body.error, "admin_mfa_required");
  });
  await t.test("global limiter still runs before either extension and persistent extension limits fail closed", async () => {
    for (const method of ["read", "write"]) {
      const old = f.rates[method]; f.rates[method] = { consume: async () => false };
      try {
        f.calls.length = 0;
        for (const path of [bookmarks, own]) {
          const response = await f.call(method === "write" && path === bookmarks ? `${path}/${materialId}` : path, method === "read" ? {} : { method: path === bookmarks ? "PUT" : "POST", body: path === bookmarks ? {} : draft() });
          assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "15");
        }
        assert.deepEqual(f.calls, [], "global rejection must not touch extension store methods");
      } finally { f.rates[method] = old; }
    }
    const consume = f.store.consumeRateLimit;
    f.store.consumeRateLimit = async () => { throw new Error("synthetic persistent limiter outage"); };
    try {
      assert.equal((await f.call(bookmarks)).status, 503);
      assert.equal((await f.call(own)).status, 503);
    } finally { f.store.consumeRateLimit = consume; }
  });
  await t.test("revoked sessions cannot use either extension; runtime account deletion cascades private rows", async () => {
    await f.ownerQuery("UPDATE user_sessions SET revoked_at=now() WHERE id=$1", [f.users.owner.sessionId]);
    for (const path of [bookmarks, own]) assert.equal((await f.call(path)).status, 401);
    await f.pool.query("DELETE FROM app_users WHERE id=$1", [f.users.owner.userId]);
    for (const table of ["material_bookmarks", "data_feedback", "data_feedback_actions"]) {
      assert.equal((await f.ownerQuery(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
    }
    assert.ok((await f.ownerQuery("SELECT count(*)::int AS n FROM material_bookmark_events")).rows[0].n > 0);
    assert.ok((await f.ownerQuery("SELECT count(*)::int AS n FROM admin_audit_events")).rows[0].n > 0);
  });
});

test("new migrations receive real runner role grants without exposing private tables or mutable audit logs", { timeout: 60000 }, async t => {
  const f = await fixture();
  t.after(() => f.close());
  assert.ok(f.names.includes("0025_material_bookmarks.sql")); assert.ok(f.names.includes("0026_data_feedback.sql"));
  assert.match(f.runner, /Migration checksum mismatch/u); assert.match(f.runner, /sha256sum/u);
  const privilege = async (role, table, operation) => (await f.queryAs(role, "SELECT has_table_privilege(current_user,$1,$2) AS allowed", [table, operation])).rows[0].allowed;
  const tables = ["material_bookmarks", "material_bookmark_events", "data_feedback", "data_feedback_actions"];
  await t.test("runtime gets read/write/sequence access; import and public roles get none; backup is read-only", async () => {
    for (const table of tables) {
      for (const operation of ["SELECT", "INSERT"]) assert.equal(await privilege(roles.runtime_user, table, operation), true, `runtime ${table} ${operation}`);
      for (const role of [roles.import_user, "extension_untrusted"]) {
        for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) assert.equal(await privilege(role, table, operation), false, `${role} ${table} ${operation}`);
        await assert.rejects(f.queryAs(role, `SELECT * FROM ${table}`), { code: "42501" });
      }
      assert.equal(await privilege(roles.backup_user, table, "SELECT"), true);
      for (const operation of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) assert.equal(await privilege(roles.backup_user, table, operation), false);
    }
    for (const sequence of ["material_bookmark_events_id_seq", "data_feedback_actions_id_seq"]) assert.equal((await f.pool.query("SELECT has_sequence_privilege(current_user,$1,'USAGE') AS allowed", [sequence])).rows[0].allowed, true);
    for (const role of [roles.runtime_user, roles.import_user, roles.backup_user]) {
      const flags = (await f.queryAs(role, "SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.deepEqual(flags, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
      assert.notEqual(role, roles.schema_owner);
    }
  });
  await t.test("runtime cannot mutate or truncate either processing/audit log", async () => {
    for (const table of ["material_bookmark_events", "data_feedback_actions"]) {
      for (const operation of ["UPDATE", "DELETE", "TRUNCATE"]) assert.equal(await privilege(roles.runtime_user, table, operation), false, `run-migrations.sh must revoke runtime ${operation} on ${table}`);
      for (const statement of [`UPDATE ${table} SET created_at=created_at`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) await assert.rejects(f.pool.query(statement), { code: "42501" });
    }
  });
  await t.test("migration ledger and rate buckets are inaccessible; only the quota function is executable", async () => {
    for (const table of ["schema_migrations", "api_rate_limit_buckets"]) assert.equal(await privilege(roles.runtime_user, table, "SELECT"), false);
    assert.equal((await f.pool.query("SELECT has_function_privilege(current_user,'consume_api_rate_limit(text,bytea,double precision,double precision)','EXECUTE') AS allowed")).rows[0].allowed, true);
    assert.equal((await f.queryAs("extension_untrusted", "SELECT has_function_privilege(current_user,'reject_material_bookmark_event_mutation()','EXECUTE') AS allowed")).rows[0].allowed, false);
    for (const name of ["0025_material_bookmarks.sql", "0026_data_feedback.sql"]) {
      const row = (await f.ownerQuery("SELECT checksum FROM schema_migrations WHERE version=$1", [name])).rows[0];
      assert.equal(row.checksum, createHash("sha256").update(await read(`ops/postgres/migrations/${name}`)).digest("hex"));
    }
  });
});

function matchingBrace(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return i;
  }
  throw new Error("unclosed Caddy block");
}
function caddyTarget(source, path) {
  const matchers = new Map([...source.matchAll(/(@[A-Za-z0-9_]+)\s+path\s+([^\r\n]+)/gu)].map(match => [match[1], match[2].trim().split(/\s+/u)]));
  for (const match of source.matchAll(/\bhandle\s+([^\s{]+)\s*\{/gu)) {
    const patterns = match[1].startsWith("@") ? matchers.get(match[1]) ?? [] : [match[1]];
    if (!patterns.some(pattern => pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern)) continue;
    const start = match.index + match[0].lastIndexOf("{");
    const block = source.slice(start, matchingBrace(source, start));
    return block.match(/reverse_proxy\s+(\S+)/u)?.[1] ?? null;
  }
  return null;
}

test("development, public production/staging and isolated staging gateways route both extension prefixes to auth", async () => {
  const publicGateway = await read("deploy/Caddyfile");
  const productionStart = publicGateway.indexOf("(dufesh_proxy) {");
  const productionBrace = publicGateway.indexOf("{", productionStart);
  const stagingStart = publicGateway.indexOf("staging.dufesh.cn {");
  const stagingBrace = publicGateway.indexOf("{", stagingStart);
  assert.ok(productionStart >= 0 && stagingStart >= 0);
  for (const [source, target] of [
    [publicGateway.slice(productionBrace, matchingBrace(publicGateway, productionBrace)), "production-auth-api:3100"],
    [publicGateway.slice(stagingBrace, matchingBrace(publicGateway, stagingBrace)), "staging-auth-api:3100"],
    [await read("deploy/staging/Caddyfile"), "auth-api:3100"],
  ]) {
    for (const path of ["/api/material-bookmarks", `/api/material-bookmarks/${materialId}`, "/api/auth/data-feedback", "/api/auth/data-feedback/session", "/api/admin/data-feedback", `/api/admin/data-feedback/${randomUUID()}`]) {
      assert.equal(caddyTarget(source, path), target, `${target} must handle ${path}`);
    }
    assert.equal(caddyTarget(source, "/api/material-bookmarks-malicious"), null, "bookmark matcher must not swallow unrelated APIs");
  }
  const vite = await read("vite.config.ts");
  for (const prefix of ["/api/material-bookmarks", "/api/auth", "/api/admin"]) assert.ok(vite.includes(`"${prefix}"`) && vite.includes("authApiDevTarget"), `dev proxy missing ${prefix}`);
});
