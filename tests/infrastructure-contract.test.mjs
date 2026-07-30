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
