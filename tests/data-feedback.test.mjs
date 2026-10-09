import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createAuthStore } from "../services/auth-api/src/db.mjs";
import { createDataFeedbackStore } from "../services/auth-api/src/data-feedback-store.mjs";
import { createDataFeedbackRequestHandler, createDataFeedbackRateLimiters } from "../services/auth-api/src/data-feedback-routes.mjs";
import { buildDataFeedbackContext, feedbackPageQuery, validateDataFeedback, validateFeedbackResolution } from "../services/auth-api/src/data-feedback-contract.mjs";
import { createOpaqueToken, tokenDigest } from "../services/auth-api/src/tokens.mjs";

const context = buildDataFeedbackContext({ type: "course", courseId: "21040022", meetingId: "fall-21040022-01-1" });
const draft = (message = "课程时间有误，请核对。") => ({ ...context, message, requestKey: randomUUID() });
const origin = "https://feedback.test";
const config = { tokenPepper: "synthetic-feedback-pepper-for-tests-only", sessionCookie: "__Host-session", adminCookie: "__Host-elevation", allowedOrigins: new Set([origin]), adminEnabled: true };

test("feedback contract only carries public identifiers and reconstructs an exact local path", async () => {
  assert.equal(buildDataFeedbackContext({ type: "course", courseId: "21040022", path: "//evil.test/?cookie=secret", password: "not read" }).path, "/?view=courses&course=21040022");
  assert.equal(buildDataFeedbackContext({ type: "room", room: "之远楼|1010" }).path, `/?${new URLSearchParams({ view: "rooms", room: "之远楼|1010" })}`);
  const good = draft();
  assert.deepEqual(validateDataFeedback(good), good);
  for (const patch of [
    { type: "account" }, { userId: randomUUID() }, { cookie: "secret" }, { schedule: [] }, { schoolAccount: "123" },
    { courseId: "personal-course" }, { meetingId: "spring-21040023-01-1" }, { materialId: "unknown" }, { room: "之远楼|1010" },
    { path: "//evil.test" }, { path: "/admin" }, { path: `${context.path}&returnTo=//evil.test` }, { path: `${context.path}&token=secret` },
    { path: `${context.path}#password` }, { path: "/%2f%2fevil.test" }, { message: " " }, { message: "x".repeat(501) }, { message: "ab\u0000" }, { requestKey: "bad" },
  ]) assert.equal(validateDataFeedback({ ...good, ...patch }), null, JSON.stringify(patch));
  assert.equal(validateFeedbackResolution({ status: "closed", version: 1, note: "已处理" }), null);
  assert.equal(validateFeedbackResolution({ status: "resolved", version: 1, note: "已处理", userId: "a" }), null);
  assert.equal(validateFeedbackResolution({ status: "resolved", version: -1, note: "已处理" }), null);
  assert.equal(feedbackPageQuery(new URLSearchParams("userId=someone")), null);
  assert.equal(feedbackPageQuery(new URLSearchParams("limit=1&limit=2")), null);
  assert.equal(feedbackPageQuery(new URLSearchParams("limit=51")), null);
  // Coverage against public local catalogues; never use production/private data.
  const catalog = JSON.parse(await readFile(new URL("../public/data/course-data.json", import.meta.url), "utf8"));
  for (const course of catalog.courses) assert.ok(buildDataFeedbackContext({ type: "course", courseId: course.id }), course.id);
  for (const meeting of catalog.schedules) assert.ok(buildDataFeedbackContext({ type: "course", courseId: meeting.courseId, meetingId: meeting.id }), meeting.id);
  for (const meeting of catalog.schedules.filter(item => catalog.buildings.includes(item.building) && item.room)) {
    const room = `${meeting.building}|${meeting.room}`;
    assert.ok(buildDataFeedbackContext({ type: "room", room }), room);
  }
  const materials = JSON.parse(await readFile(new URL("../public/data/resource-manifest.json", import.meta.url), "utf8"));
  for (const material of materials.materials) assert.ok(buildDataFeedbackContext({ type: "material", materialId: material.id }), material.id);
});

async function fixture() {
  const db = new PGlite();
  const migrationDir = new URL("../ops/postgres/migrations/", import.meta.url);
  for (const file of (await readdir(migrationDir)).filter(file => /\.sql$/u.test(file) && (file < "0025" || file === "0026_data_feedback.sql")).sort()) await db.exec(await readFile(new URL(file, migrationDir), "utf8"));
  await db.exec(await readFile(new URL("0026_data_feedback.sql", migrationDir), "utf8"));
  const query = async (sql, values) => { const r = await db.query(sql, values); return { ...r, rowCount: r.rows.length || r.affectedRows }; };
  // PGlite is a single connection; serialize transaction clients just like a pool lease.
  let tail = Promise.resolve();
  const pool = { query, async connect() { const before = tail; let release; tail = new Promise(resolve => { release = resolve; }); await before; return { query, release }; } };
  const authStore = createAuthStore(pool);
  const store = { ...authStore, ...createDataFeedbackStore(pool) };
  const users = {};
  for (const name of ["owner", "other", "admin"]) {
    const userId = randomUUID(); const sessionId = randomUUID(); const token = createOpaqueToken();
    await query("INSERT INTO app_users (id, role) VALUES ($1,$2)", [userId, name === "admin" ? "admin" : "user"]);
    await query("INSERT INTO user_sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,now() + interval '1 day')", [sessionId, userId, tokenDigest(token, config.tokenPepper)]);
    users[name] = { userId, sessionId, token, cookie: `${config.sessionCookie}=${token}` };
  }
  const elevation = createOpaqueToken();
  const elevationTokenHash = tokenDigest(elevation, config.tokenPepper);
  await query("INSERT INTO admin_elevated_sessions (user_id, base_session_id, token_hash, method, expires_at) VALUES ($1,$2,$3,'totp',now() + interval '10 minutes')", [users.admin.userId, users.admin.sessionId, elevationTokenHash]);
  users.admin.elevatedCookie = `${users.admin.cookie}; ${config.adminCookie}=${elevation}`;
  const adminInput = () => ({ ...users.admin, elevationTokenHash, requestId: randomUUID(), ipHash: "a".repeat(64), userAgentHash: "b".repeat(64) });
  return { db, query, pool, store, users, adminInput };
}

test("SQL store: owner isolation, idempotency, MFA recheck, version conflict, logs and atomic audit rollback", async () => {
  const f = await fixture();
  try {
    const data = draft();
    const narrowSession = await f.store.getDataFeedbackSession(tokenDigest(f.users.owner.token, config.tokenPepper));
    assert.deepEqual(Object.keys(narrowSession).sort(), ["id", "role", "userId"]);
    assert.equal(await f.store.getDataFeedbackSession(tokenDigest("expired or unknown", config.tokenPepper)), null);
    const created = await f.store.createDataFeedback({ ...f.users.owner, data });
    assert.equal(created.created, true); assert.equal(created.feedback.status, "open");
    assert.equal((await f.store.createDataFeedback({ ...f.users.owner, data })).created, false);
    await assert.rejects(f.store.createDataFeedback({ ...f.users.owner, data: { ...data, message: "另一个问题" } }), { code: "FEEDBACK_REQUEST_CONFLICT" });
    const feedbackId = created.feedback.id;
    assert.equal(await f.store.getOwnDataFeedback({ ...f.users.other, feedbackId }), null);
    assert.deepEqual((await f.store.listOwnDataFeedback({ ...f.users.other, limit: 20, cursor: null })).items, []);
    await assert.rejects(f.store.listOwnDataFeedback({ ...f.users.other, limit: 20, cursor: feedbackId }), { code: "FEEDBACK_INVALID_CURSOR" });
    const other = await f.store.createDataFeedback({ ...f.users.other, data });
    assert.notEqual(other.feedback.id, feedbackId);
    await assert.rejects(f.store.getAdminDataFeedback({ ...f.adminInput(), elevationTokenHash: "wrong", feedbackId }), { code: "AUTH_ADMIN_FORBIDDEN" });
    await assert.rejects(f.store.getAdminDataFeedback({ ...f.adminInput(), sessionId: f.users.other.sessionId, feedbackId }), { code: "AUTH_ADMIN_FORBIDDEN" });
    assert.equal((await f.store.getAdminDataFeedback({ ...f.adminInput(), feedbackId })).actions.length, 0);
    const page = await f.store.listAdminDataFeedback({ ...f.adminInput(), status: "open", cursor: null, limit: 1 });
    assert.equal(page.items.length, 1); assert.ok(page.nextCursor);
    const next = await f.store.listAdminDataFeedback({ ...f.adminInput(), status: "open", cursor: page.nextCursor, limit: 1 });
    assert.equal(next.items.length, 1); assert.notEqual(page.items[0].id, next.items[0].id);
    const change = { status: "resolved", version: 1, note: "已核对并更正公开信息。" };
    const brokenStore = createDataFeedbackStore({ connect: async () => {
      const client = await f.pool.connect();
      return { ...client, query: (sql, args) => /INSERT INTO admin_audit_events/u.test(sql) ? Promise.reject(new Error("injected audit failure")) : client.query(sql, args) };
    } });
    await assert.rejects(brokenStore.resolveDataFeedback({ ...f.adminInput(), feedbackId, change }), /injected audit failure/u);
    assert.equal((await f.query("SELECT status FROM data_feedback WHERE id=$1", [feedbackId])).rows[0].status, "open");
    assert.equal((await f.query("SELECT count(*)::int AS n FROM data_feedback_actions")).rows[0].n, 0);
    const resolved = await f.store.resolveDataFeedback({ ...f.adminInput(), feedbackId, change });
    assert.equal(resolved.status, "resolved"); assert.equal(resolved.version, 2);
    await assert.rejects(f.store.resolveDataFeedback({ ...f.adminInput(), feedbackId, change }), { code: "FEEDBACK_VERSION_CONFLICT" });
    const detail = await f.store.getAdminDataFeedback({ ...f.adminInput(), feedbackId });
    assert.equal(detail.actions[0].note, change.note); assert.equal(detail.actions[0].fromStatus, "open");
    assert.equal(Object.hasOwn(await f.store.getOwnDataFeedback({ ...f.users.owner, feedbackId }), "actions"), false);
    const reopened = await f.store.resolveDataFeedback({ ...f.adminInput(), feedbackId, change: { status: "open", version: 2, note: "需要再次复核。" } });
    assert.equal(reopened.version, 3);
    const audits = (await f.query("SELECT action,metadata FROM admin_audit_events")).rows;
    assert.ok(audits.some(x => x.action === "admin.data_feedback.status_changed"));
    assert.equal(JSON.stringify(audits).includes(change.note), false); assert.equal(JSON.stringify(audits).includes(data.message), false);
    for (const sql of [
      "UPDATE app_users SET role='user' WHERE id=$1", "UPDATE app_users SET status='disabled' WHERE id=$1",
    ]) {
      await f.query(sql, [f.users.admin.userId]);
      await assert.rejects(f.store.listAdminDataFeedback({ ...f.adminInput(), status: "open", limit: 20, cursor: null }), { code: "AUTH_ADMIN_FORBIDDEN" });
      await f.query("UPDATE app_users SET role='admin',status='active' WHERE id=$1", [f.users.admin.userId]);
    }
    await f.query("UPDATE admin_elevated_sessions SET expires_at=now()-interval '1 second'");
    await assert.rejects(f.store.resolveDataFeedback({ ...f.adminInput(), feedbackId, change: { status: "resolved", version: 3, note: "过期不得处理" } }), { code: "AUTH_ADMIN_FORBIDDEN" });
    await f.query("UPDATE user_sessions SET revoked_at=now() WHERE id=$1", [f.users.owner.sessionId]);
    await assert.rejects(f.store.createDataFeedback({ ...f.users.owner, data: draft() }), { code: "AUTH_SESSION_REQUIRED" });
    await f.query("DELETE FROM app_users WHERE id=$1", [f.users.owner.userId]);
    assert.equal((await f.query("SELECT count(*)::int AS n FROM data_feedback_actions")).rows[0].n, 0);
    assert.equal((await f.query("SELECT count(*)::int AS n FROM data_feedback WHERE id=$1", [feedbackId])).rows[0].n, 0);
  } finally { await f.db.close(); }
});

test("HTTP handler: exact routing, same-origin session, owner-only receipts, MFA, validation and safe failures", async () => {
  const f = await fixture();
  const permissive = { consume: async () => true };
  const rates = { submit: permissive, ip: permissive, admin: permissive, read: permissive };
  let store = { ...f.store, getActiveSession: () => { throw new Error("generic session reader must not read registration fields"); } };
  const handler = createDataFeedbackRequestHandler({ store: new Proxy({}, { get: (_, key) => store[key] }), config, adminSecurity: {}, rateLimiters: rates });
  const server = createServer(async (req, res) => { if (!(await handler(req, res, new URL(req.url, origin)))) { res.statusCode = 404; res.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { cookie = f.users.owner.cookie, method = "GET", data, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, "Content-Type": "application/json", ...headers }, ...(data === undefined ? {} : { body: typeof data === "string" ? data : JSON.stringify(data) }) });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  const own = "/api/auth/data-feedback", admin = "/api/admin/data-feedback";
  try {
    assert.equal((await call(`${own}x`)).status, 404);
    assert.equal((await call(own, { cookie: "" })).status, 401);
    assert.equal((await call(own, { cookie: `${config.sessionCookie}=invalid` })).status, 401);
    assert.deepEqual((await call(`${own}/session`)).body, { authenticated: true });
    for (const headers of [{ Origin: "https://evil.test" }, { Origin: "" }, { "Sec-Fetch-Site": "cross-site" }]) assert.equal((await call(own, { method: "POST", data: draft(), headers })).status, 403);
    assert.equal((await call(own, { method: "POST", data: "{broken" })).status, 400);
    assert.equal((await call(own, { method: "POST", data: "x".repeat(9000) })).status, 400);
    assert.equal((await call(own, { method: "POST", data: draft(), headers: { "Content-Type": "text/plain" } })).status, 400);
    assert.equal((await call(`${own}?userId=${f.users.other.userId}`)).status, 400);
    assert.equal((await call(`${own}?limit=1&limit=2`)).status, 400);
    assert.equal((await call(own, { method: "PUT", data: draft() })).status, 405);
    const data = draft();
    const created = await call(own, { method: "POST", data });
    assert.equal(created.status, 201); assert.match(created.headers.get("cache-control"), /no-store/u);
    const id = created.body.feedback.id;
    assert.equal((await call(own, { method: "POST", data })).status, 200);
    assert.equal((await call(`${own}/${id}`, { cookie: f.users.other.cookie })).status, 404);
    assert.equal((await call(`${own}/${id}`, { method: "PATCH", data: { status: "resolved", note: "不能处理", version: 1 } })).status, 405);
    for (const [cookie, expected] of [["", 401], [f.users.owner.cookie, 403], [f.users.admin.cookie, 403]]) assert.equal((await call(admin, { cookie })).status, expected);
    const adminCookie = f.users.admin.elevatedCookie;
    assert.equal((await call(admin, { cookie: adminCookie })).body.items.length, 1);
    const update = await call(`${admin}/${id}`, { cookie: adminCookie, method: "PATCH", data: { status: "resolved", version: 1, note: "核对完成" } });
    assert.equal(update.status, 200);
    assert.equal((await call(`${own}/${id}`)).body.feedback.status, "resolved");
    assert.equal((await call(`${admin}/${id}`, { cookie: adminCookie })).body.feedback.actions.length, 1);
    await f.query("UPDATE user_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [f.users.other.sessionId]);
    assert.equal((await call(own, { cookie: f.users.other.cookie })).status, 401);
    rates.submit = { consume: async () => false };
    assert.equal((await call(own, { method: "POST", data: draft() })).status, 429);
    rates.submit = permissive; rates.ip = { consume: async () => false };
    assert.equal((await call(own, { method: "POST", data: draft() })).status, 429);
    rates.ip = permissive;
    store = { ...f.store, createDataFeedback: async () => { throw new Error("secret database detail"); } };
    const failed = await call(own, { method: "POST", data: draft() });
    assert.equal(failed.status, 503); assert.deepEqual(failed.body, { error: "service_unavailable" });
    store = { ...f.store, listAdminDataFeedback: async () => { throw Object.assign(new Error("revoked while in flight"), { code: "AUTH_ADMIN_FORBIDDEN" }); } };
    assert.equal((await call(admin, { cookie: adminCookie })).status, 403);
    rates.read = { consume: async () => { throw new Error("rate DB unavailable"); } };
    assert.equal((await call(own)).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); await f.db.close(); }
});

test("feedback quotas use persistent shared account/IP scopes and survive reinitialization", async () => {
  const f = await fixture();
  try {
    const a = createDataFeedbackRateLimiters(f.store), b = createDataFeedbackRateLimiters(f.store);
    const digest = tokenDigest("test quota owner", config.tokenPepper);
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).submit.consume(digest)));
    assert.equal(attempts.filter(Boolean).length, 5);
    assert.equal(await createDataFeedbackRateLimiters(f.store).submit.consume(digest), false);
    assert.equal(await a.ip.consume(digest), true);
    assert.equal(await a.admin.consume(digest), true);
    await assert.rejects(a.submit.consume("raw IP address"), /SHA-256/u);
  } finally { await f.db.close(); }
});
