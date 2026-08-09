import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

const enabled = process.env.POSTGRES_INTEGRATION === "true";
const { Pool } = pg;

function poolFor(user, password) {
  return new Pool({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.POSTGRES_DB,
    user,
    password,
    max: 20,
    connectionTimeoutMillis: 3_000,
    query_timeout: 10_000,
  });
}

async function denied(pool, statement) {
  await assert.rejects(
    pool.query(statement),
    (error) => error?.code === "42501",
  );
}

test("PostgreSQL 17 migrations and role boundaries hold under runtime traffic", {
  skip: !enabled,
  timeout: 30_000,
}, async () => {
  const owner = poolFor(process.env.POSTGRES_USER, process.env.POSTGRES_PASSWORD);
  const runtime = poolFor(process.env.AUTH_DB_USER, process.env.AUTH_DB_PASSWORD);
  const importer = poolFor(process.env.IMPORT_DB_USER, process.env.IMPORT_DB_PASSWORD);
  const digestA = Buffer.alloc(32, 0x41);
  const digestB = Buffer.alloc(32, 0x42);

  try {
    const version = await owner.query("SHOW server_version_num");
    assert.equal(Number(version.rows[0].server_version_num) >= 170000, true);

    const migrations = await owner.query(
      "SELECT count(*)::integer AS count FROM schema_migrations",
    );
    assert.equal(migrations.rows[0].count, 16);

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        runtime.query(
          `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
          ["ci-credential", digestA, 5, 1e-9],
        ),
      ),
    );
    assert.equal(
      attempts.filter((result) => result.rows[0].allowed).length,
      5,
    );

    await runtime.end();
    const restartedRuntime = poolFor(
      process.env.AUTH_DB_USER,
      process.env.AUTH_DB_PASSWORD,
    );
    try {
      const persisted = await restartedRuntime.query(
        `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
        ["ci-credential", digestA, 5, 1e-9],
      );
      assert.equal(persisted.rows[0].allowed, false);
      const separateKey = await restartedRuntime.query(
        `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
        ["ci-credential", digestB, 5, 1e-9],
      );
      const separateScope = await restartedRuntime.query(
        `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
        ["ci-password-reset", digestA, 5, 1e-9],
      );
      assert.equal(separateKey.rows[0].allowed, true);
      assert.equal(separateScope.rows[0].allowed, true);
      await denied(
        restartedRuntime,
        "SELECT * FROM api_rate_limit_buckets LIMIT 1",
      );
      await denied(
        restartedRuntime,
        "UPDATE admin_audit_events SET action = action",
      );
    } finally {
      await restartedRuntime.end();
    }

    await denied(importer, "SELECT * FROM app_users LIMIT 1");
    await denied(importer, "SELECT * FROM user_sessions LIMIT 1");
    await denied(importer, "SELECT * FROM teacher_review_candidate_decisions LIMIT 1");
    await denied(
      importer,
      `SELECT consume_api_rate_limit(
         'ci-importer-denied',
         decode(repeat('43', 32), 'hex'),
         1,
         1
       )`,
    );
  } finally {
    await Promise.allSettled([owner.end(), runtime.end(), importer.end()]);
  }
});
