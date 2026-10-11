// Dedicated localhost-only verification. Every credential below is synthetic.
import { defineConfig } from "@playwright/test";
import base from "./playwright.postgres.config";

const env = {
  NODE_ENV: "test", PGHOST: "127.0.0.1", PGPORT: "55439",
  POSTGRES_DB: process.env.RECOVERY_TEST_DB ?? "dufesh_production_ci", POSTGRES_USER: "dufesh_security_owner",
  POSTGRES_PASSWORD: "synthetic-loopback-fixture",
  AUTH_DB_USER: process.env.RECOVERY_RUNTIME_USER ?? "dufesh_security_owner",
  AUTH_DB_PASSWORD: process.env.RECOVERY_RUNTIME_PASSWORD ?? "synthetic-loopback-fixture",
  AUTH_API_PORT: "33137", AUTH_TEST_MAILBOX_PORT: "33138",
  AUTH_TEST_MAILBOX_URL: "http://127.0.0.1:33138",
  AUTH_ALLOWED_ORIGINS: "http://localhost:33139", AUTH_PUBLIC_ORIGIN: "https://dufesh.cn",
  AUTH_TOKEN_PEPPER: "synthetic-production-browser-token-pepper-32chars",
  AUTH_WECHAT_MODE: "disabled", AUTH_PASSWORD_RESET_MODE: "response", AUTH_EMAIL_VERIFICATION_MODE: "response",
  AUTH_ADMIN_ENABLED: "true", AUTH_ADMIN_MFA_ACTIVE_KEY_ID: "ci-key",
  AUTH_ADMIN_MFA_KEYS: JSON.stringify({ "ci-key": Buffer.alloc(32, 0x44).toString("base64") }),
  AUTH_ADMIN_RECOVERY_PEPPER: "synthetic-production-browser-recovery-pepper-32chars",
  AUTH_API_DEV_TARGET: "http://127.0.0.1:33137",
};
Object.assign(process.env, env);
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: "http://localhost:33139" },
  webServer: [
    { command: "node tests/helpers/auth-browser-server.mjs", url: "http://127.0.0.1:33137/api/auth/health", env, timeout: 30_000 },
    { command: "node node_modules/vinext/dist/cli.js dev --host 127.0.0.1 --port 33139", url: "http://localhost:33139", env, timeout: 90_000 },
  ],
});
