import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createAdminUserDetailsStore } from "../services/auth-api/src/admin-user-details.mjs";

test("registration details require a current administrator session and commit an audit without personal data", async () => {
  const db = new PGlite();
  const admin = "00000000-0000-4000-8000-000000000001";
  const user = "00000000-0000-4000-8000-000000000002";
  const session = "00000000-0000-4000-8000-000000000003";
  try {
    for (const name of (await fs.readdir("ops/postgres/migrations")).filter(x => x.endsWith(".sql")).sort()) {
      await db.exec(await fs.readFile(`ops/postgres/migrations/${name}`, "utf8"));
    }
    await db.query(`INSERT INTO app_users (id, role, username, email, school_account, display_name)
      VALUES ($1, 'admin', 'admin-test', 'admin@example.test', null, '管理员'),
             ($2, 'user', 'student-test', 'full-address@example.test', '20260001', '学生昵称')`, [admin, user]);
    await db.query(`INSERT INTO user_profiles (user_id, entrance_year, college, major_id, class_name, revision, client_updated_at)
      VALUES ($1, 2026, '学院', '专业', '一班', 1, now())`, [user]);
    await db.query(`INSERT INTO user_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, 'test-session', now() + interval '1 day')`, [session, admin]);
    await db.query(`INSERT INTO admin_elevated_sessions (user_id, base_session_id, token_hash, method, expires_at)
      VALUES ($1, $2, 'test-elevation', 'totp', now() + interval '10 minutes')`, [admin, session]);
    const query = async (sql, args) => { const result = await db.query(sql, args); return { ...result, rowCount: result.rows.length || result.affectedRows }; };
    const pool = { connect: async () => ({ query, release() {} }) };
    const store = createAdminUserDetailsStore(pool);
    const input = { actorUserId: admin, actorSessionId: session, actorElevationTokenHash: "test-elevation",
      targetUserId: user, requestId: "00000000-0000-4000-8000-000000000004", ipHash: "a".repeat(64), userAgentHash: "b".repeat(64) };
    const result = await store.getAdminUserRegistration(input);
    assert.equal(result.email, "full-address@example.test");
    assert.equal(result.schoolAccount, "20260001");
    assert.equal(result.profile.className, "一班");
    assert.equal(result.emailVerified, false);
    assert.deepEqual(Object.keys(result).sort(), ["id", "username", "displayName", "email", "emailVerified", "schoolAccount", "schoolAccountVerified", "avatarUrl", "registeredVia", "createdAt", "lastLoginAt", "role", "status", "profile"].sort());
    const audit = (await db.query(`SELECT action, target_id, metadata FROM admin_audit_events`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "admin.user.registration_viewed");
    assert.equal(audit[0].target_id, user);
    assert.deepEqual(audit[0].metadata, {});
    assert.equal((await store.getAdminUserRegistration({ ...input, targetUserId: admin, requestId: "00000000-0000-4000-8000-000000000005" })).profile, null);
    assert.equal(await store.getAdminUserRegistration({ ...input, targetUserId: "00000000-0000-4000-8000-000000000099" }), null);
    await assert.rejects(store.getAdminUserRegistration({ ...input, actorElevationTokenHash: "wrong" }), { code: "AUTH_ADMIN_FORBIDDEN" });
    await db.query(`UPDATE app_users SET role = 'user' WHERE id = $1`, [admin]);
    await assert.rejects(store.getAdminUserRegistration(input), { code: "AUTH_ADMIN_FORBIDDEN" });
    await db.query(`UPDATE app_users SET role = 'admin' WHERE id = $1`, [admin]);
    await db.query(`UPDATE user_sessions SET revoked_at = now() WHERE id = $1`, [session]);
    await assert.rejects(store.getAdminUserRegistration(input), { code: "AUTH_ADMIN_FORBIDDEN" });
    await db.query(`UPDATE user_sessions SET revoked_at = null WHERE id = $1`, [session]);
    await db.query(`UPDATE admin_elevated_sessions SET expires_at = now() - interval '1 second'`);
    await assert.rejects(store.getAdminUserRegistration(input), { code: "AUTH_ADMIN_FORBIDDEN" });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM admin_audit_events`)).rows[0].n, 2);
    await db.query(`UPDATE admin_elevated_sessions SET expires_at = now() + interval '1 minute'`);
    const failingStore = createAdminUserDetailsStore({ connect: async () => ({
      query: (sql, args) => /INSERT INTO admin_audit_events/.test(sql) ? Promise.reject(new Error("audit unavailable")) : query(sql, args), release() {},
    }) });
    await assert.rejects(failingStore.getAdminUserRegistration(input), /audit unavailable/);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM admin_audit_events`)).rows[0].n, 2);
  } finally { await db.close(); }
});
