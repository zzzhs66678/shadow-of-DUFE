export function createTokenBucket({
  capacity,
  refillPerSecond,
  maxKeys = 10_000,
  idleTtlMs = 10 * 60_000,
}) {
  const buckets = new Map();
  let requestsSinceCleanup = 0;

  function cleanup(now) {
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastSeenAt > idleTtlMs) buckets.delete(key);
    }
    while (buckets.size > maxKeys) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey === undefined) break;
      buckets.delete(oldestKey);
    }
  }

  function remember(key, bucket) {
    buckets.delete(key);
    buckets.set(key, bucket);
    while (buckets.size > maxKeys) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey === undefined) break;
      buckets.delete(oldestKey);
    }
  }

  return {
    consume(key, now = Date.now()) {
      requestsSinceCleanup += 1;
      if (requestsSinceCleanup >= 500) {
        cleanup(now);
        requestsSinceCleanup = 0;
      }

      const current = buckets.get(key);
      const elapsedSeconds = current
        ? Math.max(0, now - current.updatedAt) / 1000
        : 0;
      const tokens = current
        ? Math.min(
            capacity,
            current.tokens + elapsedSeconds * refillPerSecond,
          )
        : capacity;

      if (tokens < 1) {
        remember(key, {
          tokens,
          updatedAt: now,
          lastSeenAt: now,
        });
        return false;
      }

      remember(key, {
        tokens: tokens - 1,
        updatedAt: now,
        lastSeenAt: now,
      });
      return true;
    },

    size() {
      return buckets.size;
    },
  };
}

export function createApiRateLimiters() {
  return {
    read: createTokenBucket({
      capacity: 2_400,
      refillPerSecond: 40,
    }),
    write: createTokenBucket({
      capacity: 300,
      refillPerSecond: 5,
    }),
    credential: createTokenBucket({
      capacity: 10,
      refillPerSecond: 1 / 12,
      maxKeys: 20_000,
      idleTtlMs: 30 * 60_000,
    }),
    passwordReset: createTokenBucket({
      capacity: 4,
      refillPerSecond: 1 / 60,
      maxKeys: 20_000,
      idleTtlMs: 60 * 60_000,
    }),
    emailVerification: createTokenBucket({
      capacity: 4,
      refillPerSecond: 1 / 120,
      maxKeys: 20_000,
      idleTtlMs: 2 * 60 * 60_000,
    }),
    upload: createTokenBucket({
      capacity: 10,
      refillPerSecond: 1 / 300,
      maxKeys: 20_000,
      idleTtlMs: 2 * 60 * 60_000,
    }),
    communityWrite: createTokenBucket({
      capacity: 12,
      refillPerSecond: 1 / 20,
      maxKeys: 30_000,
      idleTtlMs: 2 * 60 * 60_000,
    }),
    adminMfa: createTokenBucket({
      capacity: 5,
      refillPerSecond: 1 / 60,
      maxKeys: 10_000,
      idleTtlMs: 2 * 60 * 60_000,
    }),
  };
}
