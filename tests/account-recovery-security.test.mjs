import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { createAuthStore } from "../services/auth-api/src/db.mjs";

const native = process.env.POSTGRES_INTEGRATION === "true";
const digest = () => createHash("sha256").update(randomUUID()).digest("hex");
const expiresAt = () => new Date(Date.now() + 1_800_000);
const credential = "synthetic-original-credential-hash";

async function databasePool({ legacy = false } = {}) {
  if (native && !legacy) {
    if (process.env.PGHOST !== "127.0.0.1" || !/^dufesh_[a-z_]*(?:ci|test)$/u.test(process.env.POSTGRES_DB ?? "") ||
        !process.env.AUTH_DB_USER || !process.env.AUTH_DB_PASSWORD) {
      throw new Error("Recovery tests require an isolated loopback test database and runtime role");
    }
    const pool = new pg.Pool({ host: "127.0.0.1", port: Number(process.env.PGPORT),
      database: process.env.POSTGRES_DB, user: process.env.AUTH_DB_USER,
      password: process.env.AUTH_DB_PASSWORD, max: 10, query_timeout: 10_000 });
    await pool.query("SELECT credential_version, delivery_status FROM password_reset_tokens LIMIT 0");
    return pool;
  }
  const db = new PGlite(); await db.waitReady;
  for (const name of (await fs.readdir("ops/postgres/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    if (legacy && name.startsWith("0029_")) continue;
    await db.exec(await fs.readFile(`ops/postgres/migrations/${name}`, "utf8"));
  }
  let tail = Promise.resolve();
  async function lock() {
    const previous = tail; let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous; return release;
  }
  async function query(sql, values) {
    const result = await db.query(sql, values);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  }
  return {
    async connect() { const release = await lock(); return { query, release }; },
    async query(sql, values) { const release = await lock(); try { return await query(sql, values); } finally { release(); } },
    applyRecoveryMigration: async () => db.exec(await fs.readFile("ops/postgres/migrations/0029_account_recovery_security.sql", "utf8")),
    end: () => db.close(),
  };
}

test("account recovery uses verified email, SQL credential snapshots and active initiating sessions", { timeout: 60_000 }, async (t) => {
  const pool = await databasePool(); const store = createAuthStore(pool); const userIds = [];
  async function user(verified = false) {
    const id = randomUUID(); const email = `recovery-${id}@example.com`; const username = `recover-${id.slice(0, 12)}`;
    await pool.query(`INSERT INTO app_users(id, username, normalized_username, email, normalized_email, email_verified_at, registered_via)
      VALUES($1,$2,$2,$3,$3,CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,'password')`, [id, username, email, verified]);
    userIds.push(id);
    await pool.query(`INSERT INTO password_credentials(user_id,password_hash,password_changed_at)
      VALUES($1,$2,'2026-10-01T12:00:00.123456Z')`, [id, credential]);
    const sessions = [];
    for (let i = 0; i < 2; i += 1) {
      const session = await pool.query(`INSERT INTO user_sessions(user_id,token_hash,expires_at)
        VALUES($1,$2,clock_timestamp()+interval '1 hour') RETURNING id`, [id, digest()]);
      sessions.push(session.rows[0].id);
    }
    return { id, email, username, sessions };
  }
  async function reset(target, overrides = {}) {
    const input = { userId: target.id, tokenHash: digest(), expiresAt: expiresAt(),
      expectedPasswordHash: credential, normalizedEmail: target.email, ...overrides };
    return { input, created: await store.createPasswordReset(input) };
  }
  async function verification(target, overrides = {}) {
    const input = { userId: target.id, sessionId: target.sessions[0], tokenHash: digest(), expiresAt: expiresAt(),
      expectedPasswordHash: credential, normalizedEmail: target.email, ...overrides };
    return { input, created: await store.createEmailVerification(input) };
  }
  const confirmVerification = (target, tokenHash, sessionId = target.sessions[0]) =>
    store.consumeEmailVerification({ userId: target.id, sessionId, tokenHash });
  const consumeReset = (tokenHash) => store.consumePasswordReset({ tokenHash, passwordHash: "synthetic-new-credential-hash" });
  try {
    await t.test("legacy users retain login credentials and are not silently marked verified", async () => {
      const target = await user();
      const principal = await store.getCredentialPrincipal(target.email);
      assert.equal(principal.passwordHash, credential); assert.equal(principal.emailVerified, false);
      assert.equal((await reset(target)).created, false);
      const requested = await verification(target); assert.equal(requested.created, true);
      assert.equal((await store.getCredentialPrincipal(target.email)).emailVerified, false);
    });
    await t.test("creation rejects mismatched email, credential hash, inactive or unrelated sessions", async () => {
      const old = await user(); const verified = await user(true); const other = await user();
      for (const overrides of [{ expectedPasswordHash: "changed" }, { normalizedEmail: other.email }, { sessionId: other.sessions[0] }, { sessionId: undefined }]) {
        assert.equal((await verification(old, overrides)).created, false);
      }
      assert.equal((await reset(verified, { expectedPasswordHash: "changed" })).created, false);
      assert.equal((await reset(verified, { normalizedEmail: other.email })).created, false);
      await pool.query("UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [old.sessions[0]]);
      assert.equal((await verification(old)).created, false);
      await pool.query("UPDATE app_users SET status='disabled' WHERE id=$1", [verified.id]);
      assert.equal((await reset(verified)).created, false);
    });
    await t.test("SMTP pending or failed tokens cannot activate or reset; failure cannot become success", async () => {
      const old = await user(); const verified = await user(true);
      const v = await verification(old); const r = await reset(verified);
      assert.equal(await confirmVerification(old, v.input.tokenHash), false);
      assert.equal(await store.getPasswordResetPrincipal(r.input.tokenHash), null);
      assert.equal(await consumeReset(r.input.tokenHash), false);
      assert.equal(await store.finishEmailVerificationDelivery({ tokenHash: v.input.tokenHash, delivered: false }), true);
      assert.equal(await store.finishPasswordResetDelivery({ tokenHash: r.input.tokenHash, delivered: false }), true);
      assert.equal(await store.finishEmailVerificationDelivery({ tokenHash: v.input.tokenHash, delivered: true }), false);
      assert.equal(await store.finishPasswordResetDelivery({ tokenHash: r.input.tokenHash, delivered: true }), false);
      assert.equal(await confirmVerification(old, v.input.tokenHash), false);
      assert.equal(await consumeReset(r.input.tokenHash), false);
      assert.equal((await store.getCredentialPrincipal(old.email)).emailVerified, false);
      assert.equal((await store.getCredentialPrincipal(verified.email)).passwordHash, credential);
    });
    await t.test("verification binds the exact requesting session and is one-use", async () => {
      const target = await user(); const other = await user(); const v = await verification(target);
      assert.equal(await store.finishEmailVerificationDelivery({ tokenHash: v.input.tokenHash, delivered: true }), true);
      assert.equal(await confirmVerification(other, v.input.tokenHash), false);
      assert.equal(await confirmVerification(target, v.input.tokenHash, target.sessions[1]), false);
      assert.equal(await confirmVerification(target, v.input.tokenHash), true);
      assert.equal(await confirmVerification(target, v.input.tokenHash), false);
      assert.equal((await store.getCredentialPrincipal(target.email)).emailVerified, true);
    });
    await t.test("logout, session expiry, email changes and credential changes invalidate verification", async () => {
      for (const mutation of [
        "UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1",
        "UPDATE user_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
        "UPDATE app_users SET normalized_email='changed-'||normalized_email WHERE id=$1",
        "UPDATE password_credentials SET password_changed_at=password_changed_at+interval '1 microsecond' WHERE user_id=$1",
      ]) {
        const target = await user(); const v = await verification(target);
        assert.equal(await store.finishEmailVerificationDelivery({ tokenHash: v.input.tokenHash, delivered: true }), true);
        await pool.query(mutation, [target.id]);
        assert.equal(await confirmVerification(target, v.input.tokenHash), false);
      }
    });
    await t.test("superseding and expired tokens fail, including tokens created before the migration", async () => {
      const target = await user(); const old = await verification(target);
      assert.equal(await store.finishEmailVerificationDelivery({ tokenHash: old.input.tokenHash, delivered: true }), true);
      const next = await verification(target);
      assert.equal(await confirmVerification(target, old.input.tokenHash), false);
      await pool.query("UPDATE email_verification_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [next.input.tokenHash]);
      assert.equal(await store.finishEmailVerificationDelivery({ tokenHash: next.input.tokenHash, delivered: true }), false);
      assert.equal(await confirmVerification(target, next.input.tokenHash), false);
      const legacyHash = digest();
      await pool.query(`INSERT INTO email_verification_tokens(user_id,normalized_email,token_hash,expires_at,delivery_status)
        VALUES($1,$2,$3,clock_timestamp()+interval '1 hour','delivered')`, [target.id, target.email, legacyHash]);
      assert.equal(await confirmVerification(target, legacyHash), false);
      const verified = await user(true); const resetHash = digest();
      await pool.query(`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,delivery_status)
        VALUES($1,$2,clock_timestamp()+interval '1 hour','delivered')`, [verified.id, resetHash]);
      assert.equal(await store.getPasswordResetPrincipal(resetHash), null);
      assert.equal(await consumeReset(resetHash), false);
    });
    await t.test("reset validity is rechecked against current verified email and SQL microsecond version", async () => {
      for (const mutation of [
        "UPDATE app_users SET email_verified_at=NULL WHERE id=$1",
        "UPDATE app_users SET normalized_email='changed-'||normalized_email WHERE id=$1",
        "UPDATE password_credentials SET password_changed_at=password_changed_at+interval '1 microsecond' WHERE user_id=$1",
        "UPDATE app_users SET status='disabled' WHERE id=$1",
        "UPDATE password_reset_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
      ]) {
        const target = await user(true); const r = await reset(target); assert.equal(r.created, true);
        assert.equal(await store.finishPasswordResetDelivery({ tokenHash: r.input.tokenHash, delivered: true }), true);
        assert.deepEqual(await store.getPasswordResetPrincipal(r.input.tokenHash), { username: target.username, email: target.email });
        const snapshot = await pool.query(`SELECT (credential_version = '2026-10-01T12:00:00.123456Z'::timestamptz) AS exact
          FROM password_reset_tokens WHERE token_hash=$1`, [r.input.tokenHash]);
        assert.equal(snapshot.rows[0].exact, true);
        await pool.query(mutation, [target.id]);
        assert.equal(await store.getPasswordResetPrincipal(r.input.tokenHash), null);
        assert.equal(await consumeReset(r.input.tokenHash), false);
      }
    });
    await t.test("new reset issuance supersedes the old token", async () => {
      const target = await user(true); const old = await reset(target);
      await store.finishPasswordResetDelivery({ tokenHash: old.input.tokenHash, delivered: true });
      const next = await reset(target);
      await store.finishPasswordResetDelivery({ tokenHash: next.input.tokenHash, delivered: true });
      assert.equal(await consumeReset(old.input.tokenHash), false);
      assert.equal(await consumeReset(next.input.tokenHash), true);
    });
    await t.test("successful reset revokes only the owner sessions, admin elevation and all recovery tokens", async () => {
      const target = await user(true); const other = await user(true); const r = await reset(target);
      await store.finishPasswordResetDelivery({ tokenHash: r.input.tokenHash, delivered: true });
      await pool.query(`INSERT INTO admin_elevated_sessions(user_id,base_session_id,token_hash,method,expires_at)
        VALUES($1,$2,$3,'totp',clock_timestamp()+interval '1 hour')`, [target.id, target.sessions[0], digest()]);
      await pool.query(`INSERT INTO email_verification_tokens(user_id,normalized_email,token_hash,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [target.id, target.email, digest()]);
      assert.equal(await consumeReset(r.input.tokenHash), true); assert.equal(await consumeReset(r.input.tokenHash), false);
      const sessions = await pool.query("SELECT user_id,revoked_at FROM user_sessions WHERE user_id=ANY($1::uuid[])", [[target.id, other.id]]);
      assert.equal(sessions.rows.filter((row) => row.user_id === target.id).every((row) => row.revoked_at), true);
      assert.equal(sessions.rows.filter((row) => row.user_id === other.id).every((row) => row.revoked_at === null), true);
      const elevation = await pool.query("SELECT revoked_at FROM admin_elevated_sessions WHERE user_id=$1", [target.id]);
      assert.ok(elevation.rows[0].revoked_at);
      const pending = await pool.query(`SELECT count(*)::int AS count FROM (
        SELECT id FROM password_reset_tokens WHERE user_id=$1 AND consumed_at IS NULL
        UNION ALL SELECT id FROM email_verification_tokens WHERE user_id=$1 AND consumed_at IS NULL) AS tokens`, [target.id]);
      assert.equal(pending.rows[0].count, 0);
      assert.equal((await store.getCredentialPrincipal(target.email)).passwordHash, "synthetic-new-credential-hash");
      assert.equal((await store.getCredentialPrincipal(other.email)).passwordHash, credential);
    });
    await t.test("storage failure rolls back password, token consumption and session revocation", async () => {
      const target = await user(true); const r = await reset(target);
      await store.finishPasswordResetDelivery({ tokenHash: r.input.tokenHash, delivered: true });
      const broken = createAuthStore({ query: pool.query.bind(pool), async connect() {
        const client = await pool.connect(); return { release: () => client.release(), async query(sql, values) {
          if (/UPDATE password_credentials/u.test(sql)) throw new Error("synthetic-storage-failure");
          return client.query(sql, values);
        } };
      } });
      await assert.rejects(broken.consumePasswordReset({ tokenHash: r.input.tokenHash, passwordHash: "unused-new-hash" }), /synthetic-storage-failure/u);
      assert.equal((await store.getCredentialPrincipal(target.email)).passwordHash, credential);
      assert.ok(await store.getPasswordResetPrincipal(r.input.tokenHash));
      const sessions = await pool.query("SELECT revoked_at FROM user_sessions WHERE user_id=$1", [target.id]);
      assert.equal(sessions.rows.every((row) => row.revoked_at === null), true);
    });
    await t.test("cleanup removes stale tokens and preserves pending live tokens and user data", async () => {
      const target = await user(true); const r = await reset(target);
      await store.cleanupRecoveryState();
      const tokens = await pool.query("SELECT delivery_status FROM password_reset_tokens WHERE token_hash=$1", [r.input.tokenHash]);
      assert.equal(tokens.rows[0].delivery_status, "pending");
      assert.equal((await store.getCredentialPrincipal(target.email)).passwordHash, credential);
    });
    await t.test("native connections race on the same token with exactly one reset and one verification", { skip: !native }, async () => {
      const target = await user(true); const r = await reset(target);
      await store.finishPasswordResetDelivery({ tokenHash: r.input.tokenHash, delivered: true });
      const resets = await Promise.all([consumeReset(r.input.tokenHash), consumeReset(r.input.tokenHash)]);
      assert.equal(resets.filter(Boolean).length, 1);
      const old = await user(); const v = await verification(old);
      await store.finishEmailVerificationDelivery({ tokenHash: v.input.tokenHash, delivered: true });
      const verifications = await Promise.all([confirmVerification(old, v.input.tokenHash), confirmVerification(old, v.input.tokenHash)]);
      assert.equal(verifications.filter(Boolean).length, 1);
    });
    await t.test("native concurrent requests leave only one usable reset and verification token", { skip: !native }, async () => {
      const target = await user(true);
      const requests = await Promise.all([reset(target), reset(target)]);
      assert.equal(requests.every((request) => request.created), true);
      const deliveries = await Promise.all(requests.map((request) => store.finishPasswordResetDelivery({ tokenHash: request.input.tokenHash, delivered: true })));
      assert.equal(deliveries.filter(Boolean).length, 1);
      const usable = await Promise.all(requests.map((request) => store.getPasswordResetPrincipal(request.input.tokenHash)));
      assert.equal(usable.filter(Boolean).length, 1);
      const old = await user(); const verifications = await Promise.all([verification(old), verification(old)]);
      const sent = await Promise.all(verifications.map((request) => store.finishEmailVerificationDelivery({ tokenHash: request.input.tokenHash, delivered: true })));
      assert.equal(sent.filter(Boolean).length, 1);
      const consumed = await Promise.all(verifications.map((request) => confirmVerification(old, request.input.tokenHash)));
      assert.equal(consumed.filter(Boolean).length, 1);
    });
  } finally {
    if (native && userIds.length) await pool.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [userIds]);
    await pool.end();
  }
});

test("0029 upgrade preserves legacy accounts and sessions while old unbound recovery tokens fail closed", { timeout: 60_000 }, async () => {
  const pool = await databasePool({ legacy: true }); const store = createAuthStore(pool);
  const userId = randomUUID(); const sessionId = randomUUID(); const email = `upgrade-${userId}@example.com`;
  const resetHash = digest(); const verificationHash = digest();
  try {
    await pool.query(`INSERT INTO app_users(id,username,normalized_username,email,normalized_email,registered_via)
      VALUES($1,'legacy-upgrade','legacy-upgrade',$2,$2,'password')`, [userId, email]);
    await pool.query("INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)", [userId, credential]);
    await pool.query(`INSERT INTO user_sessions(id,user_id,token_hash,expires_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [sessionId, userId, digest()]);
    await pool.query(`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at)
      VALUES($1,$2,clock_timestamp()+interval '1 hour')`, [userId, resetHash]);
    await pool.query(`INSERT INTO email_verification_tokens(user_id,normalized_email,token_hash,expires_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [userId, email, verificationHash]);
    await pool.applyRecoveryMigration();
    const principal = await store.getCredentialPrincipal(email);
    assert.equal(principal.emailVerified, false); assert.equal(principal.passwordHash, credential);
    const session = await pool.query("SELECT revoked_at FROM user_sessions WHERE id=$1", [sessionId]);
    assert.equal(session.rows[0].revoked_at, null);
    assert.equal(await store.getPasswordResetPrincipal(resetHash), null);
    assert.equal(await store.consumePasswordReset({ tokenHash: resetHash, passwordHash: "unused-hash" }), false);
    assert.equal(await store.consumeEmailVerification({ userId, sessionId, tokenHash: verificationHash }), false);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM app_users")).rows[0].count, 1);
  } finally { await pool.end(); }
});
