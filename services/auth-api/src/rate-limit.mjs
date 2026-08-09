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

export function createSharedTokenBucket({
  store,
  scope,
  capacity,
  refillPerSecond,
}) {
  if (!store || typeof store.consumeRateLimit !== "function") {
    throw new TypeError("shared rate limiting requires a persistent store");
  }
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(scope)) {
    throw new TypeError("shared rate limit scope is invalid");
  }
  if (!Number.isFinite(capacity) || capacity < 1) {
    throw new TypeError("shared rate limit capacity is invalid");
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new TypeError("shared rate limit refill rate is invalid");
  }

  return {
    async consume(key) {
      if (typeof key !== "string" || !/^[0-9a-f]{64}$/u.test(key)) {
        throw new TypeError("shared rate limit key must be a SHA-256 digest");
      }
      return store.consumeRateLimit({
        scope,
        keyDigest: key,
        capacity,
        refillPerSecond,
      });
    },
  };
}

function persistentOrLocal(store, options) {
  if (!store) return createTokenBucket(options);
  return createSharedTokenBucket({ store, ...options });
}

export function createApiRateLimiters({ store } = {}) {
  return {
    read: createTokenBucket({
      capacity: 2_400,
      refillPerSecond: 40,
    }),
    write: createTokenBucket({
      capacity: 300,
      refillPerSecond: 5,
    }),
    credential: persistentOrLocal(store, {
      scope: "credential",
      capacity: 10,
      refillPerSecond: 1 / 12,
      maxKeys: 20_000,
      idleTtlMs: 30 * 60_000,
    }),
    passwordReset: persistentOrLocal(store, {
      scope: "password-reset",
      capacity: 4,
      refillPerSecond: 1 / 60,
      maxKeys: 20_000,
      idleTtlMs: 60 * 60_000,
    }),
    emailVerification: persistentOrLocal(store, {
      scope: "email-verification",
      capacity: 4,
      refillPerSecond: 1 / 120,
      maxKeys: 20_000,
      idleTtlMs: 2 * 60 * 60_000,
    }),
    upload: persistentOrLocal(store, {
      scope: "avatar-upload",
      capacity: 10,
      refillPerSecond: 1 / 300,
      maxKeys: 20_000,
      idleTtlMs: 2 * 60 * 60_000,
    }),
    communityWrite: persistentOrLocal(store, {
      scope: "community-write",
      capacity: 12,
      refillPerSecond: 1 / 20,
      maxKeys: 30_000,
      idleTtlMs: 2 * 60 * 60_000,
    }),
    communityReaction: persistentOrLocal(store, {
      scope: "community-reaction",
      capacity: 60,
      refillPerSecond: 1,
      maxKeys: 30_000,
      idleTtlMs: 60 * 60_000,
    }),
    communityReport: persistentOrLocal(store, {
      scope: "community-report",
      capacity: 5,
      refillPerSecond: 1 / 300,
      maxKeys: 30_000,
      idleTtlMs: 6 * 60 * 60_000,
    }),
    adminMfa: persistentOrLocal(store, {
      scope: "admin-mfa",
      capacity: 5,
      refillPerSecond: 1 / 60,
      maxKeys: 10_000,
      idleTtlMs: 2 * 60 * 60_000,
    }),
    teacherReviewModeration: persistentOrLocal(store, {
      scope: "teacher-review-moderation",
      capacity: 30,
      refillPerSecond: 1 / 10,
      maxKeys: 10_000,
      idleTtlMs: 2 * 60 * 60_000,
    }),
    teacherReviewWrite: persistentOrLocal(store, {
      scope: "teacher-review-write",
      capacity: 6,
      refillPerSecond: 1 / 300,
      maxKeys: 30_000,
      idleTtlMs: 6 * 60 * 60_000,
    }),
  };
}
