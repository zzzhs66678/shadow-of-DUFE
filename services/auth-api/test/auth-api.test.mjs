import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSecureCookie,
  parseCookies,
  serializeSecureCookie,
} from "../src/cookies.mjs";
import { loadConfig } from "../src/config.mjs";
import { createMockWechatProvider } from "../src/providers/mock-wechat.mjs";
import { createAuthServer } from "../src/server.mjs";
import {
  createOpaqueToken,
  isOpaqueToken,
  tokenDigest,
} from "../src/tokens.mjs";

const config = {
  tokenPepper: "test-pepper-that-is-longer-than-thirty-two-characters",
  allowedOrigins: new Set(["https://dufesh.cn"]),
  sessionCookie: "__Host-dufesh_session",
  deviceCookie: "__Host-dufesh_device",
  oauthCookie: "__Host-dufesh_oauth",
  sessionMaxAgeSeconds: 2_592_000,
  deviceMaxAgeSeconds: 31_536_000,
  oauthTtlSeconds: 600,
  publicOrigin: "https://dufesh.cn",
  wechatMode: "mock",
  mockLoginSecret: "mock-secret-that-is-longer-than-thirty-two-characters",
};

function createFakeStore() {
  const devices = new Map();
  const sessions = new Map();
  const transactions = new Map();
  const identities = new Map();
  const revoked = [];

  return {
    sessions,
    revoked,
    async health() {},
    async getOrCreateAnonymousDevice(hash) {
      if (!devices.has(hash)) {
        const number = devices.size + 1;
        devices.set(hash, {
          id: `anonymous-${number}`,
          publicId: `device-${number}`,
        });
      }
      return devices.get(hash);
    },
    async createOAuthTransaction(transaction) {
      transactions.set(transaction.stateHash, {
        ...transaction,
        consumed: false,
      });
    },
    async consumeOAuthAndCreateSession(input) {
      const transaction = transactions.get(input.stateHash);
      if (
        !transaction ||
        transaction.consumed ||
        transaction.provider !== input.provider ||
        transaction.browserTokenHash !== input.browserTokenHash
      ) {
        const error = new Error("OAuth transaction is invalid");
        error.code = "AUTH_OAUTH_TRANSACTION_INVALID";
        throw error;
      }
      transaction.consumed = true;

      let userId = identities.get(
        `${input.provider}:${input.identity.subject}`,
      );
      if (!userId) {
        userId = `oauth-user-${identities.size + 1}`;
        identities.set(
          `${input.provider}:${input.identity.subject}`,
          userId,
        );
      }

      sessions.set(input.sessionTokenHash, {
        id: `oauth-session-${sessions.size + 1}`,
        userId,
        displayName: input.identity.displayName,
        avatarUrl: input.identity.avatarUrl,
        expiresAt: input.sessionExpiresAt.toISOString(),
      });

      return {
        userId,
        sessionId: `oauth-session-${sessions.size}`,
        expiresAt: input.sessionExpiresAt.toISOString(),
        returnTo: transaction.returnTo,
      };
    },
    async getActiveSession(hash) {
      return sessions.get(hash) ?? null;
    },
    async revokeSession(hash) {
      revoked.push(hash);
      sessions.delete(hash);
    },
  };
}

async function withServer(callback) {
  const store = createFakeStore();
  const wechatProvider = createMockWechatProvider(config);
  const server = createAuthServer({ store, config, wechatProvider });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    await callback({
      baseUrl: `http://127.0.0.1:${address.port}`,
      store,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("secure cookies are host-only, HttpOnly, Secure, and SameSite=Lax", () => {
  const serialized = serializeSecureCookie("__Host-test", "value", 60);
  assert.match(serialized, /^__Host-test=value;/);
  assert.match(serialized, /Path=\//);
  assert.match(serialized, /HttpOnly/);
  assert.match(serialized, /Secure/);
  assert.match(serialized, /SameSite=Lax/);
  assert.doesNotMatch(serialized, /Domain=/);
  assert.match(clearSecureCookie("__Host-test"), /Max-Age=0/);

  const parsed = parseCookies("a=1; __Host-test=value=with=equals; a=2");
  assert.equal(parsed.get("a"), "1");
  assert.equal(parsed.get("__Host-test"), "value=with=equals");
});

test("opaque tokens are random-looking and stored as peppered digests", () => {
  const token = createOpaqueToken();
  assert.equal(isOpaqueToken(token), true);
  assert.equal(token.length, 43);
  assert.notEqual(tokenDigest(token, config.tokenPepper), token);
  assert.equal(tokenDigest(token, config.tokenPepper).length, 64);
});

test("production configuration requires database and token secrets", () => {
  assert.throws(
    () => loadConfig({ AUTH_TOKEN_PEPPER: config.tokenPepper }),
    /POSTGRES_PASSWORD is required/,
  );
  assert.throws(
    () => loadConfig({ POSTGRES_PASSWORD: "database-secret" }),
    /AUTH_TOKEN_PEPPER/,
  );

  const loaded = loadConfig({
    AUTH_TOKEN_PEPPER: config.tokenPepper,
    POSTGRES_PASSWORD: "database-secret",
    AUTH_DB_POOL_MAX: "999",
  });
  assert.equal(loaded.poolMax, 20);
});

test("anonymous device cookie is stable and an invalid session is cleared", async () => {
  await withServer(async ({ baseUrl }) => {
    const firstResponse = await fetch(`${baseUrl}/api/auth/session`);
    const first = await firstResponse.json();
    const deviceCookie = firstResponse.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${config.deviceCookie}=`));

    assert.equal(first.authenticated, false);
    assert.ok(first.deviceId);
    assert.ok(deviceCookie);

    const cookiePair = deviceCookie.split(";", 1)[0];
    const secondResponse = await fetch(`${baseUrl}/api/auth/session`, {
      headers: {
        Cookie: `${cookiePair}; ${config.sessionCookie}=invalid`,
      },
    });
    const second = await secondResponse.json();

    assert.equal(second.deviceId, first.deviceId);
    assert.equal(second.authenticated, false);
    assert.ok(
      secondResponse.headers
        .getSetCookie()
        .some((value) =>
          value.startsWith(`${config.sessionCookie}=;`) &&
          value.includes("Max-Age=0"),
        ),
    );
  });
});

test("active sessions authenticate and trusted logout revokes them", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const sessionToken = createOpaqueToken();
    const sessionHash = tokenDigest(sessionToken, config.tokenPepper);
    store.sessions.set(sessionHash, {
      id: "session-1",
      userId: "user-1",
      displayName: "测试同学",
      avatarUrl: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const authenticatedResponse = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: `${config.sessionCookie}=${sessionToken}` },
    });
    const authenticated = await authenticatedResponse.json();
    assert.equal(authenticated.authenticated, true);
    assert.equal(authenticated.user.id, "user-1");

    const rejected = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.invalid",
        Cookie: `${config.sessionCookie}=${sessionToken}`,
      },
    });
    assert.equal(rejected.status, 403);
    assert.equal(store.revoked.length, 0);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        Origin: "https://dufesh.cn",
        Cookie: `${config.sessionCookie}=${sessionToken}`,
      },
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(store.revoked, [sessionHash]);
  });
});

test("mock OAuth binds state to the browser, reuses identity, and blocks replay", async () => {
  await withServer(async ({ baseUrl }) => {
    const forwardedHeaders = {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "dufesh.cn",
      "X-Dufesh-Mock-Secret": config.mockLoginSecret,
    };

    async function completeLogin(subject) {
      const start = await fetch(
        `${baseUrl}/api/auth/wechat/start?returnTo=%2Fmy%3Ftab%3Dsync`,
        { headers: forwardedHeaders, redirect: "manual" },
      );
      assert.equal(start.status, 302);

      const startCookies = start.headers.getSetCookie();
      const deviceCookie = startCookies
        .find((value) => value.startsWith(`${config.deviceCookie}=`))
        .split(";", 1)[0];
      const oauthCookie = startCookies
        .find((value) => value.startsWith(`${config.oauthCookie}=`))
        .split(";", 1)[0];

      const authorizeUrl = new URL(start.headers.get("location"));
      const authorize = await fetch(
        `${baseUrl}${authorizeUrl.pathname}${authorizeUrl.search}`,
        {
          headers: {
            "X-Dufesh-Mock-Secret": config.mockLoginSecret,
            "X-Dufesh-Mock-Subject": subject,
          },
          redirect: "manual",
        },
      );
      assert.equal(authorize.status, 302);

      const callbackUrl = new URL(authorize.headers.get("location"));
      const callbackPath = `${callbackUrl.pathname}${callbackUrl.search}`;
      const callback = await fetch(`${baseUrl}${callbackPath}`, {
        headers: { Cookie: `${deviceCookie}; ${oauthCookie}` },
        redirect: "manual",
      });
      assert.equal(callback.status, 302);
      assert.equal(
        callback.headers.get("location"),
        "https://dufesh.cn/my?tab=sync",
      );

      const sessionCookie = callback.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${config.sessionCookie}=`))
        .split(";", 1)[0];
      const session = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Cookie: `${deviceCookie}; ${sessionCookie}` },
      });
      const sessionPayload = await session.json();
      assert.equal(sessionPayload.authenticated, true);

      const replay = await fetch(`${baseUrl}${callbackPath}`, {
        headers: { Cookie: `${deviceCookie}; ${oauthCookie}` },
        redirect: "manual",
      });
      assert.equal(replay.status, 400);

      return sessionPayload.user.id;
    }

    const firstUserId = await completeLogin("same-wechat-user");
    const secondUserId = await completeLogin("same-wechat-user");
    assert.equal(secondUserId, firstUserId);

    const forbidden = await fetch(`${baseUrl}/api/auth/wechat/start`, {
      headers: {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "dufesh.cn",
      },
      redirect: "manual",
    });
    assert.equal(forbidden.status, 403);
  });
});
