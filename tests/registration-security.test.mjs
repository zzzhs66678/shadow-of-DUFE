import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { createAuthStore } from "../services/auth-api/src/db.mjs";
import { createAuthServer } from "../services/auth-api/src/server.mjs";
import { createApiRateLimiters } from "../services/auth-api/src/rate-limit.mjs";
import { createRegistrationCode, registrationDigest, REGISTRATION_POLICY } from "../services/auth-api/src/registration-security.mjs";
import { clientAddress, parseTrustedProxies, secureRequest } from "../services/auth-api/src/request-security.mjs";
import { normalizeEmail, validEmail, validateNewPassword, validateLogin } from "../services/auth-api/src/credentials.mjs";
import { loadConfig } from "../services/auth-api/src/config.mjs";
import { clientAddress as xiaoyingAddress, secureRequest as xiaoyingSecure } from "../xiaoying-executor/src/request-security.mjs";
import { tokenDigest } from "../services/auth-api/src/tokens.mjs";

const config = {
  nodeEnv: "test", tokenPepper: "synthetic-token-pepper-longer-than-32-characters",
  registrationMode: "smtp", registrationKey: "independent-synthetic-registration-key-32-characters",
  allowedOrigins: new Set(["https://dufesh.cn"]), publicOrigin: "https://dufesh.cn",
  sessionCookie: "__Host-dufesh_session", deviceCookie: "__Host-dufesh_device",
  sessionMaxAgeSeconds: 3600, deviceMaxAgeSeconds: 3600, credentialsEnabled: true,
  emailVerificationMode: "disabled", passwordResetMode: "disabled", wechatMode: "disabled",
};
const headers = { Origin: "https://dufesh.cn", "Content-Type": "application/json" };
const password = "harbor winds carry notebooks";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const fakePasswords = { hash: async (s) => `synthetic:${hash(s)}`, verify: async (h, s) => h === `synthetic:${hash(s)}` };

// PGlite is a real PostgreSQL engine, but uses one connection. This mutex keeps
// transactions isolated; native multi-connection contention is tested in CI.
async function databasePool() {
  if (process.env.SECURITY_POSTGRES_TEST === "true") {
    if (process.env.PGHOST !== "127.0.0.1" || !/^dufesh_[a-z_]*security_test$/u.test(process.env.POSTGRES_DB ?? "")) {
      throw new Error("Security test requires a dedicated loopback test database");
    }
    const pool = new pg.Pool({ host: "127.0.0.1", port: Number(process.env.PGPORT),
      database: process.env.POSTGRES_DB, user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, max: 10 });
    const tables = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public'");
    if (tables.rowCount) { await pool.end(); throw new Error("Security test requires an EMPTY dedicated database"); }
    for (const name of (await fs.readdir("ops/postgres/migrations")).filter((n) => n.endsWith(".sql")).sort()) {
      await pool.query(await fs.readFile(`ops/postgres/migrations/${name}`, "utf8"));
    }
    return pool;
  }
  const db = new PGlite(); await db.waitReady;
  for (const name of (await fs.readdir("ops/postgres/migrations")).filter((n) => n.endsWith(".sql")).sort()) {
    await db.exec(await fs.readFile(`ops/postgres/migrations/${name}`, "utf8"));
  }
  let tail = Promise.resolve();
  async function lock() {
    const previous = tail; let release;
    tail = new Promise((resolve) => { release = resolve; }); await previous; return release;
  }
  async function query(sql, values) {
    const result = await db.query(sql, values);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  }
  return {
    async connect() { const release = await lock(); return { query, release }; },
    async query(sql, values) { const release = await lock(); try { return await query(sql, values); } finally { release(); } },
    end: () => db.close(),
  };
}

test("email and password policies preserve identity and legacy login", () => {
  assert.equal(normalizeEmail(" A.B+study@EXAMPLE.COM "), "a.b+study@example.com");
  assert.notEqual(normalizeEmail("a.b@example.com"), normalizeEmail("ab@example.com"));
  for (const value of ["a@example.com,b@example.com", "A <a@example.com>", "a@example.com\r\nBcc:x@y.com", "a..b@example.com", "\"a,b\"@example.com"]) assert.equal(validEmail(value), false);
  assert.equal(validateNewPassword(password), true);
  assert.equal(validateNewPassword("a".repeat(14)), false);
  assert.equal(validateNewPassword("😀".repeat(128)), true);
  assert.equal(validateNewPassword("😀".repeat(129)), false);
  assert.ok(validateLogin({ identifier: "legacy", password: "old-short-password" }));
  for (let i = 0; i < 100; i += 1) assert.match(createRegistrationCode(), /^\d{6}$/u);
  const proof = { challengeId: randomUUID(), email: "a@example.com", code: "123456" };
  assert.notEqual(registrationDigest(proof, config.registrationKey), registrationDigest({ ...proof, purpose: "reset" }, config.registrationKey));
});

test("proxy trust requires an explicit peer range and HTTPS is fail closed", () => {
  const request = { socket: { remoteAddress: "::ffff:192.0.2.5" }, headers: { "x-forwarded-for": "198.51.100.1", "x-forwarded-proto": "https" } };
  assert.equal(clientAddress(request, {}), "192.0.2.5");
  assert.equal(xiaoyingAddress(request, {}), "192.0.2.5");
  assert.equal(secureRequest(request, {}), false);
  assert.equal(xiaoyingSecure(request, {}), false);
  const trusted = { trustedProxyRanges: parseTrustedProxies("192.0.2.5/32") };
  assert.equal(clientAddress(request, trusted), "198.51.100.1");
  assert.equal(xiaoyingAddress(request, trusted), "198.51.100.1");
  assert.equal(secureRequest(request, trusted), true);
  request.headers["x-forwarded-for"] = "forged, 198.51.100.2";
  assert.equal(clientAddress(request, trusted), "198.51.100.2");
  request.headers["x-forwarded-for"] = "invalid";
  assert.equal(clientAddress(request, trusted), "192.0.2.5");
  assert.throws(() => parseTrustedProxies("0.0.0.0/0"));
});

test("production registration cannot use debug codes or reuse a session key", () => {
  const env = { NODE_ENV: "production", AUTH_TOKEN_PEPPER: config.tokenPepper, AUTH_DB_PASSWORD: "fixture-password" };
  assert.equal(loadConfig(env).registrationMode, "disabled");
  assert.throws(() => loadConfig({ ...env, AUTH_REGISTRATION_MODE: "response" }));
  assert.throws(() => loadConfig({ ...env, AUTH_REGISTRATION_MODE: "smtp", AUTH_REGISTRATION_HMAC_KEY: config.tokenPepper }));
  const smtp = { ...env, AUTH_REGISTRATION_MODE: "smtp", AUTH_REGISTRATION_HMAC_KEY: config.registrationKey,
    AUTH_SMTP_HOST: "smtp.qq.com", AUTH_SMTP_PORT: "465", AUTH_SMTP_SECURE: "true", AUTH_SMTP_USER: "2016594477@qq.com",
    AUTH_SMTP_PASSWORD: "synthetic-client-authorization", AUTH_EMAIL_FROM: "2016594477@qq.com" };
  assert.equal(loadConfig(smtp).smtp.secure, true);
  assert.throws(() => loadConfig({ ...smtp, AUTH_SMTP_SECURE: "false" }));
  assert.throws(() => loadConfig({ ...smtp, NODE_TLS_REJECT_UNAUTHORIZED: "0" }));
});

test("migrated registration, mail budgets and shared authentication HTTP flows", { timeout: 60_000 }, async (t) => {
  const pool = await databasePool(); const store = createAuthStore(pool);
  const mailbox = new Map(); const servers = [];
  let mailFails = false;
  const delivery = { async sendRegistrationCode(input) {
    if (mailFails) throw new Error("synthetic-sensitive-error-with-password-and-code");
    mailbox.set(input.to, input);
  } };
  async function start(overrides = {}, storeOverride = store) {
    const server = createAuthServer({ config: { ...config, ...overrides }, store: storeOverride,
      mailDelivery: delivery, passwordService: fakePasswords, rateLimiters: createApiRateLimiters({ store: storeOverride }) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  const base = await start(); const other = await start();
  const post = (endpoint, body, cookie = "", target = base, extra = {}) => fetch(target + endpoint,
    { method: "POST", headers: { ...headers, ...extra, Cookie: cookie }, body: JSON.stringify(body) });
  async function challenge(email) {
    const response = await post("/api/auth/register/challenge", { email }); assert.equal(response.status, 202);
    const body = await response.json(); assert.deepEqual(Object.keys(body).sort(), ["challengeId", "expiresIn", "ok", "retryAfter"]);
    const cookie = response.headers.getSetCookie().map((v) => v.split(";", 1)[0]).join("; ");
    for (let i = 0; i < 50; i += 1) {
      const result = await pool.query("SELECT delivered_at FROM registration_challenges WHERE id=$1", [body.challengeId]);
      if (result.rows[0].delivered_at || mailFails) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { id: body.challengeId, cookie, email, code: mailbox.get(email)?.code ?? "000000" };
  }
  function submission(c, changes = {}) {
    return { username: `student-${c.id.slice(0, 8)}`, email: c.email, password, challengeId: c.id, code: c.code, ...changes };
  }
  async function reject(c, changes = {}, cookie = c.cookie) {
    const response = await post("/api/auth/register", submission(c, changes), cookie);
    assert.equal(response.status, 400); assert.equal((await response.json()).error, "invalid_registration_verification");
  }
  try {
    await t.test("client flags, absent proof, extra mail fields and untrusted origins cannot activate", async () => {
      const c = await challenge("absent@example.com");
      await reject(c, { emailVerified: true }); await reject(c, { code: undefined }); await reject(c, {}, "");
      assert.equal((await post("/api/auth/register/challenge", { email: c.email, password })).status, 400);
      assert.equal((await post("/api/auth/register/challenge", { email: c.email, to: ["other@example.com"] })).status, 400);
      assert.equal((await post("/api/auth/register/challenge", { email: c.email }, "", base, { Origin: "https://evil.invalid" })).status, 403);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM app_users")).rows[0].n, 0);
    });
    await t.test("correct code creates one verified user; replay and duplicate email cannot overwrite", async () => {
      const c = await challenge("correct@example.com");
      const responses = await Promise.all([post("/api/auth/register", submission(c), c.cookie), post("/api/auth/register", submission(c), c.cookie, other)]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [201, 400]);
      const created = responses.find((r) => r.status === 201);
      assert.match(created.headers.getSetCookie().join(";"), /HttpOnly.*Secure.*SameSite=Lax/u);
      const body = await created.json(); assert.equal(JSON.stringify(body).includes(password), false);
      const users = await pool.query("SELECT * FROM app_users WHERE normalized_email=$1", [c.email]);
      assert.equal(users.rowCount, 1); assert.ok(users.rows[0].email_verified_at);
      const before = (await store.getCredentialPrincipal(c.email)).passwordHash;
      await pool.query("UPDATE security_mail_sends SET requested_at=requested_at-interval '61 seconds'");
      mailbox.delete(c.email); const suppressed = await challenge(c.email);
      assert.equal(mailbox.has(c.email), false);
      await reject(suppressed);
      assert.equal((await store.getCredentialPrincipal(c.email)).passwordHash, before);
    });
    await t.test("wrong, expired, cross-email, cross-purpose and different-browser proofs fail", async () => {
      const c = await challenge("mismatch@example.com");
      await reject(c, { code: c.code === "999999" ? "111111" : "999999" });
      await reject(c, { email: "different@example.com" });
      await reject(c, { purpose: "password-reset" });
      await reject(c, {}, "__Host-dufesh_registration=" + "A".repeat(43));
      await pool.query("UPDATE registration_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [c.id]);
      await reject(c);
    });
    await t.test("five failures persist across resend, instances and limiter restart; old code invalidated", async () => {
      const c = await challenge("attempts@example.com");
      for (let i = 0; i < 5; i += 1) await reject(c, { code: c.code === "999999" ? "111111" : "999999" });
      await pool.query("UPDATE security_mail_sends SET requested_at=requested_at-interval '61 seconds'");
      const resend = await challenge(c.email); await reject(c);
      const response = await post("/api/auth/register", submission(resend), resend.cookie, await start());
      assert.equal(response.status, 400);
      const attempts = await pool.query("SELECT attempts FROM registration_email_attempts WHERE email_digest=$1", [tokenDigest(`mail:${c.email}`, config.tokenPepper)]);
      assert.equal(attempts.rows[0].attempts, 5);
    });
    await t.test("resend invalidates a usable old code without consuming the new code", async () => {
      const old = await challenge("resend@example.com");
      await pool.query("UPDATE security_mail_sends SET requested_at=requested_at-interval '61 seconds'");
      const newer = await challenge(old.email); await reject(old);
      assert.equal((await post("/api/auth/register", submission(newer), newer.cookie)).status, 201);
    });
    await t.test("SMTP failure, state-storage failure and user insertion failure never create users", async () => {
      const logs = []; const original = console.error; console.error = (...args) => logs.push(args.join(" "));
      try {
        mailFails = true; const failed = await challenge("mail-failure@example.com"); await reject(failed); mailFails = false;
        const broken = await start({}, { ...store, async createRegistrationChallenge() { throw new Error("SENSITIVE-SMTP-PASSWORD"); } });
        const unavailable = await post("/api/auth/register/challenge", { email: "store-failure@example.com" }, "", broken);
        assert.equal(unavailable.status, 503); assert.deepEqual(await unavailable.json(), { error: "service_unavailable" });
        const c = await challenge("rollback@example.com");
        // A constraint failure after consuming the challenge rolls everything back.
        await pool.query(`CREATE FUNCTION security_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.normalized_email='rollback@example.com' THEN RAISE EXCEPTION 'SENSITIVE-PASSWORD'; END IF; RETURN NEW; END $$`);
        await pool.query("CREATE TRIGGER security_test_failure BEFORE INSERT ON app_users FOR EACH ROW EXECUTE FUNCTION security_test_failure()");
        const failedInsert = await post("/api/auth/register", submission(c), c.cookie); assert.equal(failedInsert.status, 503);
        assert.equal((await pool.query("SELECT consumed_at FROM registration_challenges WHERE id=$1", [c.id])).rows[0].consumed_at, null);
        await pool.query("DROP TRIGGER security_test_failure ON app_users"); await pool.query("DROP FUNCTION security_test_failure()");
        assert.equal((await post("/api/auth/register", submission(c), c.cookie)).status, 201);
        assert.doesNotMatch(logs.join("\n"), /SENSITIVE|synthetic-sensitive|\d{6}/u);
      } finally { console.error = original; mailFails = false; }
    });
    await t.test("mail reservations combine recipient, global budgets, cooldown and concurrency", async () => {
      await pool.query("UPDATE security_mail_sends SET status='failed'");
      const policy = { ...REGISTRATION_POLICY, globalHourly: 100, globalDaily: 100, emailHourly: 2, emailDaily: 3 };
      const digest = hash("budget@example.com");
      const first = await store.reserveSecurityMail({ recipientDigest: digest, policy }); assert.ok(first);
      assert.equal(await store.reserveSecurityMail({ recipientDigest: digest, policy }), null);
      await store.finishSecurityMail({ sendId: first, delivered: false });
      await pool.query("UPDATE security_mail_sends SET requested_at=requested_at-interval '61 seconds'");
      const second = await store.reserveSecurityMail({ recipientDigest: digest, policy }); assert.ok(second);
      await store.finishSecurityMail({ sendId: second, delivered: false });
      await pool.query("UPDATE security_mail_sends SET requested_at=requested_at-interval '61 seconds'");
      assert.equal(await store.reserveSecurityMail({ recipientDigest: digest, policy }), null);
      await pool.query("UPDATE security_mail_sends SET requested_at=requested_at-interval '1 hour' WHERE recipient_digest=$1", [digest]);
      const third = await store.reserveSecurityMail({ recipientDigest: digest, policy }); assert.ok(third);
      await store.finishSecurityMail({ sendId: third, delivered: false });
      await pool.query("UPDATE security_mail_sends SET requested_at=requested_at-interval '61 seconds'");
      assert.equal(await store.reserveSecurityMail({ recipientDigest: digest, policy }), null);
      assert.equal(await store.reserveSecurityMail({ recipientDigest: hash("global"), policy: { ...policy, globalDaily: 1 } }), null);
      const leases = await Promise.all([store.reserveSecurityMail({ recipientDigest: hash("lease1") }), store.reserveSecurityMail({ recipientDigest: hash("lease2") })]);
      assert.ok(leases.every(Boolean));
      assert.equal(await store.reserveSecurityMail({ recipientDigest: hash("lease3") }), null);
      for (const sendId of leases) await store.finishSecurityMail({ sendId, delivered: false });
    });
    await t.test("shared account login quotas cannot be reset by forged headers or server recreation", async () => {
      for (let i = 0; i < 10; i += 1) {
        assert.equal((await post("/api/auth/login", { identifier: "brute@example.com", password: "wrong" }, "", i % 2 ? other : base,
          { "X-Forwarded-For": `192.0.2.${i}` })).status, 401);
      }
      assert.equal((await post("/api/auth/login", { identifier: "brute@example.com", password: "wrong" }, "", await start())).status, 429);
      assert.equal((await post("/api/auth/login", { identifier: "another-student@example.com", password: "wrong" })).status, 401);
    });
    await t.test("HTTPS enforcement, no-store responses and legacy accounts survive additive migration", async () => {
      const strict = await start({ requireHttps: true });
      assert.equal((await post("/api/auth/login", { identifier: "legacy", password: "old" }, "", strict, { "X-Forwarded-Proto": "https" })).status, 403);
      const response = await fetch(base + "/api/auth/sync"); assert.equal(response.status, 401);
      assert.match(response.headers.get("cache-control"), /no-store/u);
      await pool.query("INSERT INTO app_users(username,normalized_username,email,normalized_email,registered_via) VALUES('legacy','legacy','legacy@example.com','legacy@example.com','password')");
      const legacy = await pool.query("SELECT id,email_verified_at FROM app_users WHERE normalized_username='legacy'");
      assert.equal(legacy.rows[0].email_verified_at, null);
      await pool.query("INSERT INTO password_credentials(user_id,password_hash) VALUES($1,$2)", [legacy.rows[0].id, await fakePasswords.hash("old")]);
      const login = await post("/api/auth/login", { identifier: "legacy", password: "old" }); assert.equal(login.status, 200);
      const principal = await store.getCredentialPrincipal("legacy");
      await pool.query("UPDATE password_credentials SET password_hash=$2 WHERE user_id=$1", [principal.id, await fakePasswords.hash("new-password")]);
      const device = await store.getOrCreateAnonymousDevice(hash("legacy-device"));
      await assert.rejects(store.createCredentialSession({ userId: principal.id, anonymousDeviceId: device.id, expectedPasswordHash: principal.passwordHash,
        sessionTokenHash: hash("stale-login"), sessionExpiresAt: new Date(Date.now() + 3600000) }), { code: "AUTH_CREDENTIAL_LOGIN_REJECTED" });
    });
    await t.test("expired challenge cleanup is bounded and stores neither code nor password", async () => {
      await pool.query("UPDATE registration_challenges SET expires_at=clock_timestamp()-interval '2 days'");
      await pool.query("UPDATE registration_email_attempts SET reset_at=clock_timestamp()-interval '3 days'");
      const c = await challenge("cleanup@example.com");
      const all = await pool.query("SELECT * FROM registration_challenges"); assert.equal(all.rowCount, 1);
      assert.equal(all.rows[0].code_hash, registrationDigest({ challengeId: c.id, email: c.email, code: c.code }, config.registrationKey));
      assert.equal(Object.hasOwn(all.rows[0], "code"), false); assert.equal(Object.hasOwn(all.rows[0], "password"), false);
    });
    await t.test("native PostgreSQL logging reproduces then suppresses bind-value leakage", {
      skip: !process.env.SECURITY_POSTGRES_LOG_PATH,
    }, async () => {
      const client = await pool.connect();
      const marker = `SYNTHETIC-LOG-PRIVACY-${randomUUID()}`;
      const logPath = process.env.SECURITY_POSTGRES_LOG_PATH;
      try {
        const offset = (await fs.readFile(logPath)).length;
        await client.query("SET log_min_duration_statement=0; SET log_parameter_max_length=-1");
        await client.query("SELECT $1::text, pg_sleep(0.01)", [marker]);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok((await fs.readFile(logPath)).subarray(offset).toString().includes(marker));
        const configText = await fs.readFile("ops/postgres/postgresql.conf", "utf8");
        for (const name of ["log_parameter_max_length", "log_parameter_max_length_on_error", "log_error_verbosity", "log_min_error_statement"]) {
          const value = configText.match(new RegExp(`^${name} = ([a-z0-9]+)$`, "m"))[1];
          await client.query(`SET ${name}=${value}`);
        }
        const protectedOffset = (await fs.readFile(logPath)).length;
        await client.query("SELECT $1::text, pg_sleep(0.01)", [marker]);
        await client.query("CREATE TEMP TABLE security_logging_fixture(value text UNIQUE)");
        await client.query("INSERT INTO security_logging_fixture VALUES($1)", [marker]);
        await assert.rejects(client.query("INSERT INTO security_logging_fixture VALUES($1)", [marker]), { code: "23505" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal((await fs.readFile(logPath)).subarray(protectedOffset).toString().includes(marker), false);
      } finally {
        await client.query("RESET log_min_duration_statement; RESET log_parameter_max_length; RESET log_parameter_max_length_on_error; RESET log_error_verbosity; RESET log_min_error_statement");
        client.release();
      }
    });
  } finally {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
