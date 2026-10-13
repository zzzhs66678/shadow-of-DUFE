import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createAuthStore } from "../services/auth-api/src/db.mjs";
import { validateSyncWrite } from "../services/auth-api/src/sync-contract.mjs";

test("0033 preserves existing accounts, password sessions and complete personal data; binding database constraints hold", { timeout: 120000 }, async t => {
  const db = new PGlite(); await db.waitReady;
  try {
    const files = (await fs.readdir("ops/postgres/migrations")).filter(n => n.endsWith(".sql")).sort();
    for (const name of files.filter(n => n < "0033_")) await db.exec(await fs.readFile("ops/postgres/migrations/" + name, "utf8"));
    const pool = { async query(sql, params) { const result = await db.query(sql, params); return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }; },
      async connect() { return { query: pool.query, release() {} }; } };
    const store = createAuthStore(pool), owner = randomUUID(), other = randomUUID(), sessionId = randomUUID();
    await pool.query("INSERT INTO app_users(id,username,normalized_username,registered_via) VALUES($1,'schemafixture','schemafixture','password'),($2,'otherschema','otherschema','password')", [owner, other]);
    await pool.query("INSERT INTO password_credentials(user_id,password_hash) VALUES($1,'synthetic-password-hash')", [owner]);
    await pool.query("INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,'synthetic-old-session-hash',clock_timestamp()+interval '1 day')", [sessionId, owner]);
    await store.replacePersonalState(owner, validateSyncWrite({ mutationId: "wx-schema-" + randomUUID(), baseRevision: 0,
      clientUpdatedAt: new Date().toISOString(), state: { profile: null, skipped: false,
        plans: [{ id: "default", name: "原有精确时段", scheduleIds: ["known-1-9", "known-9-18"] }], activePlanId: "default",
        activities: [], assignments: [], academicSnapshots: [], trainingPlan: null, favoriteRooms: [], recentRooms: [], preferredTerm: "fall", theme: "system" } }));
    const before = await store.getPersonalState(owner);
    const userBefore = await pool.query("SELECT * FROM app_users WHERE id=$1", [owner]);
    const credentialBefore = await pool.query("SELECT * FROM password_credentials WHERE user_id=$1", [owner]);
    const sessionBefore = await pool.query("SELECT * FROM user_sessions WHERE id=$1", [sessionId]);
    await db.exec(await fs.readFile("ops/postgres/migrations/0033_miniprogram_wechat_binding.sql", "utf8"));

    await t.test("existing UUID, credentials, sessions and exact meeting IDs are unchanged by the migration", async () => {
      assert.deepEqual(await store.getPersonalState(owner), before);
      assert.deepEqual((await pool.query("SELECT * FROM app_users WHERE id=$1", [owner])).rows, userBefore.rows);
      assert.deepEqual((await pool.query("SELECT * FROM password_credentials WHERE user_id=$1", [owner])).rows, credentialBefore.rows);
      assert.deepEqual((await pool.query("SELECT * FROM user_sessions WHERE id=$1", [sessionId])).rows, sessionBefore.rows);
      assert.equal(await store.miniProgramWechatReady(), true);
    });

    await t.test("mapping is app-scoped, unique by identity and owner, and cannot be updated", async () => {
      const hash = "a".repeat(64);
      await pool.query("INSERT INTO miniprogram_wechat_identities(app_id,openid_hash,user_id) VALUES('wx0000000000000000',$1,$2)", [hash, owner]);
      await assert.rejects(pool.query("INSERT INTO miniprogram_wechat_identities(app_id,openid_hash,user_id) VALUES('wx0000000000000000',$1,$2)", [hash, other]), { code: "23505" });
      await assert.rejects(pool.query("INSERT INTO miniprogram_wechat_identities(app_id,openid_hash,user_id) VALUES('wx0000000000000000',$1,$2)", ["b".repeat(64), owner]), { code: "23505" });
      await assert.rejects(pool.query("UPDATE miniprogram_wechat_identities SET user_id=$1", [other]), { code: "23514" });
      await pool.query("INSERT INTO miniprogram_wechat_identities(app_id,openid_hash,user_id) VALUES('wx1111111111111111',$1,$2)", [hash, other]);
    });

    await t.test("challenge cannot mix an account with another account's session or outlive the five-minute window", async () => {
      const insert = `INSERT INTO miniprogram_wechat_challenges(token_hash,app_id,openid_hash,user_id,session_id,expires_at)
        VALUES($1,'wx0000000000000000',$2,$3,$4,statement_timestamp()+interval '5 minutes')`;
      await assert.rejects(pool.query(insert, ["a".repeat(64), "b".repeat(64), other, sessionId]), { code: "23503" });
      await assert.rejects(pool.query(insert, ["a".repeat(64), "b".repeat(64), owner, null]), { code: "23514" });
      await pool.query(insert, ["a".repeat(64), "b".repeat(64), owner, sessionId]);
      await assert.rejects(pool.query(`INSERT INTO miniprogram_wechat_challenges(token_hash,app_id,openid_hash,expires_at)
        VALUES($1,'wx0000000000000000',$2,statement_timestamp()+interval '6 minutes')`, ["c".repeat(64), "d".repeat(64)]), { code: "23514" });
    });

    await t.test("runtime role can create a linked session without mapping write privileges; deletion still cascades cleanly", async () => {
      await db.exec(`CREATE ROLE mini_schema_runtime;
        GRANT USAGE ON SCHEMA public TO mini_schema_runtime;
        GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO mini_schema_runtime;
        REVOKE UPDATE,DELETE,TRUNCATE ON miniprogram_wechat_identities FROM mini_schema_runtime;
        SET ROLE mini_schema_runtime;`);
      // Use the real store under runtime grants: SELECT row locks also require
      // UPDATE privilege in PostgreSQL. Owner-only integration hides this bug.
      const device = await store.getOrCreateAnonymousDevice("c".repeat(64));
      const created = await store.createMiniProgramWechatSession({ appId: "wx0000000000000000", openidHash: "a".repeat(64),
        userId: owner, anonymousDeviceId: device.id, sessionTokenHash: "e".repeat(64), sessionExpiresAt: new Date(Date.now() + 60000) });
      assert.ok(created.sessionId);
      assert.equal((await store.getActiveSession("e".repeat(64))).userId, owner);
      for (const sql of ["UPDATE miniprogram_wechat_identities SET user_id = user_id", "DELETE FROM miniprogram_wechat_identities", "TRUNCATE miniprogram_wechat_identities"]) {
        await assert.rejects(pool.query(sql), { code: "42501" });
      }
      await pool.query("DELETE FROM app_users WHERE id=$1", [owner]);
      assert.equal((await pool.query("SELECT 1 FROM miniprogram_wechat_identities WHERE user_id=$1", [owner])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM miniprogram_wechat_challenges WHERE user_id=$1", [owner])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM app_users WHERE id=$1", [other])).rowCount, 1);
      await db.exec("RESET ROLE");
    });
  } finally { await db.close(); }
});
