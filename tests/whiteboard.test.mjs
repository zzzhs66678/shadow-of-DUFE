import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createAuthStore } from "../services/auth-api/src/db.mjs";
import { createAuthServer } from "../services/auth-api/src/server.mjs";
import { createWhiteboardStore } from "../services/auth-api/src/whiteboard-store.mjs";
import { createWhiteboardRateLimiters, createWhiteboardRequestHandler } from "../services/auth-api/src/whiteboard-routes.mjs";
import { createApiRateLimiters } from "../services/auth-api/src/rate-limit.mjs";
import { createOpaqueToken, tokenDigest } from "../services/auth-api/src/tokens.mjs";
import { encodeWhiteboardCursor, validateWhiteboardContent, validateWhiteboardMutation, whiteboardPageQuery, whiteboardTimestamp } from "../services/auth-api/src/whiteboard-contract.mjs";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const origin = "https://whiteboard.test";
const config = { tokenPepper: "synthetic-whiteboard-pepper-not-a-production-secret", allowedOrigins: new Set([origin]),
  sessionCookie: "__Host-board-session", adminCookie: "__Host-board-admin", deviceCookie: "__Host-board-device",
  oauthCookie: "__Host-board-oauth", adminEnabled: true, passwordResetMode: "disabled", emailVerificationMode: "disabled", wechatMode: "disabled" };
const roles = { schema_owner: "board_schema", migration_user: "board_migrator", migration_password: "synthetic-migration",
  runtime_user: "board_runtime", runtime_password: "synthetic-runtime", import_user: "board_import", import_password: "synthetic-import",
  backup_user: "board_backup", backup_password: "synthetic-backup" };
const publicPath = "/api/community/whiteboard", adminPath = "/api/admin/whiteboard";
const note = (overrides = {}) => ({ kind: "note", title: "", body: "仅用于测试的便笺", status: "draft", mutationId: randomUUID(), ...overrides });
const event = (overrides = {}) => ({ ...note(), kind: "event", title: "合成测试活动", body: "合成活动说明", guest: "测试嘉宾", guestBio: "测试介绍",
  location: "合成地点", startsAt: "2099-01-01T14:00:00+08:00", endsAt: "2099-01-01T16:00:00+08:00", ...overrides });
const publicKeys = ["id", "kind", "title", "body", "guest", "guestBio", "location", "startsAt", "endsAt", "expiresAt", "status", "version", "publishedAt", "updatedAt"].sort();

// Evaluate the checked-in runner's actual SQL, not a handwritten ACL substitute.
// PGlite only skips database CONNECT grants; table/function/sequence grants run.
async function roleBlock(db, block) {
  assert.ok(block);
  const pieces = block.replace(/:'([a-z_]+)'/gu, (_, key) => {
    assert.ok(Object.hasOwn(roles, key)); return `'${roles[key]}'`;
  }).split("\\gexec");
  for (let i = 0; i < pieces.length; i++) {
    if (!pieces[i].trim()) continue;
    const results = await db.exec(pieces[i]);
    if (i === pieces.length - 1) continue;
    for (const result of results) for (const row of result.rows) {
      if (/^(?:GRANT|REVOKE) .+ ON DATABASE /u.test(row.format)) continue;
      await db.exec(row.format);
    }
  }
}

async function fixture(t) {
  const db = new PGlite();
  let server, tail = Promise.resolve();
  t.after(async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await tail; await db.close();
  });
  await db.waitReady;
  const runner = await read("ops/postgres/run-migrations.sh");
  const blocks = [...runner.matchAll(/<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/gu)].map(match => match[1]);
  await roleBlock(db, blocks.find(block => block.includes("CREATE ROLE %I NOLOGIN")));
  await db.exec(`SET ROLE ${roles.schema_owner}`);
  await db.exec("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())");
  const names = (await readdir(new URL("../ops/postgres/migrations/", import.meta.url))).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
  assert.equal(new Set(names.map(name => name.slice(0, 4))).size, names.length);
  let before;
  for (const name of names) {
    if (name === "0028_public_whiteboard.sql") {
      await db.query("INSERT INTO app_users(display_name) VALUES ('PRIVATE_LEGACY_ACCOUNT')");
      before = (await db.query("SELECT * FROM app_users ORDER BY id")).rows;
    }
    const sql = await read(`ops/postgres/migrations/${name}`);
    await db.exec(sql);
    await db.query("INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)", [name, createHash("sha256").update(sql).digest("hex")]);
  }
  assert.ok(before, "reserved migration 0028 must exist");
  assert.deepEqual((await db.query("SELECT * FROM app_users ORDER BY id")).rows, before, "migration preserves existing accounts");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM whiteboard_entries")).rows[0].n, 0, "migration never publishes seed content");
  await db.exec("RESET ROLE");
  const grants = blocks.find(block => block.includes("CREATE ROLE %I LOGIN', :'runtime_user'"));
  await roleBlock(db, grants);
  await roleBlock(db, grants);
  await db.exec("CREATE ROLE board_public NOLOGIN NOSUPERUSER NOBYPASSRLS");
  async function lease(role) {
    const before = tail; let unlock;
    tail = new Promise(resolve => { unlock = resolve; });
    await before;
    try { await db.exec(`SET ROLE ${role}`); } catch (error) { unlock(); throw error; }
    return {
      async query(sql, params) { const result = await db.query(sql, params); return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }; },
      async release() { try { await db.exec("RESET ROLE"); } finally { unlock(); } },
    };
  }
  async function queryAs(role, sql, params) {
    const client = await lease(role);
    try { return await client.query(sql, params); } finally { await client.release(); }
  }
  const ownerQuery = (sql, params) => queryAs(roles.schema_owner, sql, params);
  const pool = { query: (sql, params) => queryAs(roles.runtime_user, sql, params), connect: () => lease(roles.runtime_user) };
  const store = createAuthStore(pool);
  const users = {};
  for (const name of ["admin", "otherAdmin", "user"]) {
    const userId = randomUUID(), sessionId = randomUUID(), token = createOpaqueToken();
    await ownerQuery("INSERT INTO app_users(id,role,display_name) VALUES ($1,$2,$3)", [userId, name === "user" ? "user" : "admin", `PRIVATE_${name}`]);
    await ownerQuery("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [sessionId, userId, tokenDigest(token, config.tokenPepper)]);
    const elevated = createOpaqueToken(), elevationTokenHash = tokenDigest(elevated, config.tokenPepper);
    await ownerQuery("INSERT INTO admin_elevated_sessions(user_id,base_session_id,token_hash,method,expires_at) VALUES ($1,$2,$3,'totp',now()+interval '10 minutes')", [userId, sessionId, elevationTokenHash]);
    users[name] = { userId, sessionId, token, elevationTokenHash, cookie: `${config.sessionCookie}=${token}`, elevatedCookie: `${config.sessionCookie}=${token}; ${config.adminCookie}=${elevated}` };
  }
  const adminInput = (name = "admin") => ({ ...users[name], requestId: randomUUID(), ipHash: "a".repeat(64), userAgentHash: "b".repeat(64) });
  const rates = createApiRateLimiters({ store });
  server = createAuthServer({ store, config, adminSecurity: {}, rateLimiters: rates });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  async function call(path, { user = null, elevated = false, method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, signal: AbortSignal.timeout(10_000), headers: { Origin: origin, "Content-Type": "application/json",
        ...(user ? { Cookie: elevated ? users[user].elevatedCookie : users[user].cookie, "X-Whiteboard-Owner": users[user].userId } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const mutate = (data, entryId = null, name = "admin") => store.mutateWhiteboard({ ...adminInput(name), entryId, data });
  const page = (query = "") => store.listPublicWhiteboard(whiteboardPageQuery(new URLSearchParams(query)));
  return { db, pool, store, users, adminInput, ownerQuery, queryAs, call, mutate, page, rates };
}

test("whiteboard content/date/mutation/query contracts are bounded, explicit and reject mixed note/event state", () => {
  const good = validateWhiteboardMutation(note());
  assert.equal(good.fields.title, ""); assert.equal(good.fields.expiresAt, null);
  assert.equal(whiteboardTimestamp("2030-02-28T14:30+08:00"), "2030-02-28T06:30:00.000Z");
  assert.equal(whiteboardTimestamp("2028-02-29T14:30:00.1Z"), "2028-02-29T14:30:00.100Z");
  for (const date of ["2030-02-30T14:30:00Z", "2030-02-28T25:00Z", "2030-02-28T14:30", "2030-02-28", "2030-02-28T14:30:00+00:00", "2030-02-28T14:30:60Z", "infinity", 1, {}]) assert.equal(whiteboardTimestamp(date), undefined, String(date));
  for (const patch of [{ kind: "secret" }, { status: "archive" }, { status: undefined }, { body: "" }, { body: " \n " }, { body: "\u200b" }, { body: "x".repeat(4001) },
    { title: "x".repeat(121) }, { title: null }, { guest: "x" }, { guestBio: "x" }, { location: "x" }, { startsAt: "2030-01-01T00:00:00Z" },
    { endsAt: "2030-01-01T01:00:00Z" }, { expiresAt: "2030-02-30T00:00:00Z" }, { body: "ab\u0000" }, { body: "\ud800" }, { body: 1 },
    { userId: randomUUID() }, { publishedAt: "2030-01-01T00:00:00Z" }, { version: 1 }, { mutationId: "no" }]) {
    assert.equal(validateWhiteboardMutation(note(patch)), null, JSON.stringify(patch));
  }
  for (const patch of [{ title: "" }, { body: "" }, { startsAt: null }, { endsAt: null }, { endsAt: "2099-01-01T13:00:00+08:00" },
    { expiresAt: "2099-01-01T15:00:00+08:00" }, { guest: "x".repeat(81) }, { guestBio: "x".repeat(1501) }, { location: "x".repeat(161) }]) assert.equal(validateWhiteboardMutation(event(patch)), null);
  const normalizedEvent = validateWhiteboardMutation(event()).fields;
  assert.equal(normalizedEvent.endsAt, "2099-01-01T08:00:00.000Z");
  assert.equal(normalizedEvent.expiresAt, null);
  assert.equal(validateWhiteboardContent({ ...normalizedEvent, kind: "note" }), null);
  assert.ok(validateWhiteboardMutation({ mutationId: randomUUID(), status: "published", version: 1 }, true));
  for (const version of [0, -1, "1", 1.2, 2147483647]) assert.equal(validateWhiteboardMutation({ mutationId: randomUUID(), status: "published", version }, true), null);
  for (const query of ["scope=all", "scope=active&scope=archive", "limit=0", "limit=51", "limit=2.5", "cursor=", "cursor=e30", "viewerId=someone", "status=draft"]) assert.equal(whiteboardPageQuery(new URLSearchParams(query)), null);
  assert.equal(whiteboardPageQuery(new URLSearchParams("status=all&limit=50"), true).limit, 50);
  const cursor = encodeWhiteboardCursor({ v: 1, scope: "public:archive", at: "2030-01-01T00:00:00.123456Z", id: randomUUID() });
  assert.equal(whiteboardPageQuery(new URLSearchParams(`scope=archive&cursor=${cursor}`)).cursor.at, "2030-01-01T00:00:00.123456Z");
  assert.equal(whiteboardPageQuery(new URLSearchParams(`scope=active&cursor=${cursor}`)), null);
  assert.equal(whiteboardPageQuery(new URLSearchParams(`cursor=${cursor}`), true), null);
});

test("whiteboard runtime SQL lifecycle: idempotence, publication time, conflict, expiry and public whitelist", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await t.test("create/retry/edit/publish/withdraw/republish is versioned and exactly-once audited", async () => {
    const data = note();
    const created = await f.mutate(data);
    assert.equal(created.entry.version, 1); assert.equal(created.entry.publishedAt, null);
    assert.deepEqual((await f.mutate(data)).entry, created.entry);
    assert.equal((await f.mutate(data)).replayed, true);
    await assert.rejects(f.mutate({ ...data, body: "更改请求不得复用标识" }), { code: "WHITEBOARD_MUTATION_CONFLICT" });
    const id = created.entry.id;
    const publish = { status: "published", version: 1, mutationId: randomUUID() };
    const published = await f.mutate(publish, id);
    assert.ok(published.entry.publishedAt); assert.equal(published.entry.version, 2);
    const retry = await f.mutate(publish, id);
    assert.deepEqual(retry.entry, published.entry);
    await assert.rejects(f.mutate({ ...publish, mutationId: randomUUID() }, id), { code: "WHITEBOARD_CONFLICT" });
    const edited = await f.mutate({ status: "published", version: 2, body: "编辑不置顶", mutationId: randomUUID() }, id);
    assert.equal(edited.entry.version, 3); assert.equal(edited.entry.publishedAt, published.entry.publishedAt);
    assert.deepEqual((await f.mutate(publish, id)).entry, published.entry, "retry old success returns the original receipt even after later edits");
    await assert.rejects(f.mutate({ ...publish, version: 3 }, id), { code: "WHITEBOARD_MUTATION_CONFLICT" });
    const withdrawn = await f.mutate({ status: "withdrawn", version: 3, mutationId: randomUUID() }, id);
    assert.equal(withdrawn.entry.publishedAt, published.entry.publishedAt);
    assert.equal((await f.page()).items.some(row => row.id === id), false);
    assert.equal((await f.page("scope=archive")).items.some(row => row.id === id), false);
    const republished = await f.mutate({ status: "published", version: 4, mutationId: randomUUID() }, id);
    assert.ok(republished.entry.publishedAt > published.entry.publishedAt);
    assert.equal((await f.ownerQuery("SELECT count(*)::int AS n FROM whiteboard_actions WHERE entry_id=$1", [id])).rows[0].n, 5);
    const audit = (await f.ownerQuery("SELECT metadata FROM admin_audit_events WHERE target_id=$1", [id])).rows;
    assert.equal(audit.length, 5); assert.equal(JSON.stringify(audit).includes("编辑不置顶"), false);
    const concurrent = await Promise.allSettled([1, 2].map(() => f.mutate({ status: "published", version: 5, title: "并发编辑", mutationId: randomUUID() }, id)));
    assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.find(result => result.status === "rejected").reason.code, "WHITEBOARD_CONFLICT");
  });
  await t.test("active/archive filter in SQL on every read; anonymous response never includes private actor fields", async () => {
    const indefinite = (await f.mutate(note({ status: "published" }))).entry;
    const expired = (await f.mutate(note({ status: "published", expiresAt: "2001-01-01T00:00:00Z" }))).entry;
    const pending = (await f.mutate(note())).entry;
    const futureEvent = (await f.mutate(event({ status: "published" }))).entry;
    const oldEvent = (await f.mutate(event({ status: "published", startsAt: "2001-01-01T12:00:00+08:00", endsAt: "2001-01-01T14:00:00+08:00" }))).entry;
    const active = (await f.page()).items;
    assert.ok(active.some(row => row.id === indefinite.id)); assert.ok(active.some(row => row.id === futureEvent.id));
    for (const id of [expired.id, pending.id, oldEvent.id]) assert.equal(active.some(row => row.id === id), false);
    const archive = (await f.page("scope=archive")).items;
    assert.ok(archive.some(row => row.id === expired.id)); assert.ok(archive.some(row => row.id === oldEvent.id));
    for (const item of [...active, ...archive]) assert.deepEqual(Object.keys(item).sort(), publicKeys);
    assert.equal(JSON.stringify([...active, ...archive]).includes(f.users.admin.userId), false);
    assert.equal(JSON.stringify([...active, ...archive]).includes("PRIVATE_"), false);
    // Move the expiry boundary to now with SQL: never wait for a wall-clock timer.
    await f.ownerQuery("UPDATE whiteboard_entries SET expires_at=statement_timestamp() WHERE id=$1", [indefinite.id]);
    assert.equal((await f.page()).items.some(row => row.id === indefinite.id), false);
    assert.ok((await f.page("scope=archive")).items.some(row => row.id === indefinite.id));
    await assert.rejects(f.mutate({ status: "draft", version: 1, kind: "note", mutationId: randomUUID() }, futureEvent.id), { code: "WHITEBOARD_INVALID" });
    const changed = await f.mutate({ status: "draft", version: 1, kind: "note", guest: "", guestBio: "", location: "", startsAt: null, endsAt: null, mutationId: randomUUID() }, futureEvent.id);
    assert.equal(changed.entry.kind, "note"); assert.equal(changed.entry.guest, ""); assert.equal(changed.entry.endsAt, null);
  });
  await t.test("archive/admin history keysets paginate same-second microsecond ties without truncation or duplication", async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await f.mutate(note({ status: "published", expiresAt: "2001-01-01T00:00:00Z" }))).entry.id);
    for (const [i, id] of ids.entries()) await f.ownerQuery("UPDATE whiteboard_entries SET published_at=$2,updated_at=$2 WHERE id=$1", [id, `2098-01-01T00:00:00.00000${i < 2 ? 1 : i}Z`]);
    let cursor = null; const seen = [];
    do {
      const response = await f.page(`scope=archive&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...response.items.map(row => row.id)); cursor = response.nextCursor;
      assert.ok(seen.length < 30);
    } while (cursor);
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(seen.slice(0, 4), [ids[3], ids[2], ...ids.slice(0, 2).sort().reverse()]);
    cursor = null; const adminSeen = [];
    do {
      const page = whiteboardPageQuery(new URLSearchParams(`status=all&limit=2${cursor ? `&cursor=${cursor}` : ""}`), true);
      const result = await f.store.listAdminWhiteboard({ ...f.adminInput(), page });
      adminSeen.push(...result.items.map(row => row.id)); cursor = result.nextCursor;
      assert.ok(adminSeen.length < 30);
    } while (cursor);
    assert.equal(new Set(adminSeen).size, adminSeen.length);
    assert.equal(adminSeen.length, (await f.ownerQuery("SELECT count(*)::int AS n FROM whiteboard_entries")).rows[0].n);
  });
});

test("whiteboard MFA revalidation, transaction rollback and append-only runtime grants", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const count = async table => (await f.ownerQuery(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const created = await f.mutate(note());
  const id = created.entry.id;
  await t.test("failed global audit rolls back content, immutable action and mutation claim", async () => {
    const data = { status: "published", version: 1, mutationId: randomUUID() };
    const brokenStore = createWhiteboardStore({ connect: async () => {
      const client = await f.pool.connect();
      return { query: (sql, params) => /INSERT INTO admin_audit_events/u.test(sql) ? client.query("SELECT 1/0") : client.query(sql, params), release: () => client.release() };
    } });
    await assert.rejects(brokenStore.mutateWhiteboard({ ...f.adminInput(), entryId: id, data }), { code: "22012" });
    assert.equal(await count("whiteboard_actions"), 1);
    assert.deepEqual((await f.ownerQuery("SELECT status,version,published_at FROM whiteboard_entries WHERE id=$1", [id])).rows[0], { status: "draft", version: 1, published_at: null });
    assert.equal((await f.mutate(data, id)).entry.status, "published", "failed attempt must not consume mutationId");
    assert.equal(await count("whiteboard_actions"), 2); assert.equal(await count("admin_audit_events"), 2);
  });
  await t.test("roles, base session ownership and current MFA are checked inside every transaction including retries", async () => {
    const data = note();
    const saved = await f.mutate(data);
    for (const patch of [{ userId: f.users.user.userId, sessionId: f.users.user.sessionId, elevationTokenHash: f.users.user.elevationTokenHash },
      { sessionId: f.users.otherAdmin.sessionId }, { elevationTokenHash: f.users.otherAdmin.elevationTokenHash }]) {
      await assert.rejects(f.store.mutateWhiteboard({ ...f.adminInput(), ...patch, entryId: null, data }), { code: "AUTH_ADMIN_FORBIDDEN" });
    }
    for (const statement of ["UPDATE app_users SET role='user' WHERE id=$1", "UPDATE app_users SET status='disabled' WHERE id=$1"]) {
      await f.ownerQuery(statement, [f.users.admin.userId]);
      await assert.rejects(f.mutate(data), { code: "AUTH_ADMIN_FORBIDDEN" });
      await f.ownerQuery("UPDATE app_users SET role='admin',status='active' WHERE id=$1", [f.users.admin.userId]);
    }
    await f.ownerQuery("UPDATE admin_elevated_sessions SET expires_at=now()-interval '1 second' WHERE base_session_id=$1", [f.users.admin.sessionId]);
    await assert.rejects(f.mutate(data), { code: "AUTH_ADMIN_FORBIDDEN" });
    await assert.rejects(f.store.listAdminWhiteboard({ ...f.adminInput(), page: whiteboardPageQuery(new URLSearchParams(), true) }), { code: "AUTH_ADMIN_FORBIDDEN" });
    await f.ownerQuery("UPDATE admin_elevated_sessions SET expires_at=now()+interval '10 minutes' WHERE base_session_id=$1", [f.users.admin.sessionId]);
    await f.ownerQuery("UPDATE user_sessions SET revoked_at=now() WHERE id=$1", [f.users.admin.sessionId]);
    await assert.rejects(f.mutate(data), { code: "AUTH_ADMIN_FORBIDDEN" });
    await f.ownerQuery("UPDATE user_sessions SET revoked_at=NULL WHERE id=$1", [f.users.admin.sessionId]);
    assert.deepEqual((await f.mutate(data)).entry, saved.entry);
    // Force MFA invalidation after the initial check but before commit, inside
    // the same real transaction. This must also roll back content and receipts.
    const invalidated = createWhiteboardStore({ connect: async () => {
      const client = await f.pool.connect();
      return { async query(sql, params) {
        const result = await client.query(sql, params);
        if (/INSERT INTO whiteboard_actions/u.test(sql)) await client.query("UPDATE admin_elevated_sessions SET expires_at=now()-interval '1 second' WHERE base_session_id=$1", [f.users.admin.sessionId]);
        return result;
      }, release: () => client.release() };
    } });
    const before = await count("whiteboard_entries");
    await assert.rejects(invalidated.mutateWhiteboard({ ...f.adminInput(), entryId: null, data: note() }), { code: "AUTH_ADMIN_FORBIDDEN" });
    assert.equal(await count("whiteboard_entries"), before);
  });
  await t.test("migration ACL denies private log reads to import/public and all audit mutation; account removal retains public history", async () => {
    for (const table of ["whiteboard_entries", "whiteboard_actions"]) {
      for (const role of [roles.import_user, "board_public"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          assert.equal((await f.queryAs(role, "SELECT has_table_privilege(current_user,$1,$2) AS allowed", [table, privilege])).rows[0].allowed, false);
        }
      }
      assert.equal((await f.queryAs(roles.backup_user, "SELECT has_table_privilege(current_user,$1,'SELECT') AS allowed", [table])).rows[0].allowed, true);
      assert.equal((await f.queryAs(roles.backup_user, "SELECT has_table_privilege(current_user,$1,'INSERT') AS allowed", [table])).rows[0].allowed, false);
    }
    for (const sql of ["UPDATE whiteboard_actions SET version=version", "DELETE FROM whiteboard_actions", "TRUNCATE whiteboard_actions", "DELETE FROM whiteboard_entries", "TRUNCATE whiteboard_entries"]) await assert.rejects(f.pool.query(sql), { code: "42501" });
    for (const sql of ["UPDATE whiteboard_actions SET version=version", "DELETE FROM whiteboard_actions", "TRUNCATE whiteboard_actions"]) await assert.rejects(f.ownerQuery(sql), /append-only/u);
    await assert.rejects(f.ownerQuery("DELETE FROM whiteboard_entries"), /soft-withdrawn/u);
    const entriesBefore = await count("whiteboard_entries"), actionsBefore = await count("whiteboard_actions");
    await f.pool.query("DELETE FROM app_users WHERE id=$1", [f.users.admin.userId]);
    assert.equal(await count("whiteboard_entries"), entriesBefore); assert.equal(await count("whiteboard_actions"), actionsBefore);
  });
});

test("whiteboard real createAuthServer routing: anonymous privacy, admin MFA/owner binding, conflicts and safe failures", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const elevated = { user: "admin", elevated: true };
  await t.test("public GET bypasses all identity readers and admin routes preserve their existing dispatch", async () => {
    for (const name of ["getActiveSession", "getWhiteboardSession", "getAdminAccessState"]) {
      const real = f.store[name]; f.store[name] = () => { throw new Error("public path must not read identity"); };
      try {
        const response = await f.call(publicPath, { headers: { Cookie: "garbage=private", Origin: "https://another.test" } });
        assert.equal(response.status, 200); assert.deepEqual(response.body, { items: [], nextCursor: null });
        assert.match(response.headers.get("cache-control"), /no-store/u); assert.equal(response.headers.has("set-cookie"), false);
      } finally { f.store[name] = real; }
    }
    assert.equal((await f.call(adminPath)).status, 401);
    assert.equal((await f.call(adminPath, { user: "user", elevated: true })).body.error, "admin_forbidden");
    assert.equal((await f.call(adminPath, { user: "admin" })).body.error, "admin_mfa_required");
    const result = await f.call(adminPath, elevated);
    assert.equal(result.status, 200); assert.equal(result.body.viewerId, f.users.admin.userId); assert.ok(result.body.elevatedUntil);
    assert.equal((await f.call("/api/admin/session", elevated)).status, 200);
    assert.equal((await f.call("/api/community/topics?limit=1")).status, 200);
    assert.equal((await f.call("/api/auth/data-feedback", { user: "user" })).status, 200);
    assert.equal((await f.call("/api/material-bookmarks", { user: "user" })).status, 200);
    assert.equal((await f.call(`${adminPath}-wrong`, elevated)).status, 404);
    assert.equal((await f.call(`${publicPath}/bad`)).status, 404);
  });
  await t.test("POST/PATCH require explicit owner, same origin, valid shape and expose the agreed frontend contract", async () => {
    const data = note({ status: "published" });
    for (const headers of [{ Origin: "https://foreign.test" }, { Origin: "" }, { "Sec-Fetch-Site": "cross-site" }]) {
      assert.equal((await f.call(adminPath, { ...elevated, method: "POST", body: data, headers })).status, 403);
    }
    for (const owner of ["", f.users.otherAdmin.userId]) {
      const response = await f.call(adminPath, { ...elevated, method: "POST", body: data, headers: { "X-Whiteboard-Owner": owner } });
      assert.equal(response.status, 409); assert.equal(response.body.error, "whiteboard_account_changed");
    }
    const created = await f.call(adminPath, { ...elevated, method: "POST", body: data });
    assert.equal(created.status, 201); assert.deepEqual(Object.keys(created.body).sort(), ["elevatedUntil", "entry"]);
    const id = created.body.entry.id;
    const retry = await f.call(adminPath, { ...elevated, method: "POST", body: data });
    assert.equal(retry.status, 200); assert.deepEqual(retry.body.entry, created.body.entry);
    const collision = await f.call(adminPath, { ...elevated, method: "POST", body: { ...data, body: "changed" } });
    assert.equal(collision.status, 409); assert.equal(collision.body.error, "whiteboard_mutation_conflict");
    const change = { status: "withdrawn", version: 1, mutationId: randomUUID() };
    const changed = await f.call(`${adminPath}/${id}`, { ...elevated, method: "PATCH", body: change });
    assert.equal(changed.status, 200); assert.equal(changed.body.entry.version, 2);
    assert.deepEqual((await f.call(`${adminPath}/${id}`, { ...elevated, method: "PATCH", body: change })).body.entry, changed.body.entry);
    const stale = await f.call(`${adminPath}/${id}`, { ...elevated, method: "PATCH", body: { ...change, mutationId: randomUUID() } });
    assert.equal(stale.status, 409); assert.equal(stale.body.error, "whiteboard_conflict");
    for (const bad of [note({ body: "x".repeat(4001) }), note({ actorUserId: randomUUID() }), note({ status: undefined })]) {
      const response = await f.call(adminPath, { ...elevated, method: "POST", body: bad });
      assert.equal(response.status, 400); assert.equal(response.body.error, "invalid_whiteboard");
    }
    assert.equal((await f.call(`${publicPath}?scope=draft`)).status, 400);
    assert.equal((await f.call(`${adminPath}?limit=51`, elevated)).status, 400);
    assert.equal((await f.call(publicPath, { method: "POST", body: data })).status, 405);
    assert.equal((await f.call(`${adminPath}/${id}`, { ...elevated, method: "DELETE" })).status, 405);
    assert.equal((await f.call(`${adminPath}/${randomUUID()}`, { ...elevated, method: "PATCH", body: change })).status, 409, "same mutationId cannot be replayed against a different target");
    assert.equal((await f.call(`${adminPath}/${randomUUID()}`, { ...elevated, method: "PATCH", body: { ...change, mutationId: randomUUID() } })).status, 404);
    const leaked = JSON.stringify((await f.call(publicPath)).body);
    assert.equal(leaked.includes(id), false, "withdrawn entry disappears on the next anonymous read");
  });
  await t.test("revoked between HTTP auth and store transaction fails closed; rate/store failures never claim success", async () => {
    const original = f.store.mutateWhiteboard;
    f.store.mutateWhiteboard = async input => {
      await f.ownerQuery("UPDATE admin_elevated_sessions SET revoked_at=now() WHERE base_session_id=$1", [f.users.admin.sessionId]);
      return original(input);
    };
    try {
      const response = await f.call(adminPath, { ...elevated, method: "POST", body: note() });
      assert.equal(response.status, 403); assert.equal(response.body.error, "admin_mfa_required");
    } finally { f.store.mutateWhiteboard = original; }
    await f.ownerQuery("UPDATE admin_elevated_sessions SET revoked_at=NULL WHERE base_session_id=$1", [f.users.admin.sessionId]);
    const consume = f.store.consumeRateLimit;
    f.store.consumeRateLimit = async () => { throw new Error("synthetic quota outage"); };
    try {
      const unavailable = await f.call(publicPath); assert.equal(unavailable.status, 503); assert.equal(unavailable.body.error, "service_unavailable");
    } finally { f.store.consumeRateLimit = consume; }
    const real = f.rates.read; f.rates.read = { consume: async () => false };
    try { assert.equal((await f.call(publicPath)).status, 429); }
    finally { f.rates.read = real; }
    const listing = f.store.listPublicWhiteboard; f.store.listPublicWhiteboard = async () => { throw new Error("PRIVATE_DATABASE_ERROR"); };
    try { const response = await f.call(publicPath); assert.equal(response.status, 503); assert.deepEqual(response.body, { error: "service_unavailable" }); }
    finally { f.store.listPublicWhiteboard = listing; }
  });
});

test("whiteboard limiter scopes are persistent and unrelated handlers are untouched", async () => {
  const calls = [];
  const store = { consumeRateLimit: async input => { calls.push(input); return true; } };
  const one = createWhiteboardRateLimiters(store), two = createWhiteboardRateLimiters(store);
  for (const limits of [one, two]) for (const limiter of Object.values(limits)) assert.equal(await limiter.consume("a".repeat(64)), true);
  assert.deepEqual(calls.slice(0, 3).map(call => call.scope), ["whiteboard-public-read", "whiteboard-admin-read", "whiteboard-admin-write"]);
  assert.deepEqual(calls.slice(0, 3), calls.slice(3));
  const handler = createWhiteboardRequestHandler({ store: {}, config, adminSecurity: {} });
  assert.equal(await handler({}, {}, new URL("https://whiteboard.test/api/community/topics")), false);
});
