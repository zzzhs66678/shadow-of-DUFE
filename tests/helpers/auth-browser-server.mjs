// Mock mailbox for the isolated PostgreSQL browser suite only. Never imported
// by auth-api/src/index.mjs; all codes are random and exist only in memory.
import { createServer } from "node:http";
import { loadConfig } from "../../services/auth-api/src/config.mjs";
import { createAuthStore, createDatabasePool } from "../../services/auth-api/src/db.mjs";
import { createAuthServer } from "../../services/auth-api/src/server.mjs";
import { createPasswordService } from "../../services/auth-api/src/passwords.mjs";
import { createApiRateLimiters } from "../../services/auth-api/src/rate-limit.mjs";
import { createAvatarProcessor } from "../../services/auth-api/src/avatars.mjs";
import { createAdminSecurity } from "../../services/auth-api/src/admin-security.mjs";

if (process.env.NODE_ENV !== "test" || process.env.PGHOST !== "127.0.0.1" ||
    !/^dufesh_[a-z_]*(ci|security_test)$/u.test(process.env.POSTGRES_DB ?? "")) {
  throw new Error("Mock mailbox requires a dedicated loopback test database");
}
const config = loadConfig({ ...process.env, AUTH_REGISTRATION_MODE: "smtp",
  AUTH_REGISTRATION_HMAC_KEY: "independent-browser-fixture-key-longer-than-32chars",
  AUTH_SMTP_HOST: "smtp.qq.com", AUTH_SMTP_PORT: "465", AUTH_SMTP_SECURE: "true",
  AUTH_SMTP_USER: "2016594477@qq.com", AUTH_SMTP_PASSWORD: "synthetic-never-sent-to-smtp", AUTH_EMAIL_FROM: "2016594477@qq.com" });
const pool = createDatabasePool(config); const store = createAuthStore(pool);
await store.cleanupSecurityState();
const codes = new Map();
const auth = createAuthServer({ config, store, passwordService: createPasswordService(),
  rateLimiters: createApiRateLimiters({ store }), avatarProcessor: createAvatarProcessor(),
  adminSecurity: config.adminEnabled ? createAdminSecurity({ activeKeyId: config.adminMfaActiveKeyId,
    keyring: config.adminMfaKeys, recoveryPepper: config.adminRecoveryPepper }) : null,
  mailDelivery: { async sendRegistrationCode({ to, code, expiresAt }) {
    if (!to.endsWith("@example.com")) throw new Error("Fixture mailbox rejects real recipients");
    codes.set(to, { code, expiresAt });
  } },
});
const mailbox = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress) || request.method !== "GET") {
    response.writeHead(403).end(); return;
  }
  const email = new URL(request.url, "http://localhost").searchParams.get("email");
  const item = codes.get(email);
  const delivered = item && await pool.query("SELECT 1 FROM registration_challenges WHERE normalized_email=$1 AND delivered_at IS NOT NULL AND consumed_at IS NULL AND expires_at>clock_timestamp()", [email]);
  if (!delivered?.rowCount || item.expiresAt.getTime() <= Date.now()) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ code: item.code })); codes.delete(email);
});
auth.listen(config.port, "127.0.0.1"); mailbox.listen(Number(process.env.AUTH_TEST_MAILBOX_PORT ?? 3111), "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  mailbox.close(); auth.close(() => { void store.close().then(() => process.exit(0)); });
});
