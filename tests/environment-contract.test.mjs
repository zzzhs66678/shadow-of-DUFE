import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

function parseExample(source) {
  const entries = new Map();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    assert.notEqual(separator, -1, `invalid environment line: ${line}`);
    const key = line.slice(0, separator);
    assert.match(key, /^[A-Z][A-Z0-9_]*$/u);
    assert.equal(entries.has(key), false, `duplicate environment key: ${key}`);
    entries.set(key, line.slice(separator + 1));
  }
  return entries;
}

function sourceEnvironmentKeys(source, pattern) {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

test("production environment templates fail closed without real secrets", async () => {
  const auth = parseExample(await read("services/auth-api/auth.env.example"));
  const postgres = parseExample(await read("ops/postgres/postgres.env.example"));
  const xiaoying = parseExample(
    await read("xiaoying-executor/xiaoying.env.example"),
  );
  const backup = parseExample(await read("ops/postgres/backup.env.example"));
  const combined = [auth, postgres, xiaoying, backup]
    .flatMap((entries) => [...entries.entries()])
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  for (const [entries, keys] of [
    [auth, ["AUTH_TOKEN_PEPPER", "AUTH_ADMIN_RECOVERY_PEPPER", "AUTH_MOCK_LOGIN_SECRET"]],
    [postgres, ["POSTGRES_PASSWORD", "MIGRATION_DB_PASSWORD", "AUTH_DB_PASSWORD", "IMPORT_DB_PASSWORD", "BACKUP_DB_PASSWORD"]],
    [xiaoying, ["XIAOYING_MASTER_KEY", "XIAOYING_DEFAULT_INVITE_CODE"]],
  ]) {
    for (const key of keys) assert.equal(entries.get(key), "", `${key} must be blank`);
  }

  assert.equal(auth.get("AUTH_WECHAT_MODE"), "disabled");
  assert.equal(auth.get("AUTH_ADMIN_ENABLED"), "false");
  assert.equal(auth.get("AUTH_ADMIN_MFA_KEYS"), "{}");
  assert.doesNotMatch(combined, /replace-with|change-me|example-secret/iu);
});

test("service environment reads are owned by an example or Compose", async () => {
  const authConfig = await read("services/auth-api/src/config.mjs");
  const xiaoyingServer = await read("xiaoying-executor/bin/server.mjs");
  const compose = await read("docker-compose.yml");
  const authExample = parseExample(
    await read("services/auth-api/auth.env.example"),
  );
  const postgresExample = parseExample(
    await read("ops/postgres/postgres.env.example"),
  );
  const xiaoyingExample = parseExample(
    await read("xiaoying-executor/xiaoying.env.example"),
  );
  const composeKeys = new Set([
    ...sourceEnvironmentKeys(compose, /^\s+([A-Z][A-Z0-9_]+):/gmu),
    ...sourceEnvironmentKeys(compose, /\$\{([A-Z][A-Z0-9_]*)/gu),
  ]);
  const authOwned = new Set([
    ...authExample.keys(),
    ...postgresExample.keys(),
    ...composeKeys,
  ]);
  const xiaoyingOwned = new Set([...xiaoyingExample.keys(), ...composeKeys]);

  for (const key of sourceEnvironmentKeys(authConfig, /\benv\.([A-Z][A-Z0-9_]*)/gu)) {
    assert.equal(authOwned.has(key), true, `undocumented auth variable: ${key}`);
  }
  for (const key of sourceEnvironmentKeys(
    xiaoyingServer,
    /process\.env\.([A-Z][A-Z0-9_]*)/gu,
  )) {
    assert.equal(
      xiaoyingOwned.has(key),
      true,
      `undocumented Xiaoying variable: ${key}`,
    );
  }
  assert.doesNotMatch(xiaoyingServer, /XIAOYING_EXECUTOR_TOKEN/);
});

test("release documentation names every canonical environment template", async () => {
  const readme = await read("README.md");
  const workflow = await read(".github/workflows/quality.yml");

  for (const template of [
    "ops/postgres/postgres.env.example",
    "services/auth-api/auth.env.example",
    "xiaoying-executor/xiaoying.env.example",
    "ops/postgres/backup.env.example",
  ]) {
    assert.match(readme, new RegExp(template.replaceAll("/", "\\/")));
  }
  assert.match(readme, /权限设为 `600`/u);
  assert.match(workflow, /node --test tests\/environment-contract\.test\.mjs/);
});
