import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { createAuthStore } from "../services/auth-api/src/db.mjs";
import { createAuthServer } from "../services/auth-api/src/server.mjs";
import { createPasswordService } from "../services/auth-api/src/passwords.mjs";
import { createOpaqueToken, tokenDigest } from "../services/auth-api/src/tokens.mjs";
import { miniWechatChallengeDigest, miniWechatOpenidDigest } from "../services/auth-api/src/miniprogram-wechat-routes.mjs";
import { miniSessionDigest } from "../services/auth-api/src/miniprogram-routes.mjs";
import { parseTrustedProxies } from "../services/auth-api/src/request-security.mjs";

async function databasePool() {
  if (process.env.POSTGRES_INTEGRATION === "true") {
    if (process.env.PGHOST !== "127.0.0.1" || !/^dufesh_[a-z_]*(?:ci|test)$/u.test(process.env.POSTGRES_DB ?? "") ||
        !process.env.AUTH_DB_USER || !process.env.AUTH_DB_PASSWORD) throw new Error("Requires isolated loopback test database");
    return new pg.Pool({ host: "127.0.0.1", port: Number(process.env.PGPORT), database: process.env.POSTGRES_DB,
      user: process.env.AUTH_DB_USER, password: process.env.AUTH_DB_PASSWORD, max: 6 });
  }
  const db = new PGlite();
  await db.waitReady;
  for (const name of (await fs.readdir("ops/postgres/migrations")).filter(n => n.endsWith(".sql")).sort()) {
    await db.exec(await fs.readFile("ops/postgres/migrations/" + name, "utf8"));
  }
  let tail = Promise.resolve();
  async function lock() { const previous = tail; let release; tail = new Promise(r => { release = r; }); await previous; return release; }
  async function query(sql, params) { const result = await db.query(sql, params); return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }; }
  return { async connect() { const release = await lock(); return { query, release }; },
    async query(sql, params) { const release = await lock(); try { return await query(sql, params); } finally { release(); } }, end: () => db.close() };
}

test("native WeChat binding uses existing UUIDs and one-use challenges in an isolated database", { timeout: 120000 }, async t => {
  const pool = await databasePool(), store = createAuthStore(pool), passwordService = createPasswordService();
  const pepper = "synthetic-mini-wechat-integration-pepper-32", appId = "wx0000000000000000";
  const password = "Synthetic-mini-Wechat-password-57!", passwordHash = await passwordService.hash(password);
  const changedHash = await passwordService.hash("Synthetic-changed-password-93!");
  const userIds = [], limiter = { consume: async () => budget }; let server, budget = true, providerCalls = 0, exchangeHook = null;
  const config = { miniProgramEnabled: true, credentialsEnabled: true, miniProgramWechatEnabled: true,
    miniProgramWechatAppId: appId, miniProgramWechatAppSecret: "S".repeat(32), registrationMode: "disabled",
    passwordResetMode: "disabled", emailVerificationMode: "disabled", tokenPepper: pepper, sessionMaxAgeSeconds: 2592000,
    sessionCookie: "__Host-dufesh_session", deviceCookie: "__Host-dufesh_device", allowedOrigins: new Set(["https://dufesh.cn"]),
    trustedProxyRanges: parseTrustedProxies("127.0.0.1/32") };
  try {
    async function seed() {
      const id = randomUUID(), username = "wxfixture_" + id.slice(0, 12).replaceAll("-", ""); userIds.push(id);
      await pool.query("INSERT INTO app_users(id,username,normalized_username,email,normalized_email,registered_via,name_mode) VALUES($1,$2,$2,$3,$3,'password','momo')",
        [id, username, `mini-wechat-${id}@example.com`]);
      await pool.query("INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)", [id, passwordHash]);
      return { id, username };
    }
    const a = await seed(), b = await seed(), c = await seed(), d = await seed();
    server = createAuthServer({ store, passwordService, config, miniProgramWechatProvider: { async exchangeCode(code) {
      providerCalls++;
      if (exchangeHook) await exchangeHook();
      if (code === "fixture_failure") throw new Error("sensitive-provider-response-and-session_key");
      return { openid: "synthetic_openid_" + code, unionid: "ignored-synthetic-union-id", session_key: "ignored-synthetic-key" };
    } }, rateLimiters: { read: limiter, write: limiter, credential: limiter, authNetwork: limiter, authAccount: limiter } });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = "http://127.0.0.1:" + server.address().port;
    async function request(path, options = {}) {
      const response = await fetch(base + path, options);
      return { status: response.status, headers: response.headers, body: await response.json() };
    }
    const post = (path, body, token, extraHeaders = {}) => request(path, { method: "POST", headers: {
      "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...extraHeaders }, body: JSON.stringify(body) });
    const login = async user => (await post("/api/auth/miniprogram/login", { identifier: user.username, password })).body;
    const wechat = (code, token) => post("/api/auth/miniprogram/wechat", { code }, token);
    const bind = (challenge, user, token, secret = password) => post("/api/auth/miniprogram/wechat/bind",
      { challengeToken: challenge, expectedOwner: user.id, password: secret }, token);
    const countUsers = async () => Number((await pool.query("SELECT COUNT(*) AS count FROM app_users WHERE id = ANY($1::uuid[])", [userIds])).rows[0].count);
    const authA = await login(a), authB = await login(b);
    let challengeA, freshA, anonymousChallenge;

    await t.test("capabilities fail closed without flags, credentials or migration readiness", async () => {
      config.miniProgramWechatEnabled = false;
      assert.deepEqual((await request("/api/auth/miniprogram/capabilities")).body,
        { passwordLogin: true, wechatLogin: false, wechatBinding: false });
      assert.equal((await wechat("fixture_a")).status, 503);
      config.miniProgramWechatEnabled = true;
      const originalReady = store.miniProgramWechatReady; store.miniProgramWechatReady = async () => false;
      assert.equal((await request("/api/auth/miniprogram/capabilities")).body.wechatBinding, false);
      assert.equal((await wechat("fixture_a")).status, 503); store.miniProgramWechatReady = originalReady;
      config.miniProgramWechatAppSecret = "";
      assert.equal((await request("/api/auth/miniprogram/capabilities")).body.wechatLogin, false);
      config.miniProgramWechatAppSecret = "S".repeat(32);
      assert.equal((await request("/api/auth/miniprogram/capabilities")).body.wechatLogin, true);
      assert.equal(providerCalls, 0);
    });

    await t.test("an unlinked WeChat identity gives a hashed challenge, never creates an account or session", async () => {
      const result = await wechat("fixture_a");
      assert.equal(result.status, 200); assert.equal(result.body.authenticated, false); assert.equal(result.body.needsBinding, true);
      assert.equal(result.body.binding.requiresAuthenticatedExchange, true); anonymousChallenge = result.body.binding.challengeToken;
      assert.equal(result.body.session, undefined); assert.equal(await countUsers(), 4);
      assert.equal(authA.user.displayName, "momo"); assert.equal(authB.user.displayName, "momo");
      assert.notEqual(authA.user.id, authB.user.id);
      const stored = await pool.query("SELECT token_hash, user_id, session_id FROM miniprogram_wechat_challenges WHERE token_hash=$1",
        [miniWechatChallengeDigest(anonymousChallenge, pepper)]);
      assert.equal(stored.rowCount, 1); assert.equal(stored.rows[0].user_id, null); assert.equal(stored.rows[0].session_id, null);
      assert.notEqual(stored.rows[0].token_hash, tokenDigest(anonymousChallenge, pepper));
      assert.equal((await bind(anonymousChallenge, a, authA.session.accessToken)).status, 409);
    });

    await t.test("authenticated binding requires exact expected owner, fresh password and immutable verified hash", async () => {
      const result = await wechat("fixture_a", authA.session.accessToken);
      assert.equal(result.body.binding.requiresAuthenticatedExchange, false); challengeA = result.body.binding.challengeToken;
      assert.equal((await bind(challengeA, b, authA.session.accessToken)).body.error, "account_changed");
      const incorrect = await bind(challengeA, a, authA.session.accessToken, "wrong-password");
      assert.equal(incorrect.status, 401); assert.equal(incorrect.body.error, "invalid_binding_credentials");
      const originalBind = store.bindMiniProgramWechatIdentity;
      store.bindMiniProgramWechatIdentity = async input => {
        await pool.query("UPDATE password_credentials SET password_hash=$2 WHERE user_id=$1", [a.id, changedHash]);
        return originalBind(input);
      };
      assert.equal((await bind(challengeA, a, authA.session.accessToken)).body.error, "invalid_binding_credentials");
      store.bindMiniProgramWechatIdentity = originalBind;
      await pool.query("UPDATE password_credentials SET password_hash=$2 WHERE user_id=$1", [a.id, passwordHash]);
      const success = await bind(challengeA, a, authA.session.accessToken);
      assert.equal(success.status, 200); assert.equal(success.body.user.id, a.id); assert.equal(success.body.linked, true);
      assert.equal(success.body.session.accessToken, undefined); assert.equal(success.headers.get("set-cookie"), null);
      assert.match(success.headers.get("cache-control"), /no-store/u);
      const row = await pool.query("SELECT user_id, openid_hash FROM miniprogram_wechat_identities WHERE app_id=$1 AND user_id=$2", [appId, a.id]);
      assert.equal(row.rows[0].openid_hash, miniWechatOpenidDigest(appId, "synthetic_openid_fixture_a", pepper));
      assert.equal(row.rows[0].user_id, a.id); assert.equal(await countUsers(), 4);
      assert.equal((await bind(challengeA, a, authA.session.accessToken)).body.error, "binding_challenge_expired");
    });

    await t.test("fresh session reports linked state, same-owner exchange reuses session and other-owner exchange cannot switch", async () => {
      const session = await request("/api/auth/miniprogram/session", { headers: { Authorization: "Bearer " + authA.session.accessToken } });
      assert.equal(session.body.wechatLinked, true);
      const own = await wechat("fixture_a", authA.session.accessToken);
      assert.equal(own.body.user.id, a.id); assert.equal(own.body.session.accessToken, undefined);
      const other = await wechat("fixture_a", authB.session.accessToken);
      assert.equal(other.status, 409); assert.equal(other.body.error, "wechat_account_conflict"); assert.equal(other.body.user, undefined);
      assert.equal((await request("/api/auth/miniprogram/session", { headers: { Authorization: "Bearer " + authB.session.accessToken } })).body.user.id, b.id);
    });

    await t.test("linked WeChat creates purpose-isolated session for existing UUID after logout and never uses website Cookie", async () => {
      const previous = await store.getPersonalState(a.id);
      assert.equal((await post("/api/auth/miniprogram/logout", {}, authA.session.accessToken)).status, 200);
      const logged = await wechat("fixture_a"); freshA = logged.body;
      assert.equal(logged.status, 200); assert.equal(logged.body.user.id, a.id); assert.equal(logged.body.session.accessToken.length, 43);
      assert.ok(Date.parse(logged.body.session.expiresAt) - Date.now() <= 86_400_000); assert.equal(logged.headers.get("set-cookie"), null);
      assert.equal((await request("/api/auth/sync", { headers: { Cookie: "__Host-dufesh_session=" + freshA.session.accessToken } })).status, 401);
      assert.deepEqual(await store.getPersonalState(a.id), previous); assert.equal(await countUsers(), 4);
    });

    await t.test("challenge stays tied to original live owner and session across another account, logout and expiry", async () => {
      const pending = await wechat("fixture_b", freshA.session.accessToken);
      const challenge = pending.body.binding.challengeToken;
      assert.equal((await bind(challenge, b, authB.session.accessToken)).body.error, "binding_challenge_expired");
      const reloggedA = await login(a);
      assert.equal((await bind(challenge, a, reloggedA.session.accessToken)).body.error, "binding_challenge_expired");
      await post("/api/auth/miniprogram/logout", {}, freshA.session.accessToken);
      assert.equal((await bind(challenge, a, freshA.session.accessToken)).body.error, "authentication_required");
      const expiration = await wechat("fixture_b", authB.session.accessToken);
      await pool.query("UPDATE miniprogram_wechat_challenges SET created_at=clock_timestamp()-interval '6 minutes', expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1",
        [miniWechatChallengeDigest(expiration.body.binding.challengeToken, pepper)]);
      assert.equal((await bind(expiration.body.binding.challengeToken, b, authB.session.accessToken)).body.error, "binding_challenge_expired");
    });

    await t.test("concurrent existing accounts cannot claim one WeChat identity twice or replace its owner", async () => {
      const authC = await login(c), authD = await login(d);
      const pendingC = await wechat("fixture_concurrent", authC.session.accessToken);
      const pendingD = await wechat("fixture_concurrent", authD.session.accessToken);
      const results = await Promise.all([
        bind(pendingC.body.binding.challengeToken, c, authC.session.accessToken),
        bind(pendingD.body.binding.challengeToken, d, authD.session.accessToken),
      ]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      const winner = results[0].status === 200 ? c : d, loser = winner === c ? d : c;
      const winnerAuth = winner === c ? authC : authD, loserAuth = winner === c ? authD : authC;
      const rows = await pool.query("SELECT user_id FROM miniprogram_wechat_identities WHERE app_id=$1 AND openid_hash=$2",
        [appId, miniWechatOpenidDigest(appId, "synthetic_openid_fixture_concurrent", pepper)]);
      assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].user_id, winner.id);
      assert.equal((await wechat("fixture_concurrent", loserAuth.session.accessToken)).body.error, "wechat_account_conflict");
      const different = await wechat("fixture_replacement", winnerAuth.session.accessToken);
      assert.equal((await bind(different.body.binding.challengeToken, winner, winnerAuth.session.accessToken)).body.error, "wechat_account_conflict");
      assert.equal(await countUsers(), 4); assert.equal(loser.id === rows.rows[0].user_id, false);
      await assert.rejects(pool.query("UPDATE miniprogram_wechat_identities SET user_id=$3 WHERE app_id=$1 AND openid_hash=$2",
        [appId, miniWechatOpenidDigest(appId, "synthetic_openid_fixture_concurrent", pepper), loser.id]));
    });

    await t.test("TLS, Origin, query, extra identity fields and quotas reject before exchange; upstream details never reach client", async () => {
      const calls = providerCalls;
      assert.equal((await post("/api/auth/miniprogram/wechat", { code: "fixture_x", openid: "spoof", unionid: "spoof" })).status, 400);
      assert.equal((await post("/api/auth/miniprogram/wechat", null)).status, 400);
      assert.equal((await post("/api/auth/miniprogram/wechat", { code: "fixture_x" }, undefined, { Origin: "https://dufesh.cn" })).status, 403);
      assert.equal((await post("/api/auth/miniprogram/wechat?owner=spoof", { code: "fixture_x" })).status, 400);
      config.requireHttps = true; assert.equal((await wechat("fixture_x")).status, 403); config.requireHttps = false;
      budget = false; assert.equal((await wechat("fixture_x")).status, 429); budget = true;
      assert.equal(providerCalls, calls);
      const failure = await wechat("fixture_failure");
      assert.deepEqual(failure.body, { error: "wechat_login_unavailable" }); assert.equal(failure.status, 503);
      const serialized = JSON.stringify(failure.body);
      assert.doesNotMatch(serialized, /session_key|openid|unionid|provider-response|secret/iu);
      const invalidToken = createOpaqueToken();
      assert.equal((await wechat("fixture_x", invalidToken)).body.error, "authentication_required");
    });

    await t.test("locked passwords and disabled accounts cannot bind/login, and logout races fail before binding", async () => {
      const pending = await wechat("fixture_locked", authB.session.accessToken);
      await pool.query("UPDATE password_credentials SET locked_until=clock_timestamp()+interval '1 minute' WHERE user_id=$1", [b.id]);
      assert.equal((await bind(pending.body.binding.challengeToken, b, authB.session.accessToken)).body.error, "invalid_binding_credentials");
      await pool.query("UPDATE password_credentials SET locked_until=NULL WHERE user_id=$1", [b.id]);
      await pool.query("UPDATE app_users SET status='disabled' WHERE id=$1", [a.id]);
      assert.equal((await wechat("fixture_a")).body.error, "authentication_required");
      await pool.query("UPDATE app_users SET status='active' WHERE id=$1", [a.id]);
      exchangeHook = () => store.revokeSession(miniSessionDigest(authB.session.accessToken, pepper));
      const lateExchange = await wechat("fixture_late_exchange", authB.session.accessToken);
      exchangeHook = null;
      assert.equal(lateExchange.body.error, "authentication_required"); assert.equal(lateExchange.body.binding, undefined);
      const nextB = await login(b), nextChallenge = await wechat("fixture_late_bind", nextB.session.accessToken);
      const originalBind = store.bindMiniProgramWechatIdentity;
      store.bindMiniProgramWechatIdentity = async input => {
        await store.revokeSession(miniSessionDigest(nextB.session.accessToken, pepper));
        return originalBind(input);
      };
      assert.equal((await bind(nextChallenge.body.binding.challengeToken, b, nextB.session.accessToken)).body.error, "authentication_required");
      store.bindMiniProgramWechatIdentity = originalBind;
      assert.equal(await store.hasMiniProgramWechatIdentity({ appId, userId: b.id }), false);
    });

    await t.test("simultaneous replay consumes one session challenge exactly once", async () => {
      const nextB = await login(b), pending = await wechat("fixture_once", nextB.session.accessToken);
      const results = await Promise.all(Array.from({ length: 2 }, () => bind(pending.body.binding.challengeToken, b, nextB.session.accessToken)));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      assert.equal((await wechat("fixture_once")).body.user.id, b.id);
      assert.equal(await countUsers(), 4);
    });
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    // Only the UUID fixtures created above are removed. No real user or production database is accessed.
    for (const id of userIds) await pool.query("DELETE FROM app_users WHERE id=$1", [id]);
    await pool.end();
  }
});
