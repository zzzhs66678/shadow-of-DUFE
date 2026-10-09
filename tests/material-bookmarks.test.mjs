import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createAuthStore } from "../services/auth-api/src/db.mjs";
import { createMaterialBookmarkStore, MAX_MATERIAL_BOOKMARKS } from "../services/auth-api/src/material-bookmarks-store.mjs";
import { createMaterialBookmarkRequestHandler } from "../services/auth-api/src/material-bookmarks-routes.mjs";
import { createOpaqueToken, tokenDigest } from "../services/auth-api/src/tokens.mjs";

const a = "00000000-0000-4000-8000-000000002501";
const b = "00000000-0000-4000-8000-000000002502";
const sessionA = "00000000-0000-4000-8000-000000002503";
const sessionB = "00000000-0000-4000-8000-000000002504";
const secondSessionA = "00000000-0000-4000-8000-000000002505";
const id1 = "11111111111111111111";
const id2 = "22222222222222222222";
const config = {
  tokenPepper: "synthetic-material-bookmarks-test-pepper-only",
  sessionCookie: "test_material_session",
  allowedOrigins: new Set(["https://materials.test"]),
};

test("material bookmarks: migrated SQL + real HTTP + existing auth/session/rate limit", { timeout: 60000 }, async (t) => {
  const db = new PGlite();
  await db.waitReady;
  t.after(() => db.close());
  const directory = new URL("../ops/postgres/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql") && Number(name.slice(0, 4)) <= 25).sort()) {
    await db.exec(await readFile(new URL(file, directory), "utf8"));
  }
  await db.query("INSERT INTO app_users (id, status) VALUES ($1, 'active'), ($2, 'active')", [a, b]);
  const tokenA = createOpaqueToken();
  const tokenB = createOpaqueToken();
  const tokenA2 = createOpaqueToken();
  for (const [id, user, token] of [[sessionA, a, tokenA], [sessionB, b, tokenB], [secondSessionA, a, tokenA2]]) {
    await db.query("INSERT INTO user_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')", [id, user, tokenDigest(token, config.tokenPepper)]);
  }
  // PGlite returns affectedRows; adapt to the pg result shape used by auth-api.
  const pool = { async query(sql, params) {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows || result.rows.length };
  } };
  const store = { ...createAuthStore(pool), ...createMaterialBookmarkStore(pool) };
  let handler = createMaterialBookmarkRequestHandler({ store, config });
  const server = createServer(async (request, response) => {
    if (!(await handler(request, response, new URL(request.url, "http://local.test")))) {
      response.writeHead(404); response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path = "", { method = "GET", token = tokenA, owner = a, origin = "https://materials.test", body = "{}", headers = {} } = {}) {
    const response = await fetch(`${base}/api/material-bookmarks${path}`, {
      method, headers: {
        ...(token ? { Cookie: `${config.sessionCookie}=${token}` } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(method !== "GET" ? { "Content-Type": "application/json", "X-Material-Bookmark-Owner": owner } : {}), ...headers,
      }, ...(method !== "GET" ? { body } : {}),
    });
    const data = await response.json();
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.equal(response.headers.get("vary"), "Cookie");
    return { status: response.status, data, headers: response.headers };
  }

  await t.test("anonymous, bad methods, invalid IDs/query/body and CSRF cannot write", async () => {
    assert.equal((await call("", { token: null })).status, 401);
    assert.equal((await call(`/${id1}`, { method: "PUT", token: null })).status, 401);
    assert.equal((await call(`/${id1}`, { method: "PUT", origin: "https://evil.test" })).status, 403);
    assert.equal((await call(`/${id1}`, { method: "PUT", origin: null })).status, 403);
    assert.equal((await call(`/${id1}`, { method: "POST" })).status, 405);
    assert.equal((await call(`/${id1}`, { method: "GET" })).headers.get("allow"), "PUT, DELETE");
    assert.equal((await call("/not-a-material", { method: "PUT" })).status, 404);
    assert.equal((await call("?userId=" + b)).status, 400);
    assert.equal((await call("?limit=1&limit=2")).status, 400);
    for (const body of ['{"userId":"forged"}', '{"url":"/private"}', '[]', 'null', '"x"', 'x'.repeat(300)]) {
      assert.equal((await call(`/${id1}`, { method: "PUT", body })).status, 400);
    }
    assert.equal((await call(`/${id1}`, { method: "PUT", headers: { "Content-Type": "text/plain" } })).status, 400);
    assert.deepEqual((await call()).data.items, []);
  });

  await t.test("ID-based idempotence, account isolation, second-device persistence and audit", async () => {
    assert.equal((await call(`/${id1}`, { method: "PUT" })).status, 200);
    assert.equal((await call(`/${id1}`, { method: "PUT" })).status, 200);
    assert.equal((await call(`/${id2}`, { method: "PUT" })).status, 200);
    assert.equal((await call("", { token: tokenB })).data.items.length, 0);
    handler = createMaterialBookmarkRequestHandler({ store: { ...createAuthStore(pool), ...createMaterialBookmarkStore(pool) }, config });
    const otherDevice = await call("", { token: tokenA2 });
    assert.equal(otherDevice.data.userId, a);
    assert.deepEqual(otherDevice.data.items.map((item) => item.materialId).sort(), [id1, id2]);
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM material_bookmark_events")).rows[0].count, 2);
    assert.doesNotMatch(JSON.stringify(otherDevice.data), /password|email|cookie|token|downloadUrl|previewUrl|name|title/iu);
  });

  await t.test("old-account tab cannot mutate new account; missing references are removable", async () => {
    assert.equal((await call(`/${id1}`, { method: "DELETE", token: tokenB, owner: a })).status, 409);
    assert.equal((await call(`/${id1}`, { method: "PUT", token: tokenB, owner: a })).status, 409);
    assert.equal((await call(`/${id1}`, { method: "DELETE", token: tokenB, owner: b })).status, 200);
    assert.equal((await call()).data.items.length, 2);
    assert.equal((await call(`/${id1}`, { method: "DELETE" })).status, 200);
    assert.equal((await call(`/${id1}`, { method: "DELETE" })).status, 200);
    assert.equal((await call()).data.items.length, 1);
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM material_bookmark_events")).rows[0].count, 3);
  });

  await t.test("session revoked between resolver and transaction fails closed", async () => {
    await db.query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1", [secondSessionA]);
    assert.equal((await call("", { token: tokenA2 })).status, 401);
    await assert.rejects(store.setMaterialBookmark({ userId: a, sessionId: secondSessionA, materialId: id1, active: true }), { code: "MATERIAL_BOOKMARK_SESSION_INVALID" });
    await assert.rejects(store.listMaterialBookmarks({ userId: b, sessionId: sessionA }), { code: "MATERIAL_BOOKMARK_SESSION_INVALID" });
    await db.query("UPDATE app_users SET status = 'disabled' WHERE id = $1", [b]);
    assert.equal((await call("", { token: tokenB })).status, 401);
    await db.query("UPDATE app_users SET status = 'active' WHERE id = $1", [b]);
    await db.query("UPDATE user_sessions SET expires_at = now() - interval '1 day' WHERE id = $1", [sessionB]);
    assert.equal((await call("", { token: tokenB })).status, 401);
    await db.query("UPDATE user_sessions SET expires_at = now() + interval '1 day' WHERE id = $1", [sessionB]);
  });

  await t.test("account cap, immutable audit, rollback and account deletion", async () => {
    await db.query("INSERT INTO material_bookmarks (user_id, material_id) SELECT $1, lpad(to_hex(n), 20, '0') FROM generate_series(1, $2) AS n", [b, MAX_MATERIAL_BOOKMARKS]);
    assert.equal((await store.listMaterialBookmarks({ userId: b, sessionId: sessionB })).length, 1000);
    await assert.rejects(store.setMaterialBookmark({ userId: b, sessionId: sessionB, materialId: id1, active: true }), { code: "MATERIAL_BOOKMARK_LIMIT" });
    assert.equal((await store.setMaterialBookmark({ userId: b, sessionId: sessionB, materialId: "00000000000000000001", active: true })).bookmarked, true);
    for (const sql of ["DELETE FROM material_bookmark_events", "UPDATE material_bookmark_events SET action='removed'", "TRUNCATE material_bookmark_events"]) await assert.rejects(db.query(sql), /append-only/);
    // A failed audit must roll back the bookmark mutation in the same transaction.
    const failingPool = { query: (sql, params) => sql.includes("INSERT INTO material_bookmark_events") ? Promise.reject(new Error("audit unavailable")) : db.query(sql, params) };
    await assert.rejects(createMaterialBookmarkStore(failingPool).setMaterialBookmark({ userId: a, sessionId: sessionA, materialId: id1, active: true }), /audit unavailable/);
    assert.equal((await call()).data.items.length, 1);
    await db.query("DELETE FROM app_users WHERE id = $1", [b]);
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM material_bookmarks WHERE user_id = $1", [b])).rows[0].count, 0);
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM material_bookmark_events")).rows[0].count, 3);
  });

  await t.test("shared limits survive handler replacement and database failures deny writes", async () => {
    const seen = [];
    const networkLimited = { ...store, consumeRateLimit: async (input) => { seen.push(input); return !input.scope.endsWith("network"); } };
    handler = createMaterialBookmarkRequestHandler({ store: networkLimited, config });
    assert.equal((await call(`/${id1}`, { method: "PUT", headers: { "X-Forwarded-For": "198.51.100.1, 192.0.2.2" } })).status, 429);
    assert.equal(seen[0].scope, "material-bookmarks-write-account");
    assert.equal(seen[1].scope, "material-bookmarks-write-network");
    assert.equal(seen[1].keyDigest, tokenDigest("material-bookmarks:ip:192.0.2.2", config.tokenPepper));
    assert.notEqual(seen[0].keyDigest, seen[1].keyDigest);
    seen.length = 0;
    const rateStore = { ...store, consumeRateLimit: async (input) => { seen.push(input); return false; } };
    handler = createMaterialBookmarkRequestHandler({ store: rateStore, config });
    assert.equal((await call(`/${id1}`, { method: "PUT" })).status, 429);
    assert.equal(seen[0].scope, "material-bookmarks-write-account");
    assert.match(seen[0].keyDigest, /^[0-9a-f]{64}$/);
    handler = createMaterialBookmarkRequestHandler({ store: { ...store, consumeRateLimit: async () => { throw new Error("database unavailable"); } }, config });
    assert.equal((await call(`/${id1}`, { method: "PUT" })).status, 503);
    assert.equal((await store.listMaterialBookmarks({ userId: a, sessionId: sessionA })).length, 1);
    // Exhaust the persistent account bucket; a newly constructed handler still denies.
    const keyDigest = tokenDigest(`material-bookmarks:user:${a}`, config.tokenPepper);
    for (let index = 0; index < 61; index++) await store.consumeRateLimit({ scope: "material-bookmarks-write-account", keyDigest, capacity: 60, refillPerSecond: 1 });
    handler = createMaterialBookmarkRequestHandler({ store, config });
    assert.equal((await call(`/${id1}`, { method: "PUT" })).status, 429);
  });
});
