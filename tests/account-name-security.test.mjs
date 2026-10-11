import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { createAuthStore } from "../services/auth-api/src/db.mjs";

const native = process.env.POSTGRES_INTEGRATION === "true";
const digest = () => createHash("sha256").update(randomUUID()).digest("hex");
async function databasePool({ legacy = false } = {}) {
  if (native && !legacy) {
    if (process.env.PGHOST !== "127.0.0.1" || !/^dufesh_[a-z_]*(?:ci|test)$/u.test(process.env.POSTGRES_DB ?? "") ||
        !process.env.AUTH_DB_USER || !process.env.AUTH_DB_PASSWORD) throw new Error("Name tests require an isolated loopback test database and runtime role");
    const pool = new pg.Pool({ host: "127.0.0.1", port: Number(process.env.PGPORT), database: process.env.POSTGRES_DB,
      user: process.env.AUTH_DB_USER, password: process.env.AUTH_DB_PASSWORD, max: 10, query_timeout: 10_000 });
    await pool.query("SELECT id FROM account_name_change_requests LIMIT 0"); return pool;
  }
  const db = new PGlite(); await db.waitReady;
  for (const name of (await fs.readdir("ops/postgres/migrations")).filter(name => name.endsWith(".sql")).sort()) {
    if (legacy && name.startsWith("0030_")) continue;
    await db.exec(await fs.readFile(`ops/postgres/migrations/${name}`, "utf8"));
  }
  let tail = Promise.resolve();
  async function lock() { const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous; return release; }
  async function query(sql, values) { const result = await db.query(sql, values); return { ...result, rowCount: result.rows.length || result.affectedRows || 0 }; }
  return { async connect() { const release = await lock(); return { query, release }; },
    async query(sql, values) { const release = await lock(); try { return await query(sql, values); } finally { release(); } },
    applyNameMigration: async () => db.exec(await fs.readFile("ops/postgres/migrations/0030_account_name_review.sql", "utf8")), end: () => db.close() };
}

test("names remain individual, unique outside momo, and change only in an administrator MFA review transaction", { timeout: 60_000 }, async t => {
  const pool = await databasePool(); const store = createAuthStore(pool); const userIds = [];
  async function user(displayName, role = "user", nameMode = "name", changedAt = null, loginName = null) {
    const id = randomUUID(); const username = loginName ?? `names-${id.slice(0, 12)}`;
    await pool.query(`INSERT INTO app_users(id,username,normalized_username,display_name,email,normalized_email,role,name_mode,name_mode_changed_at)
      VALUES($1,$2,$2,$3,$4,$4,$5,$6,$7)`, [id, username, displayName ?? username, `names-${id}@example.com`, role, nameMode, changedAt]);
    userIds.push(id);
    const session = await pool.query(`INSERT INTO user_sessions(user_id,token_hash,expires_at)
      VALUES($1,$2,clock_timestamp()+interval '1 hour') RETURNING id`, [id, digest()]);
    const elevationHash = digest();
    const elevation = await pool.query(`INSERT INTO admin_elevated_sessions(user_id,base_session_id,token_hash,method,expires_at)
      VALUES($1,$2,$3,'totp',clock_timestamp()+interval '10 minutes') RETURNING id`, [id, session.rows[0].id, elevationHash]);
    return { id, username, displayName: displayName ?? username, sessionId: session.rows[0].id, elevationId: elevation.rows[0].id, elevationHash };
  }
  const request = (target, names) => store.requestAccountNameChange({ userId: target.id, sessionId: target.sessionId, ...names });
  const rename = target => `renamed-${target.id.slice(0, 8)}`;
  const review = (actor, pending, decision = "approve", reason = "") => store.reviewAccountNameChange({ nameChangeId: pending.id,
    decision, reason, actorUserId: actor.id, actorSessionId: actor.sessionId, actorElevationTokenHash: actor.elevationHash, requestId: randomUUID() });
  const stored = target => pool.query("SELECT username,normalized_username,display_name,school_account FROM app_users WHERE id=$1", [target.id]).then(r => r.rows[0]);
  const admin = await user(undefined, "admin");
  try {
    await t.test("database NFKC, whitespace and case uniqueness protects disabled and deleted public names", async () => {
      const tag = `public-${randomUUID().slice(0, 8)}`; const target = await user(tag);
      for (const name of [tag.toUpperCase(), ` ${tag} `, tag.replaceAll("p", "ｐ")]) {
        await assert.rejects(user(name), error => error.code === "23505" && error.constraint === "app_users_public_display_name_uidx");
      }
      for (const status of ["disabled", "deleted"]) {
        await pool.query("UPDATE app_users SET status=$2 WHERE id=$1", [target.id, status]);
        await assert.rejects(user(tag), error => error.code === "23505");
      }
    });
    await t.test("all ECMAScript edge whitespace including raw OGHAM SPACE uses one immutable public-name key", async () => {
      const target = await user(`trim-${randomUUID().slice(0, 8)}-海`);
      const whitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
      for (const edge of whitespace) await assert.rejects(user(`${edge}${target.displayName}${edge}`),
        error => error.code === "23505" && error.constraint === "app_users_public_display_name_uidx");
      const requester = await user();
      await assert.rejects(request(requester, { displayName: `\u1680${target.displayName}\u1680` }), { code: "AUTH_NAME_TAKEN" });
      const properties = await pool.query("SELECT provolatile,proisstrict,prosecdef FROM pg_proc WHERE oid='public_account_name_key(text)'::regprocedure");
      assert.equal(properties.rows[0].provolatile, "i"); assert.equal(properties.rows[0].proisstrict, true); assert.equal(properties.rows[0].prosecdef, false);
      assert.equal((await pool.query("SELECT public_account_name_key(NULL::text) AS value")).rows[0].value, null);
    });
    await t.test("public Greek case collisions use the database lower rule independently of login normalization", async () => {
      const target = await user(`greek-${randomUUID().slice(0, 8)}-ΟΣ`);
      const result = await pool.query("SELECT lower($1::text) AS folded", [target.displayName]);
      await assert.rejects(user(result.rows[0].folded), error => error.code === "23505" && error.constraint === "app_users_public_display_name_uidx");
    });
    await t.test("many public momo users have independent login names, email, UUID and sessions", async () => {
      const a = await user(undefined, "user", "momo"); const b = await user(undefined, "user", "momo"); const c = await user(undefined, "user", "momo");
      assert.equal(new Set([a.id, b.id, c.id]).size, 3); assert.equal(new Set([a.username, b.username, c.username]).size, 3);
      assert.equal(new Set([a.sessionId, b.sessionId, c.sessionId]).size, 3);
      for (const target of [a, b, c]) {
        const profile = await store.getUserProfile(target.id);
        assert.equal(profile.displayName, "momo"); assert.equal(profile.accountName, target.username); assert.equal(profile.nameMode, "momo");
      }
      await assert.rejects(pool.query("INSERT INTO app_users(username,normalized_username,display_name) VALUES($1,$1,'momo')", [a.username]),
        error => error.code === "23505" && error.constraint === "app_users_normalized_username_uidx");
    });
    await t.test("a login-name fallback also reserves its public name when display_name is null", async () => {
      const target = await user();
      await assert.rejects(pool.query("INSERT INTO app_users(username,normalized_username,name_mode) VALUES($1,$1,'momo')", [target.displayName]),
        error => error.code === "23505");
      const fallback = `fallback-${randomUUID().slice(0, 8)}`;
      const inserted = await pool.query("INSERT INTO app_users(username,normalized_username,name_mode) VALUES($1,$1,'momo') RETURNING id", [fallback]);
      userIds.push(inserted.rows[0].id);
      await assert.rejects(user(fallback), error => error.code === "23505" && error.constraint === "app_users_public_display_name_uidx");
    });
    await t.test("request validates active owner session and leaves original account names unchanged", async () => {
      const target = await user(); const stranger = await user();
      await assert.rejects(store.requestAccountNameChange({ userId: target.id, sessionId: stranger.sessionId, displayName: rename(target) }), { code: "AUTH_SESSION_REQUIRED" });
      const pending = await request(target, { username: "一", displayName: rename(target) });
      assert.equal(pending.status, "pending"); assert.equal(pending.requestedUsername, "一");
      assert.equal((await stored(target)).username, target.username); assert.equal((await stored(target)).display_name, target.displayName);
      assert.equal((await store.getAccountNameChange(target.id)).id, pending.id); assert.equal(await store.getAccountNameChange(stranger.id), null);
      assert.equal(JSON.stringify(pending).includes("@example.com"), false);
    });
    await t.test("same pending submission is idempotent; different pending submissions cannot overwrite the request", async () => {
      const target = await user(); const pending = await request(target, { displayName: rename(target) });
      assert.equal((await request(target, { displayName: rename(target) })).id, pending.id);
      await assert.rejects(request(target, { username: "二" }), { code: "AUTH_NAME_CHANGE_CONFLICT" });
      const count = await pool.query("SELECT count(*)::int AS count FROM account_name_change_requests WHERE user_id=$1", [target.id]);
      assert.equal(count.rows[0].count, 1);
    });
    await t.test("occupied public names and login names fail without creating a pending request", async () => {
      const target = await user(); const taken = await user();
      await assert.rejects(request(target, { displayName: taken.displayName.toUpperCase() }), { code: "AUTH_NAME_TAKEN" });
      await assert.rejects(request(target, { username: taken.username }), { code: "AUTH_NAME_TAKEN" });
      assert.equal(await store.getAccountNameChange(target.id), null);
    });
    await t.test("profile permits unchanged names and school-account changes, but cannot rename", async () => {
      const target = await user();
      const profile = await store.updateUserProfile(target.id, { username: target.username, displayName: target.displayName, schoolAccount: "20260001" });
      assert.equal(profile.schoolAccount, "20260001");
      await assert.rejects(store.updateUserProfile(target.id, { displayName: "momo", schoolAccount: "20260002" }), { code: "AUTH_NAME_REVIEW_REQUIRED" });
      assert.equal((await stored(target)).school_account, "20260001");
    });
    await t.test("direct SQL cannot change names with no context or a pending/another user's context", async () => {
      const target = await user(); const another = await user(); const pending = await request(target, { displayName: rename(target) });
      await assert.rejects(pool.query("UPDATE app_users SET display_name='momo' WHERE id=$1", [target.id]), /AUTH_NAME_REVIEW_REQUIRED/u);
      const client = await pool.connect();
      try {
        for (const id of [target.id, another.id]) {
          await client.query("BEGIN"); await client.query("SELECT set_config('dufesh.account_name_review_id',$1,true)", [pending.id]);
          await assert.rejects(client.query("UPDATE app_users SET display_name='momo' WHERE id=$1", [id]), /AUTH_NAME_REVIEW_REQUIRED/u);
          await client.query("ROLLBACK");
        }
      } finally { client.release(); }
      await pool.query("UPDATE app_users SET username=username,display_name=display_name,last_login_at=clock_timestamp() WHERE id=$1", [target.id]);
    });
    await t.test("ordinary users, expired MFA and revoked base sessions cannot review", async () => {
      const target = await user(); const ordinary = await user(); const expired = await user(undefined, "admin"); const revoked = await user(undefined, "admin");
      const pending = await request(target, { displayName: rename(target) });
      await assert.rejects(review(ordinary, pending), { code: "AUTH_ADMIN_FORBIDDEN" });
      await pool.query("UPDATE admin_elevated_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.elevationId]);
      await assert.rejects(review(expired, pending), { code: "AUTH_ADMIN_FORBIDDEN" });
      await pool.query("UPDATE user_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [revoked.sessionId]);
      await assert.rejects(review(revoked, pending), { code: "AUTH_ADMIN_FORBIDDEN" });
      assert.equal((await store.getAccountNameChange(target.id)).status, "pending"); assert.equal((await stored(target)).display_name, target.displayName);
    });
    await t.test("approval changes exact requested fields, preserves post ownership and creates one audit event", async () => {
      const target = await user(); const pending = await request(target, { username: `新-${randomUUID().slice(0, 8)}`, displayName: rename(target) });
      const topic = await pool.query("INSERT INTO community_topics(author_user_id,title,body) VALUES($1,'审核测试','synthetic body') RETURNING id", [target.id]);
      const approved = await review(admin, pending); assert.equal(approved.status, "approved");
      const after = await stored(target); assert.equal(after.username, pending.requestedUsername); assert.equal(after.normalized_username, pending.requestedUsername);
      assert.equal(after.display_name, rename(target));
      const owner = await pool.query("SELECT author_user_id FROM community_topics WHERE id=$1", [topic.rows[0].id]); assert.equal(owner.rows[0].author_user_id, target.id);
      const audit = await pool.query("SELECT action,metadata FROM admin_audit_events WHERE target_id=$1", [pending.id]);
      assert.equal(audit.rowCount, 1); assert.equal(audit.rows[0].action, "admin.account_name.approved");
      assert.equal(audit.rows[0].metadata.userId, target.id);
      await assert.rejects(review(admin, pending), { code: "AUTH_NAME_CHANGE_CONFLICT" });
      await assert.rejects(pool.query("UPDATE app_users SET display_name=$2 WHERE id=$1", [target.id, target.displayName]), /AUTH_NAME_REVIEW_REQUIRED/u);
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SELECT set_config('dufesh.account_name_review_id',$1,true)", [pending.id]);
        await assert.rejects(client.query("UPDATE app_users SET display_name=$2 WHERE id=$1", [target.id, target.displayName]), /AUTH_NAME_REVIEW_REQUIRED/u);
        await client.query("ROLLBACK");
      } finally { client.release(); }
    });
    await t.test("rejection keeps names and allows a new request after the old one is resolved", async () => {
      const target = await user(); const pending = await request(target, { displayName: rename(target) });
      await assert.rejects(review(admin, pending, "reject"), { code: "AUTH_NAME_CHANGE_INVALID" });
      const rejected = await review(admin, pending, "reject", "重"); assert.equal(rejected.status, "rejected"); assert.equal(rejected.reason, "重");
      assert.equal((await stored(target)).display_name, target.displayName);
      assert.notEqual((await request(target, { displayName: `again-${target.id.slice(0, 8)}` })).id, pending.id);
    });
    await t.test("a name claimed after request causes approval rollback, retaining pending state and no audit", async () => {
      const target = await user(); const name = `claim-${randomUUID().slice(0, 8)}`; const pending = await request(target, { displayName: name });
      await user(name); await assert.rejects(review(admin, pending), { code: "AUTH_NAME_TAKEN" });
      assert.equal((await store.getAccountNameChange(target.id)).status, "pending"); assert.equal((await stored(target)).display_name, target.displayName);
      assert.equal((await pool.query("SELECT id FROM admin_audit_events WHERE target_id=$1", [pending.id])).rowCount, 0);
    });
    await t.test("stale original snapshots and revoked target sessions fail closed", async () => {
      const target = await user(); const pending = await request(target, { displayName: rename(target) });
      await pool.query("UPDATE account_name_change_requests SET original_display_name='synthetic-stale-name' WHERE id=$1", [pending.id]);
      await assert.rejects(review(admin, pending), { code: "AUTH_NAME_CHANGE_CONFLICT" });
      assert.equal((await stored(target)).display_name, target.displayName);
      const expired = await user();
      await pool.query("UPDATE user_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.sessionId]);
      await assert.rejects(request(expired, { displayName: rename(expired) }), { code: "AUTH_SESSION_REQUIRED" });
    });
    await t.test("OAuth profile refresh keeps approved public names; new external identities receive independent momo accounts", async () => {
      const target = await user(); const provider = "wechat_name_test"; const subject = `names-${randomUUID()}`;
      await pool.query("INSERT INTO oauth_identities(user_id,provider,provider_subject) VALUES($1,$2,$3)", [target.id, provider, subject]);
      async function login(identitySubject) {
        const anonymous = await store.getOrCreateAnonymousDevice(digest()); const stateHash = digest(); const browserTokenHash = digest();
        await store.createOAuthTransaction({ provider, stateHash, browserTokenHash, anonymousDeviceId: anonymous.id,
          returnTo: "/", expiresAt: new Date(Date.now() + 600_000) });
        const result = await store.consumeOAuthAndCreateSession({ provider, stateHash, browserTokenHash,
          identity: { subject: identitySubject, displayName: `外部-${target.id.slice(0, 8)}`, avatarUrl: null, profile: { nickname: "外部昵称" } },
          sessionTokenHash: digest(), sessionExpiresAt: new Date(Date.now() + 600_000) });
        return result;
      }
      await login(subject); assert.equal((await stored(target)).display_name, target.displayName);
      const a = await login(`new-${randomUUID()}`); const b = await login(`new-${randomUUID()}`);
      userIds.push(a.userId, b.userId); assert.notEqual(a.userId, b.userId);
      const created = await pool.query("SELECT display_name,name_mode FROM app_users WHERE id=ANY($1::uuid[])", [[a.userId, b.userId]]);
      assert.deepEqual(created.rows.map(row => row.display_name), [null, null]); assert.deepEqual(created.rows.map(row => row.name_mode), ["momo", "momo"]);
      await assert.rejects(store.setAccountNameMode({ userId: a.userId, sessionId: a.sessionId, mode: "name" }), { code: "AUTH_NAME_MODE_NAME_REQUIRED" });
    });
    await t.test("queue is bounded, cursor uses SQL precision, and responses exclude email and session material", async () => {
      const all = await store.listAccountNameChanges({ limit: 50 }); assert.ok(all.requests.length > 1);
      const first = await store.listAccountNameChanges({ limit: 1 }); assert.equal(first.requests.length, 1); assert.ok(first.nextCursor);
      const second = await store.listAccountNameChanges({ limit: 1, cursor: first.nextCursor }); assert.notEqual(first.requests[0].id, second.requests[0].id);
      const decoded = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString()); assert.equal(typeof decoded.createdAt, "string");
      for (const limit of [0, 51, 1.2]) await assert.rejects(store.listAccountNameChanges({ limit }), { code: "AUTH_NAME_CHANGE_INVALID" });
      await assert.rejects(store.listAccountNameChanges({ cursor: "not-a-valid-cursor" }), { code: "AUTH_NAME_CHANGE_INVALID" });
      await assert.rejects(store.listAccountNameChanges({ cursor: Buffer.from(JSON.stringify({ createdAt: "1", id: randomUUID() })).toString("base64url") }), { code: "AUTH_NAME_CHANGE_INVALID" });
      assert.equal(/email|session|elevation|normalized/iu.test(JSON.stringify(all)), false);
    });
    await t.test("display mode switches only the public label and preserves its owner's reserved name", async () => {
      const target = await user(); const stranger = await user();
      await assert.rejects(store.setAccountNameMode({ userId: target.id, sessionId: stranger.sessionId, mode: "momo" }), { code: "AUTH_SESSION_REQUIRED" });
      const switched = await store.setAccountNameMode({ userId: target.id, sessionId: target.sessionId, mode: "momo" });
      assert.equal(switched.nameMode, "momo"); assert.equal(switched.accountName, target.displayName); assert.equal(switched.displayName, "momo");
      assert.ok(switched.nameModeChangedAt); assert.ok(switched.nameModeAvailableAt);
      assert.equal(new Date(switched.nameModeAvailableAt).getTime() - new Date(switched.nameModeChangedAt).getTime(), 7 * 86_400_000);
      assert.equal((await stored(target)).display_name, target.displayName);
      await assert.rejects(user(target.displayName), error => error.code === "23505");
      await assert.rejects(request(target, { displayName: "ＭＯＭＯ" }), { code: "AUTH_NAME_CHANGE_INVALID" });
      const publicSession = await pool.query("SELECT token_hash FROM user_sessions WHERE id=$1", [target.sessionId]);
      const session = await store.getActiveSession(publicSession.rows[0].token_hash);
      assert.equal(session.displayName, "momo"); assert.equal(session.accountName, target.displayName);
    });
    await t.test("same-mode retry is idempotent and never resets the seven-day clock", async () => {
      const target = await user(); const first = await store.setAccountNameMode({ userId: target.id, sessionId: target.sessionId, mode: "momo" });
      const again = await store.setAccountNameMode({ userId: target.id, sessionId: target.sessionId, mode: "momo" });
      assert.deepEqual(again, first);
      await assert.rejects(store.setAccountNameMode({ userId: target.id, sessionId: target.sessionId, mode: "name" }),
        error => error.code === "AUTH_NAME_MODE_COOLDOWN" && error.availableAt === first.nameModeAvailableAt);
      assert.deepEqual(await store.setAccountNameMode({ userId: target.id, sessionId: target.sessionId, mode: "momo" }), first);
    });
    await t.test("registration mode has no initial penalty and switches become available after seven days", async () => {
      const initial = await user(undefined, "user", "momo");
      assert.equal((await store.getUserProfile(initial.id)).nameModeChangedAt, null);
      assert.equal((await store.setAccountNameMode({ userId: initial.id, sessionId: initial.sessionId, mode: "name" })).nameMode, "name");
      const older = await user(undefined, "user", "momo", new Date(Date.now() - 8 * 86_400_000));
      const changed = await store.setAccountNameMode({ userId: older.id, sessionId: older.sessionId, mode: "name" });
      assert.equal(changed.nameMode, "name"); assert.equal(changed.displayName, older.displayName);
      assert.ok(new Date(changed.nameModeChangedAt).getTime() >= Date.now() - 1_000);
    });
    await t.test("database cannot directly alter display mode, reset its cooldown or use name-review context for a mode change", async () => {
      const target = await user(); const pending = await request(target, { displayName: rename(target) });
      await assert.rejects(pool.query("UPDATE app_users SET name_mode='momo' WHERE id=$1", [target.id]), /AUTH_NAME_MODE_REVIEW_REQUIRED/u);
      await assert.rejects(pool.query("UPDATE app_users SET name_mode_changed_at=clock_timestamp() WHERE id=$1", [target.id]), /AUTH_NAME_MODE_REVIEW_REQUIRED/u);
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SELECT set_config('dufesh.account_name_review_id',$1,true)", [pending.id]);
        await assert.rejects(client.query("UPDATE app_users SET name_mode='momo' WHERE id=$1", [target.id]), /AUTH_NAME_MODE_REVIEW_REQUIRED/u);
        await client.query("ROLLBACK");
      } finally { client.release(); }
      await store.setAccountNameMode({ userId: target.id, sessionId: target.sessionId, mode: "momo" });
      await assert.rejects(pool.query("UPDATE app_users SET name_mode_changed_at=NULL WHERE id=$1", [target.id]), /AUTH_NAME_MODE_REVIEW_REQUIRED/u);
    });
    await t.test("name approval while momo preserves the mode and cooldown and publishes the name only after switching", async () => {
      const target = await user(); const mode = await store.setAccountNameMode({ userId: target.id, sessionId: target.sessionId, mode: "momo" });
      const pending = await request(target, { displayName: rename(target) }); await review(admin, pending);
      const profile = await store.getUserProfile(target.id);
      assert.equal(profile.accountName, rename(target)); assert.equal(profile.displayName, "momo");
      assert.equal(profile.nameModeChangedAt, mode.nameModeChangedAt);
      await assert.rejects(store.setAccountNameMode({ userId: target.id, sessionId: target.sessionId, mode: "name" }), { code: "AUTH_NAME_MODE_COOLDOWN" });
    });
    await t.test("momo public projections are consistent across posts, replies, saved items, profiles, blocks, notifications and teacher replies", async () => {
      const target = await user(undefined, "user", "momo"); const viewer = await user();
      const topic = await store.createCommunityTopic({ userId: target.id, title: "momo展示测试", body: `你好 @${viewer.username}`, visibility: "public" });
      const publicTopic = await store.getCommunityTopic({ topicId: topic.id, viewerUserId: viewer.id });
      assert.equal(publicTopic.author.displayName, "momo"); assert.equal(publicTopic.author.nameMode, "momo");
      assert.equal(publicTopic.author.username, target.username); assert.equal(Object.hasOwn(publicTopic.author, "accountName"), false);
      await store.createCommunityComment({ topicId: topic.id, userId: target.id, body: "同一个账号独立发表回复。", replyToCommentId: null });
      const comments = await store.listCommunityComments({ topicId: topic.id, viewerUserId: viewer.id });
      assert.equal(comments.items[0].author.displayName, "momo"); assert.equal(comments.items[0].author.id, target.id);
      await store.setCommunityBookmark({ topicId: topic.id, userId: viewer.id, active: true });
      const bookmarks = await store.listCommunityBookmarks({ userId: viewer.id }); assert.equal(bookmarks.items[0].author.displayName, "momo");
      const profile = await store.getCommunityUserProfile({ userId: target.id, viewerUserId: viewer.id });
      assert.equal(profile.displayName, "momo"); assert.equal(Object.hasOwn(profile, "accountName"), false);
      const notices = await store.listCommunityNotifications({ userId: viewer.id });
      assert.equal(notices.items.find(item => item.actor?.id === target.id).actor.displayName, "momo");
      await store.setCommunityBlock({ blockerUserId: viewer.id, blockedUserId: target.id, active: true });
      const blocks = await store.listCommunityBlocks({ userId: viewer.id }); assert.equal(blocks.items[0].user.displayName, "momo");
      await store.setCommunityBlock({ blockerUserId: viewer.id, blockedUserId: target.id, active: false });
      const teacherId = randomUUID(); const teacherLabel = `名字测试教师-${teacherId.slice(0, 8)}`;
      let imports;
      try {
        imports = native ? new pg.Pool({ host: "127.0.0.1", port: Number(process.env.PGPORT), database: process.env.POSTGRES_DB,
          user: process.env.IMPORT_DB_USER, password: process.env.IMPORT_DB_PASSWORD, max: 1 }) : pool;
        await imports.query(`INSERT INTO teachers(id,display_name,normalized_name,college_name,normalized_college,identity_status)
          VALUES($1,$2,$2,'合成学院','合成学院','active')`, [teacherId, teacherLabel]);
      } finally { if (native) await imports?.end(); }
      const body = "这是一条用于验证公开回复显示名的合成教师评价，不包含真实用户资料。";
      const reviewRow = await pool.query(`INSERT INTO teacher_reviews(teacher_id,author_user_id,source_type,author_label,body,
        course_organization_rating,content_clarity_rating,assessment_explanation_rating,classroom_interaction_rating,
        material_completeness_rating,content_sha256) VALUES($1,$2,'user','已注册用户',$3,5,5,5,5,5,$4) RETURNING id`,
      [teacherId, viewer.id, body, createHash("sha256").update(body).digest("hex")]);
      const reply = await store.createTeacherReviewComment({ teacherId, reviewId: reviewRow.rows[0].id, userId: target.id, body: "合成回复，保持 momo 展示。", replyToCommentId: null });
      assert.equal(reply.author.displayName, "momo"); assert.equal(reply.author.nameMode, "momo");
      const teacherComments = await store.listTeacherReviewComments({ reviewId: reviewRow.rows[0].id, viewerUserId: viewer.id, limit: 20 });
      assert.equal(teacherComments.items[0].author.displayName, "momo"); assert.equal(Object.hasOwn(teacherComments.items[0].author, "accountName"), false);
    });
    await t.test("Unicode-normalized mentions identify the full login name without notifying a short prefix or sharing momo identity", async () => {
      const a = await user(undefined, "user", "momo", null, "a"); const accented = await user(undefined, "user", "momo", null, "á"); const actor = await user();
      const topic = await store.createCommunityTopic({ userId: actor.id, title: "Unicode提及测试", body: "请 @a\u0301 查看这条合成通知。", visibility: "public" });
      const notifications = await pool.query("SELECT recipient_user_id FROM community_notifications WHERE topic_id=$1 AND notification_type='mention'", [topic.id]);
      assert.deepEqual(notifications.rows.map(row => row.recipient_user_id), [accented.id]);
      assert.notEqual(a.id, accented.id);
    });
    await t.test("two real PostgreSQL admins racing on one request apply it exactly once", { skip: !native }, async () => {
      const target = await user(); const adminB = await user(undefined, "admin"); const pending = await request(target, { displayName: rename(target) });
      const results = await Promise.allSettled([review(admin, pending), review(adminB, pending)]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.find(result => result.status === "rejected").reason.code, "AUTH_NAME_CHANGE_CONFLICT");
      assert.equal((await pool.query("SELECT id FROM admin_audit_events WHERE target_id=$1", [pending.id])).rowCount, 1);
    });
    await t.test("two real PostgreSQL clients concurrently submitting the same pending payload get one id", { skip: !native }, async () => {
      const target = await user(); const results = await Promise.all([request(target, { displayName: rename(target) }), request(target, { displayName: rename(target) })]);
      assert.equal(results[0].id, results[1].id);
      assert.equal((await pool.query("SELECT id FROM account_name_change_requests WHERE user_id=$1 AND status='pending'", [target.id])).rowCount, 1);
    });
    await t.test("two real PostgreSQL users racing for a public name cannot both be approved", { skip: !native }, async () => {
      const a = await user(); const b = await user(); const adminB = await user(undefined, "admin"); const name = `race-${randomUUID().slice(0, 8)}`;
      const requestA = await request(a, { displayName: name }); const requestB = await request(b, { displayName: name });
      const results = await Promise.allSettled([review(admin, requestA), review(adminB, requestB)]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.find(result => result.status === "rejected").reason.code, "AUTH_NAME_TAKEN");
      assert.equal((await pool.query("SELECT id FROM app_users WHERE display_name=$1", [name])).rowCount, 1);
    });
    await t.test("real PostgreSQL mode requests across clients share one cooldown and one timestamp", { skip: !native }, async () => {
      const target = await user(); const inputs = { userId: target.id, sessionId: target.sessionId, mode: "momo" };
      const results = await Promise.all([store.setAccountNameMode(inputs), createAuthStore(pool).setAccountNameMode(inputs)]);
      assert.deepEqual(results[0], results[1]);
      await assert.rejects(createAuthStore(pool).setAccountNameMode({ ...inputs, mode: "name" }), { code: "AUTH_NAME_MODE_COOLDOWN" });
    });
  } finally { if (native && userIds.length) await pool.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [userIds]); await pool.end(); }
});

test("0030 is additive and preserves existing names, credentials, verified state and sessions", { timeout: 60_000 }, async () => {
  const pool = await databasePool({ legacy: true }); const id = randomUUID();
  try {
    await pool.query("INSERT INTO app_users(id,username,normalized_username,display_name,email_verified_at) VALUES($1,'旧名','旧名','旧名',NULL)", [id]);
    const oldMomoId = randomUUID();
    await pool.query("INSERT INTO app_users(id,username,normalized_username,display_name) VALUES($1,'旧momo名','旧momo名','ＭＯＭＯ')", [oldMomoId]);
    await pool.query("INSERT INTO password_credentials(user_id,password_hash) VALUES($1,'synthetic-old-hash')", [id]);
    await pool.query("INSERT INTO user_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", [id, digest()]);
    await pool.applyNameMigration();
    const user = await pool.query("SELECT username,display_name,email_verified_at FROM app_users WHERE id=$1", [id]);
    assert.equal(user.rows[0].username, "旧名"); assert.equal(user.rows[0].display_name, "旧名"); assert.equal(user.rows[0].email_verified_at, null);
    const oldMomo = await pool.query("SELECT display_name,name_mode,name_mode_changed_at FROM app_users WHERE id=$1", [oldMomoId]);
    assert.equal(oldMomo.rows[0].display_name, "旧momo名"); assert.equal(oldMomo.rows[0].name_mode, "momo"); assert.equal(oldMomo.rows[0].name_mode_changed_at, null);
    const password = await pool.query("SELECT password_hash FROM password_credentials WHERE user_id=$1", [id]); assert.equal(password.rows[0].password_hash, "synthetic-old-hash");
    const session = await pool.query("SELECT revoked_at FROM user_sessions WHERE user_id=$1", [id]); assert.equal(session.rows[0].revoked_at, null);
    assert.equal((await pool.query("SELECT id FROM account_name_change_requests")).rowCount, 0);
  } finally { await pool.end(); }
});

test("0030 refuses missing legacy momo names and reservation conflicts without renaming users", { timeout: 60_000 }, async t => {
  for (const scenario of ["missing", "conflict", "unicode_whitespace_conflict"]) {
    await t.test(scenario, async () => {
      const pool = await databasePool({ legacy: true });
      try {
        if (scenario === "missing") {
          await pool.query("INSERT INTO app_users(display_name) VALUES('momo')");
        } else if (scenario === "conflict") {
          await pool.query("INSERT INTO app_users(username,normalized_username,display_name) VALUES('reserved','reserved','momo'),('another','another','reserved')");
        } else {
          await pool.query("INSERT INTO app_users(username,normalized_username,display_name) VALUES('first','first',$1),('second','second','海')", ["\u1680海\u1680"]);
        }
        const before = await pool.query("SELECT id,username,display_name FROM app_users ORDER BY id");
        await assert.rejects(pool.applyNameMigration(), scenario === "missing"
          ? /legacy momo account requires an existing account name/u : /account name reservations conflict/u);
        const after = await pool.query("SELECT id,username,display_name FROM app_users ORDER BY id");
        assert.deepEqual(after.rows, before.rows);
      } finally { await pool.end(); }
    });
  }
});
