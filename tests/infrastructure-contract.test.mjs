import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("PostgreSQL is private, resource-limited, health-checked, and log-rotated", async () => {
  const compose = await read("docker-compose.yml");

  assert.match(compose, /postgres:/);
  assert.match(compose, /expose:\s*\n\s*- "5432"/);
  assert.doesNotMatch(compose, /ports:\s*\n\s*-\s*"5432:5432"/);
  assert.match(compose, /mem_limit: 384m/);
  assert.match(compose, /pg_isready/);
  assert.match(compose, /max-size: "10m"/);
});

test("identity foundation keeps OAuth identities, devices, and sessions separate", async () => {
  const migration = await read("ops/postgres/migrations/0001_identity_foundation.sql");

  for (const table of ["app_users", "oauth_identities", "user_devices", "user_sessions"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(migration, /UNIQUE \(provider, provider_subject\)/);
  assert.match(migration, /UNIQUE \(token_hash\)/);
  assert.match(migration, /ON DELETE CASCADE/);
});

test("backup and disk protection have bounded local retention", async () => {
  const backup = await read("ops/postgres/backup.sh");
  const guard = await read("ops/maintenance/disk-guard.sh");

  assert.match(backup, /LOCAL_KEEP="\$\{LOCAL_KEEP:-1\}"/);
  assert.match(backup, /MAX_DISK_PERCENT="\$\{MAX_DISK_PERCENT:-85\}"/);
  assert.match(backup, /COMPOSE_PROJECT_NAME="\$\{COMPOSE_PROJECT_NAME:-dufesh\}"/);
  assert.match(backup, /ossutil stat/);
  assert.match(guard, /docker builder prune/);
  assert.match(guard, /disk-critical/);
});

test("auth API is private, pooled, health-checked, and routed on the same origin", async () => {
  const compose = await read("docker-compose.yml");
  const caddy = await read("deploy/Caddyfile");
  const database = await read("services/auth-api/src/db.mjs");

  assert.match(compose, /auth-api:/);
  assert.match(compose, /expose:\s*\n\s*- "3100"/);
  assert.doesNotMatch(compose, /ports:\s*\n\s*-\s*"3100:3100"/);
  assert.match(compose, /mem_limit: 128m/);
  assert.match(compose, /read_only: true/);
  assert.match(caddy, /handle \/api\/auth\/\*/);
  assert.match(caddy, /reverse_proxy auth-api:3100/);
  assert.match(database, /max: config\.poolMax/);
  assert.match(database, /connectionTimeoutMillis: 3_000/);
});

test("OAuth transactions are one-time, browser-bound, and store only digests", async () => {
  const migration = await read(
    "ops/postgres/migrations/0003_oauth_transactions.sql",
  );
  const server = await read("services/auth-api/src/server.mjs");
  const provider = await read(
    "services/auth-api/src/providers/mock-wechat.mjs",
  );

  assert.match(migration, /state_hash text NOT NULL/);
  assert.match(migration, /browser_token_hash text NOT NULL/);
  assert.match(migration, /consumed_at timestamptz/);
  assert.doesNotMatch(migration, /\bstate_token\b|\bbrowser_token\b/);
  assert.match(server, /AUTH_OAUTH_TRANSACTION_INVALID/);
  assert.match(server, /x-dufesh-mock-secret/);
  assert.match(provider, /timingSafeEqual/);
  assert.match(provider, /createHmac\("sha256"/);
});

test("personal cloud data keeps stable client IDs, revisions, and tombstones", async () => {
  const migration = await read(
    "ops/postgres/migrations/0004_personal_cloud_data.sql",
  );

  for (const table of [
    "user_sync_states",
    "user_profiles",
    "timetable_plans",
    "timetable_plan_schedules",
    "personal_activities",
    "user_assignments",
    "user_settings",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(migration, /CREATE OR REPLACE FUNCTION next_user_revision/);
  assert.match(migration, /UNIQUE \(user_id, client_id\)/);
  assert.match(migration, /UNIQUE \(plan_id, schedule_id\)/);
  assert.match(migration, /deleted_at timestamptz/);
  assert.match(migration, /source IN \('manual', 'class_import'\)/);
  assert.match(migration, /preferred_term IN \('fall', 'spring'\)/);
  assert.match(migration, /color IN \('red', 'blue', 'green', 'amber'\)/);
});
