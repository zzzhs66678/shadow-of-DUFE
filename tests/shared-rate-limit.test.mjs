import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { createAuthStore } from "../services/auth-api/src/db.mjs";
import { createSharedTokenBucket } from "../services/auth-api/src/rate-limit.mjs";

const digest = (character) => character.repeat(64);

async function sharedStore() {
  const database = new PGlite();
  await database.waitReady;
  await database.exec(
    await fs.readFile(
      new URL("../ops/postgres/migrations/0016_shared_rate_limits.sql", import.meta.url),
      "utf8",
    ),
  );
  const pool = {
    async query(statement, values) {
      const result = await database.query(statement, values);
      return { ...result, rowCount: result.rows.length };
    },
    async end() {
      await database.close();
    },
  };
  return { database, store: createAuthStore(pool) };
}

test("shared limiter atomically enforces one quota across instances and restarts", async () => {
  const { database, store } = await sharedStore();
  try {
    const options = {
      store,
      scope: "credential-test",
      capacity: 5,
      refillPerSecond: 1e-9,
    };
    const instanceA = createSharedTokenBucket(options);
    const instanceB = createSharedTokenBucket(options);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? instanceA : instanceB).consume(digest("a")),
      ),
    );
    assert.equal(attempts.filter(Boolean).length, 5);

    const restartedInstance = createSharedTokenBucket(options);
    assert.equal(await restartedInstance.consume(digest("a")), false);

    const rows = await database.query(
      `SELECT scope, octet_length(key_digest) AS digest_bytes
       FROM api_rate_limit_buckets`,
    );
    assert.deepEqual(rows.rows, [
      { scope: "credential-test", digest_bytes: 32 },
    ]);
  } finally {
    await store.close();
  }
});

test("shared limiter isolates account, IP, and operation scope digests", async () => {
  const { store } = await sharedStore();
  try {
    const base = {
      store,
      capacity: 1,
      refillPerSecond: 1e-9,
    };
    const credential = createSharedTokenBucket({
      ...base,
      scope: "credential-test",
    });
    const reset = createSharedTokenBucket({
      ...base,
      scope: "password-reset-test",
    });

    assert.equal(await credential.consume(digest("a")), true);
    assert.equal(await credential.consume(digest("a")), false);
    assert.equal(await credential.consume(digest("b")), true);
    assert.equal(await reset.consume(digest("a")), true);
  } finally {
    await store.close();
  }
});

test("shared limiter fails closed when its database decision is unavailable", async () => {
  const unavailable = createSharedTokenBucket({
    store: {
      async consumeRateLimit() {
        throw new Error("database unavailable");
      },
    },
    scope: "credential-test",
    capacity: 1,
    refillPerSecond: 1,
  });

  await assert.rejects(unavailable.consume(digest("a")), /database unavailable/);
  await assert.rejects(unavailable.consume("raw-ip-address"), /SHA-256 digest/);
});
