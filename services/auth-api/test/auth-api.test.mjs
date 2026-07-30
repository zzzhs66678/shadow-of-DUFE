import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSecureCookie,
  parseCookies,
  serializeSecureCookie,
} from "../src/cookies.mjs";
import { loadConfig } from "../src/config.mjs";
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
  sessionMaxAgeSeconds: 2_592_000,
  deviceMaxAgeSeconds: 31_536_000,
};

function createFakeStore() {
  const devices = new Map();
  const sessions = new Map();
  const revoked = [];

  return {
    sessions,
    revoked,
    async health() {},
    async getOrCreateAnonymousDevice(hash) {
      if (!devices.has(hash)) devices.set(hash, `device-${devices.size + 1}`);
      return devices.get(hash);
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
  const server = createAuthServer({ store, config });
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
