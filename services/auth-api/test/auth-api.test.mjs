import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  clearSecureCookie,
  parseCookies,
  serializeSecureCookie,
} from "../src/cookies.mjs";
import { loadConfig } from "../src/config.mjs";
import { createMockWechatProvider } from "../src/providers/mock-wechat.mjs";
import { createAvatarProcessor } from "../src/avatars.mjs";
import { createTokenBucket } from "../src/rate-limit.mjs";
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
  credentialsEnabled: true,
  passwordResetMode: "response",
  passwordResetTtlSeconds: 1_800,
  wechatMode: "mock",
  mockLoginSecret: "mock-secret-that-is-longer-than-thirty-two-characters",
};

function createFakeStore() {
  const devices = new Map();
  const sessions = new Map();
  const transactions = new Map();
  const identities = new Map();
  const credentialPrincipals = new Map();
  const passwordResets = new Map();
  const avatars = new Map();
  const revoked = [];
  const deletedAccounts = [];
  let personalSnapshot = {
    revision: 0,
    state: {
      profile: null,
      skipped: false,
      plans: [],
      activePlanId: "",
      activities: [],
      assignments: [],
      favoriteRooms: [],
      recentRooms: [],
      preferredTerm: "fall",
      theme: "system",
    },
  };
  const syncMutations = new Map();

  return {
    sessions,
    revoked,
    deletedAccounts,
    credentialPrincipals,
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
    async registerCredentialUser(input) {
      if (credentialPrincipals.has(input.normalizedUsername)) {
        const error = new Error("username taken");
        error.code = "AUTH_USERNAME_TAKEN";
        throw error;
      }
      if (credentialPrincipals.has(input.normalizedEmail)) {
        const error = new Error("email taken");
        error.code = "AUTH_EMAIL_TAKEN";
        throw error;
      }
      const accountNumber = credentialPrincipals.size / 2 + 1;
      const id = `00000000-0000-4000-8000-${String(accountNumber).padStart(12, "0")}`;
      const principal = {
        id,
        username: input.username,
        displayName: input.username,
        email: input.email,
        schoolAccount: input.schoolAccount,
        status: "active",
        passwordHash: input.passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
      };
      credentialPrincipals.set(input.normalizedUsername, principal);
      credentialPrincipals.set(input.normalizedEmail, principal);
      sessions.set(input.sessionTokenHash, {
        id: `credential-session-${sessions.size + 1}`,
        userId: id,
        username: input.username,
        displayName: input.username,
        avatarUrl: null,
        expiresAt: input.sessionExpiresAt.toISOString(),
      });
      return {
        user: {
          id,
          username: input.username,
          displayName: input.username,
          email: input.email,
          schoolAccount: input.schoolAccount,
          status: "active",
          createdAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString(),
        },
        expiresAt: input.sessionExpiresAt.toISOString(),
      };
    },
    async getCredentialPrincipal(identifier) {
      return credentialPrincipals.get(identifier) ?? null;
    },
    async getUserProfile(userId) {
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === userId,
      );
      return principal
        ? {
            id: principal.id,
            username: principal.username,
            displayName: principal.displayName,
            avatarUrl: principal.avatarUrl ?? null,
            email: principal.email,
            emailVerified: false,
            schoolAccount: principal.schoolAccount,
            schoolAccountVerified: false,
            createdAt: new Date(0).toISOString(),
            lastLoginAt: new Date().toISOString(),
            status: principal.status,
          }
        : null;
    },
    async updateUserProfile(userId, update) {
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === userId,
      );
      if (!principal) return null;
      if (
        update.normalizedUsername &&
        credentialPrincipals.has(update.normalizedUsername) &&
        credentialPrincipals.get(update.normalizedUsername) !== principal
      ) {
        const error = new Error("username taken");
        error.code = "AUTH_USERNAME_TAKEN";
        throw error;
      }
      if (update.username) {
        for (const [key, candidate] of credentialPrincipals) {
          if (candidate === principal && !key.includes("@")) {
            credentialPrincipals.delete(key);
          }
        }
        principal.username = update.username;
        credentialPrincipals.set(update.normalizedUsername, principal);
      }
      if (update.displayName) principal.displayName = update.displayName;
      if (Object.hasOwn(update, "schoolAccount")) {
        principal.schoolAccount = update.schoolAccount;
      }
      return this.getUserProfile(userId);
    },
    async getUserAvatar(userId) {
      return avatars.get(userId) ?? null;
    },
    async saveUserAvatar(userId, avatar) {
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === userId,
      );
      if (!principal) return null;
      avatars.set(userId, avatar);
      const avatarUrl = `/api/auth/avatars/${userId}?v=${avatar.sha256.slice(0, 16)}`;
      principal.avatarUrl = avatarUrl;
      return { avatarUrl };
    },
    async deleteUserAvatar(userId) {
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === userId,
      );
      if (principal) principal.avatarUrl = null;
      return avatars.delete(userId);
    },
    async recordCredentialFailure(userId) {
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === userId,
      );
      if (!principal) return;
      principal.failedAttempts += 1;
      if (principal.failedAttempts >= 5) {
        principal.lockedUntil = new Date(Date.now() + 30_000).toISOString();
      }
    },
    async createCredentialSession(input) {
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === input.userId,
      );
      if (!principal || principal.status !== "active") {
        const error = new Error("login rejected");
        error.code = "AUTH_CREDENTIAL_LOGIN_REJECTED";
        throw error;
      }
      principal.failedAttempts = 0;
      principal.lockedUntil = null;
      sessions.set(input.sessionTokenHash, {
        id: `credential-session-${sessions.size + 1}`,
        userId: principal.id,
        username: principal.username,
        displayName: principal.displayName,
        avatarUrl: null,
        expiresAt: input.sessionExpiresAt.toISOString(),
      });
      return { expiresAt: input.sessionExpiresAt.toISOString() };
    },
    async createPasswordReset(input) {
      passwordResets.set(input.tokenHash, input.userId);
    },
    async getPasswordResetPrincipal(tokenHash) {
      const userId = passwordResets.get(tokenHash);
      if (!userId) return null;
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === userId,
      );
      return principal
        ? { username: principal.username, email: principal.email }
        : null;
    },
    async consumePasswordReset({ tokenHash, passwordHash }) {
      const userId = passwordResets.get(tokenHash);
      if (!userId) return false;
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === userId,
      );
      principal.passwordHash = passwordHash;
      passwordResets.delete(tokenHash);
      for (const [hash, session] of sessions) {
        if (session.userId === userId) sessions.delete(hash);
      }
      return true;
    },
    async revokeSession(hash) {
      revoked.push(hash);
      sessions.delete(hash);
    },
    async listUserDevices() {
      return [
        {
          id: "11111111-1111-4111-8111-111111111111",
          label: "当前手机",
          platform: "web",
          firstSeenAt: new Date(0).toISOString(),
          lastSeenAt: new Date().toISOString(),
          active: true,
          current: true,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          label: "另一台设备",
          platform: "web",
          firstSeenAt: new Date(0).toISOString(),
          lastSeenAt: new Date().toISOString(),
          active: true,
          current: false,
        },
      ];
    },
    async revokeUserDevice(_userId, currentSessionId, publicDeviceId) {
      const current =
        publicDeviceId === "11111111-1111-4111-8111-111111111111";
      if (
        !current &&
        publicDeviceId !== "22222222-2222-4222-8222-222222222222"
      ) {
        return null;
      }
      if (current) {
        for (const [hash, session] of sessions) {
          if (session.id === currentSessionId) sessions.delete(hash);
        }
      }
      return { current };
    },
    async deleteAccount(userId) {
      deletedAccounts.push(userId);
      for (const [hash, session] of sessions) {
        if (session.userId === userId) sessions.delete(hash);
      }
      return true;
    },
    async getPersonalState() {
      return structuredClone(personalSnapshot);
    },
    async replacePersonalState(userId, payload) {
      const mutationKey = `${userId}:${payload.mutationId}`;
      const payloadJson = JSON.stringify(payload);
      const prior = syncMutations.get(mutationKey);
      if (prior) {
        if (prior !== payloadJson) {
          const error = new Error("mutation ID was reused");
          error.code = "SYNC_MUTATION_REUSED";
          throw error;
        }
        return {
          ...structuredClone(personalSnapshot),
          conflict: false,
          deduplicated: true,
        };
      }
      if (payload.baseRevision !== personalSnapshot.revision) {
        return {
          ...structuredClone(personalSnapshot),
          conflict: true,
          deduplicated: false,
        };
      }
      syncMutations.set(mutationKey, payloadJson);
      personalSnapshot = {
        revision: personalSnapshot.revision + 1,
        state: structuredClone(payload.state),
      };
      return {
        ...structuredClone(personalSnapshot),
        conflict: false,
        deduplicated: false,
      };
    },
  };
}

async function withServer(callback) {
  const store = createFakeStore();
  const wechatProvider = createMockWechatProvider(config);
  const passwordService = {
    async hash(password) {
      return `test-hash:${password}`;
    },
    async verify(passwordHash, password) {
      return passwordHash === `test-hash:${password}`;
    },
  };
  const avatarProcessor = createAvatarProcessor();
  const server = createAuthServer({
    store,
    config,
    wechatProvider,
    passwordService,
    avatarProcessor,
  });
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

test("token buckets refill, reject bursts, and keep their key set bounded", () => {
  const limiter = createTokenBucket({
    capacity: 2,
    refillPerSecond: 1,
    maxKeys: 2,
    idleTtlMs: 1_000,
  });

  assert.equal(limiter.consume("device-a", 0), true);
  assert.equal(limiter.consume("device-a", 0), true);
  assert.equal(limiter.consume("device-a", 0), false);
  assert.equal(limiter.consume("device-a", 1_000), true);

  for (let index = 0; index < 500; index += 1) {
    limiter.consume(`rotating-${index}`, 2_000);
  }
  assert.ok(limiter.size() <= 2);
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
  assert.equal(loaded.credentialsEnabled, true);
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        AUTH_TOKEN_PEPPER: config.tokenPepper,
        POSTGRES_PASSWORD: "database-secret",
        AUTH_PASSWORD_RESET_MODE: "response",
      }),
    /forbidden in production/,
  );
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

test("personal sync requires a session, validates input, deduplicates, and detects conflicts", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const sessionToken = createOpaqueToken();
    const sessionHash = tokenDigest(sessionToken, config.tokenPepper);
    const cookie = `${config.sessionCookie}=${sessionToken}`;
    store.sessions.set(sessionHash, {
      id: "session-sync",
      userId: "user-sync",
      displayName: "同步测试",
      avatarUrl: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const anonymous = await fetch(`${baseUrl}/api/auth/sync`);
    assert.equal(anonymous.status, 401);

    const initial = await fetch(`${baseUrl}/api/auth/sync`, {
      headers: { Cookie: cookie },
    });
    assert.equal(initial.status, 200);
    assert.equal((await initial.json()).revision, 0);

    const state = {
      profile: {
        entranceYear: 2025,
        college: "会计学院",
        majorId: "accounting",
        className: "审计2501",
      },
      skipped: false,
      plans: [
        {
          id: "default",
          name: "默认课表",
          scheduleIds: [
            "fall-section-a-meeting-1",
            "fall-section-a-meeting-2",
          ],
        },
      ],
      activePlanId: "default",
      activities: [
        {
          id: "activity-123456789",
          title: "小组讨论",
          weekday: 3,
          block: 2,
          location: "之远楼",
          notes: "",
          color: "blue",
        },
      ],
      assignments: [
        {
          id: "assignment-123456789",
          courseId: "course-a",
          title: "第三章作业",
          dueDate: "2026-08-06",
          notes: "",
          completed: false,
        },
      ],
      favoriteRooms: ["之远楼401"],
      recentRooms: ["笃行楼302"],
      preferredTerm: "fall",
      theme: "system",
    };
    const write = {
      mutationId: "mutation-123456789",
      baseRevision: 0,
      clientUpdatedAt: new Date().toISOString(),
      state,
    };

    const untrusted = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.invalid",
        Cookie: cookie,
      },
      body: JSON.stringify(write),
    });
    assert.equal(untrusted.status, 403);

    const invalid = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: cookie,
      },
      body: JSON.stringify({ ...write, state: { ...state, plans: [] } }),
    });
    assert.equal(invalid.status, 400);

    const accepted = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: cookie,
      },
      body: JSON.stringify(write),
    });
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(acceptedBody.revision, 1);
    assert.equal(acceptedBody.state.plans[0].scheduleIds.length, 2);

    const retry = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: cookie,
      },
      body: JSON.stringify(write),
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).deduplicated, true);

    const conflict = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: cookie,
      },
      body: JSON.stringify({
        ...write,
        mutationId: "mutation-987654321",
      }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).revision, 1);
  });
});

test("device management is account-scoped and revoking the current device clears its session", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const sessionToken = createOpaqueToken();
    const sessionHash = tokenDigest(sessionToken, config.tokenPepper);
    const cookie = `${config.sessionCookie}=${sessionToken}`;
    store.sessions.set(sessionHash, {
      id: "session-devices",
      userId: "user-devices",
      displayName: "设备测试",
      avatarUrl: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const listed = await fetch(`${baseUrl}/api/auth/devices`, {
      headers: { Cookie: cookie },
    });
    const listedBody = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listedBody.devices.length, 2);
    assert.equal(listedBody.devices[0].current, true);

    const untrusted = await fetch(`${baseUrl}/api/auth/devices`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.invalid",
        Cookie: cookie,
      },
      body: JSON.stringify({
        deviceId: "22222222-2222-4222-8222-222222222222",
      }),
    });
    assert.equal(untrusted.status, 403);

    const revoked = await fetch(`${baseUrl}/api/auth/devices`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: cookie,
      },
      body: JSON.stringify({
        deviceId: "11111111-1111-4111-8111-111111111111",
      }),
    });
    const revokedBody = await revoked.json();
    assert.equal(revoked.status, 200);
    assert.equal(revokedBody.currentSessionRevoked, true);
    assert.equal(store.sessions.has(sessionHash), false);
    assert.ok(
      revoked.headers
        .getSetCookie()
        .some((value) => value.startsWith(`${config.sessionCookie}=;`)),
    );
  });
});

test("account deletion requires an exact confirmation and removes the signed-in account", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const sessionToken = createOpaqueToken();
    const sessionHash = tokenDigest(sessionToken, config.tokenPepper);
    const cookie = `${config.sessionCookie}=${sessionToken}`;
    store.sessions.set(sessionHash, {
      id: "session-delete",
      userId: "user-delete",
      displayName: "注销测试",
      avatarUrl: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const rejected = await fetch(`${baseUrl}/api/auth/account/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: cookie,
      },
      body: JSON.stringify({ confirmation: "delete" }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(store.deletedAccounts.length, 0);

    const deleted = await fetch(`${baseUrl}/api/auth/account/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: cookie,
      },
      body: JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT" }),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(store.deletedAccounts, ["user-delete"]);
    assert.equal(store.sessions.has(sessionHash), false);
  });
});

test("credential registration, login, and one-time password reset are real server flows", async () => {
  await withServer(async ({ baseUrl }) => {
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://dufesh.cn",
    };
    const registration = {
      username: "海边自习室",
      email: "student@example.com",
      password: "Moonlight!2026",
      schoolAccount: "2026123456",
    };

    const registered = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(registration),
    });
    const registeredBody = await registered.json();
    assert.equal(registered.status, 201);
    assert.equal(registeredBody.authenticated, true);
    assert.equal(registeredBody.user.username, registration.username);
    assert.ok(
      registered.headers
        .getSetCookie()
        .some((value) => value.startsWith(`${config.sessionCookie}=`)),
    );

    const duplicate = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(registration),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, "registration_conflict");

    const wrongKnown = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        identifier: registration.email,
        password: "wrong-password",
      }),
    });
    const wrongUnknown = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        identifier: "unknown@example.com",
        password: "wrong-password",
      }),
    });
    assert.equal(wrongKnown.status, 401);
    assert.equal(wrongUnknown.status, 401);
    assert.deepEqual(await wrongKnown.json(), await wrongUnknown.json());

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        identifier: registration.username,
        password: registration.password,
      }),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.username, registration.username);

    const resetRequested = await fetch(
      `${baseUrl}/api/auth/password/reset/request`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ identifier: registration.email }),
      },
    );
    const resetRequestBody = await resetRequested.json();
    assert.equal(resetRequested.status, 202);
    assert.equal(isOpaqueToken(resetRequestBody.debugToken), true);

    const newPassword = "HarborLight!2027";
    const reset = await fetch(
      `${baseUrl}/api/auth/password/reset/confirm`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          token: resetRequestBody.debugToken,
          password: newPassword,
        }),
      },
    );
    assert.equal(reset.status, 200);

    const replay = await fetch(
      `${baseUrl}/api/auth/password/reset/confirm`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          token: resetRequestBody.debugToken,
          password: "AnotherSafe!2028",
        }),
      },
    );
    assert.equal(replay.status, 400);

    const oldPassword = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        identifier: registration.email,
        password: registration.password,
      }),
    });
    assert.equal(oldPassword.status, 401);

    const newLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        identifier: registration.email,
        password: newPassword,
      }),
    });
    assert.equal(newLogin.status, 200);
  });
});

test("repeated credential failures lock the account even when the password later matches", async () => {
  await withServer(async ({ baseUrl }) => {
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://dufesh.cn",
    };
    await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: "locked-student",
        email: "locked@example.com",
        password: "Moonlight!2026",
      }),
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          identifier: "locked-student",
          password: `wrong-password-${attempt}`,
        }),
      });
      assert.equal(rejected.status, 401);
    }

    const locked = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        identifier: "locked-student",
        password: "Moonlight!2026",
      }),
    });
    assert.equal(locked.status, 401);
    assert.deepEqual(await locked.json(), { error: "invalid_credentials" });
  });
});

test("authenticated profile updates are whitelisted, normalized, and account-scoped", async () => {
  await withServer(async ({ baseUrl }) => {
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://dufesh.cn",
    };
    const registered = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: "profile-student",
        email: "profile@example.com",
        password: "Moonlight!2026",
      }),
    });
    const cookie = registered.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");

    const profile = await fetch(`${baseUrl}/api/auth/profile`, {
      headers: { Cookie: cookie },
    });
    const profileBody = await profile.json();
    assert.equal(profile.status, 200);
    assert.equal(profileBody.profile.email, "profile@example.com");
    assert.equal(profileBody.profile.schoolAccountVerified, false);

    const untrusted = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.invalid",
        Cookie: cookie,
      },
      body: JSON.stringify({ displayName: "攻击者" }),
    });
    assert.equal(untrusted.status, 403);

    const massAssignment = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PUT",
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify({ displayName: "海风", status: "admin" }),
    });
    assert.equal(massAssignment.status, 400);

    const updated = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PUT",
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify({
        username: "海风-2026",
        displayName: "海风",
        schoolAccount: "2026123456",
      }),
    });
    const updatedBody = await updated.json();
    assert.equal(updated.status, 200);
    assert.equal(updatedBody.profile.username, "海风-2026");
    assert.equal(updatedBody.profile.displayName, "海风");
    assert.equal(updatedBody.profile.schoolAccount, "2026123456");
    assert.equal(updatedBody.profile.schoolAccountVerified, false);
  });
});

test("avatar upload validates content, serves versioned WebP, and supports deletion", async () => {
  await withServer(async ({ baseUrl }) => {
    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
      },
      body: JSON.stringify({
        username: "avatar-student",
        email: "avatar@example.com",
        password: "Moonlight!2026",
      }),
    });
    const cookie = registration.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const png = await sharp({
      create: {
        width: 32,
        height: 48,
        channels: 3,
        background: { r: 181, g: 38, b: 38 },
      },
    })
      .png()
      .toBuffer();

    const forged = await fetch(`${baseUrl}/api/auth/profile/avatar`, {
      method: "PUT",
      headers: {
        "Content-Type": "image/jpeg",
        Origin: "https://dufesh.cn",
        Cookie: cookie,
      },
      body: png,
    });
    assert.equal(forged.status, 400);

    const uploaded = await fetch(`${baseUrl}/api/auth/profile/avatar`, {
      method: "PUT",
      headers: {
        "Content-Type": "image/png",
        Origin: "https://dufesh.cn",
        Cookie: cookie,
      },
      body: png,
    });
    const uploadBody = await uploaded.json();
    assert.equal(uploaded.status, 200);
    assert.match(uploadBody.avatarUrl, /^\/api\/auth\/avatars\/[0-9a-f-]{36}\?v=/);

    const image = await fetch(`${baseUrl}${uploadBody.avatarUrl}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/webp");
    assert.equal(
      image.headers.get("cache-control"),
      "public, max-age=300, must-revalidate",
    );
    const etag = image.headers.get("etag");
    assert.ok(etag);
    assert.ok((await image.arrayBuffer()).byteLength > 0);

    const cached = await fetch(`${baseUrl}${uploadBody.avatarUrl}`, {
      headers: { "If-None-Match": etag },
    });
    assert.equal(cached.status, 304);

    const deleted = await fetch(`${baseUrl}/api/auth/profile/avatar`, {
      method: "DELETE",
      headers: { Origin: "https://dufesh.cn", Cookie: cookie },
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).avatarUrl, null);

    const missing = await fetch(`${baseUrl}${uploadBody.avatarUrl}`);
    assert.equal(missing.status, 404);
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
