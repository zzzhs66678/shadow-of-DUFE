import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { parseTrustedProxies } from "../src/request-security.mjs";
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
  trustedProxyRanges: parseTrustedProxies("127.0.0.1/32"),
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
  academicImportEnabled: false,
  registrationMode: "smtp",
  registrationKey: "independent-test-registration-hmac-key-32chars",
  passwordResetMode: "response",
  passwordResetTtlSeconds: 1_800,
  emailVerificationMode: "response",
  emailVerificationTtlSeconds: 86_400,
  adminEnabled: false,
  adminCookie: "__Host-dufesh_admin_elevation",
  adminElevationTtlSeconds: 600,
  wechatMode: "mock",
  mockLoginSecret: "mock-secret-that-is-longer-than-thirty-two-characters",
};

test("school account limits survive fresh device cookies and forged source headers", async () => {
  await withServer(async ({ baseUrl }) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await fetch(`${baseUrl}/api/auth/academic/connect`, {
        method: "POST", headers: { Origin: "https://dufesh.cn", "Content-Type": "application/json", "X-Forwarded-For": `192.0.2.${attempt}` },
        body: JSON.stringify({ username: "20260001", password: "synthetic-school-password" }),
      });
      assert.equal(reply.status, attempt < 4 ? 401 : 429);
    }
    const other = await fetch(`${baseUrl}/api/auth/academic/connect`, {
      method: "POST", headers: { Origin: "https://dufesh.cn", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "20260002", password: "synthetic-school-password" }),
    });
    assert.equal(other.status, 401);
  }, { config: { academicImportEnabled: true }, academicConnector: {
    async start() { const error = new Error("ACADEMIC_INVALID_CREDENTIALS"); error.code = "ACADEMIC_INVALID_CREDENTIALS"; throw error; },
  } });
});

function createFakeStore() {
  const challenges = new Map();
  const devices = new Map();
  const sessions = new Map();
  const transactions = new Map();
  const identities = new Map();
  const credentialPrincipals = new Map();
  const passwordResets = new Map();
  const emailVerifications = new Map();
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
      academicSnapshots: [],
      trainingPlan: null,
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
    async reserveSecurityMail() { return "fixture-reservation"; },
    async createRegistrationChallenge(input) { challenges.set(input.id,input); return {sendId:input.id,shouldSend:true,expiresAt:new Date(Date.now()+300000)}; },
    async finishSecurityMail({sendId,delivered}) { const c=challenges.get(sendId);if(c)c.delivered=delivered; return true; },
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
      const proof=input.registrationProof; const c=challenges.get(proof?.challengeId);
      if(!c || !c.delivered || c.used || c.codeHash!==proof.codeHash || c.browserHash!==proof.browserHash || c.email!==input.normalizedEmail) return null;
      c.used=true;
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
        displayName: input.nameMode === "momo" ? "momo" : input.username,
        accountName: input.username,
        nameMode: input.nameMode ?? "name",
        nameModeAvailableAt: null,
        email: input.email,
        emailVerified: true,
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
        displayName: principal.displayName,
        accountName: principal.accountName,
        nameMode: principal.nameMode,
        nameModeAvailableAt: principal.nameModeAvailableAt,
        avatarUrl: null,
        email: input.email,
        emailVerified: true,
        schoolAccount: input.schoolAccount,
        schoolAccountVerified: false,
        expiresAt: input.sessionExpiresAt.toISOString(),
      });
      return {
        user: {
          id,
          username: input.username,
          displayName: principal.displayName,
          accountName: principal.accountName,
          nameMode: principal.nameMode,
          nameModeAvailableAt: principal.nameModeAvailableAt,
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
            accountName: principal.accountName ?? principal.displayName,
            nameMode: principal.nameMode ?? "name",
            nameModeAvailableAt: principal.nameModeAvailableAt ?? null,
            avatarUrl: principal.avatarUrl ?? null,
            email: principal.email,
            emailVerified: principal.emailVerified,
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
        email: principal.email,
        emailVerified: principal.emailVerified,
        schoolAccount: principal.schoolAccount,
        schoolAccountVerified: false,
        expiresAt: input.sessionExpiresAt.toISOString(),
      });
      return { expiresAt: input.sessionExpiresAt.toISOString() };
    },
    async createPasswordReset(input) {
      const principal = [...credentialPrincipals.values()].find((p) => p.id === input.userId);
      if (!principal?.emailVerified || principal.passwordHash !== input.expectedPasswordHash || principal.email !== input.normalizedEmail) return false;
      for (const [hash, candidate] of passwordResets) if (candidate.userId === input.userId) passwordResets.delete(hash);
      passwordResets.set(input.tokenHash, { ...input, delivered: false });
      return true;
    },
    async finishPasswordResetDelivery({ tokenHash, delivered }) {
      const item = passwordResets.get(tokenHash); if (!item) return false;
      if (!delivered) { passwordResets.delete(tokenHash); return false; }
      item.delivered = true; return true;
    },
    async createEmailVerification(input) {
      for (const [hash, candidate] of emailVerifications) {
        if (candidate.userId === input.userId) emailVerifications.delete(hash);
      }
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === input.userId,
      );
      if (!principal || principal.emailVerified || principal.passwordHash !== input.expectedPasswordHash || principal.email !== input.normalizedEmail) return false;
      emailVerifications.set(input.tokenHash, {
        ...input, email: principal.email, delivered: false,
      });
      return true;
    },
    async finishEmailVerificationDelivery({ tokenHash, delivered }) {
      const item = emailVerifications.get(tokenHash); if (!item) return false;
      if (!delivered) { emailVerifications.delete(tokenHash); return false; }
      item.delivered = true; return true;
    },
    async consumeEmailVerification({ userId, sessionId, tokenHash }) {
      const token = emailVerifications.get(tokenHash);
      if (!token || token.userId !== userId || token.sessionId !== sessionId || !token.delivered || token.expiresAt.getTime() <= Date.now()) return false;
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === userId,
      );
      if (!principal || principal.email !== token.email || principal.passwordHash !== token.expectedPasswordHash) return false;
      principal.emailVerified = true;
      emailVerifications.delete(tokenHash);
      for (const session of sessions.values()) {
        if (session.userId === userId) session.emailVerified = true;
      }
      return true;
    },
    async getPasswordResetPrincipal(tokenHash) {
      const item = passwordResets.get(tokenHash);
      if (!item?.delivered || item.expiresAt.getTime() <= Date.now()) return null;
      const principal = [...credentialPrincipals.values()].find(
        (candidate) => candidate.id === item.userId,
      );
      return principal?.emailVerified && principal.passwordHash === item.expectedPasswordHash && principal.email === item.normalizedEmail
        ? { username: principal.username, email: principal.email }
        : null;
    },
    async consumePasswordReset({ tokenHash, passwordHash }) {
      const item = passwordResets.get(tokenHash);
      if (!await this.getPasswordResetPrincipal(tokenHash)) return false;
      const userId = item.userId;
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

const mailboxes = new Map();
function seedLegacyCredential(store, email = "legacy@example.com") {
  const token = createOpaqueToken();
  const principal = { id: "legacy-fixture-user", username: "legacy-fixture", email,
    displayName: "合成旧用户", status: "active", emailVerified: false,
    passwordHash: "test-hash:LegacyHarbor!2026", failedAttempts: 0, lockedUntil: null };
  store.credentialPrincipals.set(email, principal);
  store.credentialPrincipals.set(principal.username, principal);
  store.sessions.set(tokenDigest(token, config.tokenPepper), { id: "legacy-fixture-session",
    userId: principal.id, email, emailVerified: false, expiresAt: new Date(Date.now()+3600000).toISOString() });
  return { principal, cookie: `${config.sessionCookie}=${token}` };
}

test("legacy unverified email cannot issue an anonymous password reset", async () => {
  await withServer(async ({ baseUrl, store }) => {
    seedLegacyCredential(store);
    let issued = 0;
    store.createPasswordReset = async () => { issued++; return true; };
    const reply = await fetch(`${baseUrl}/api/auth/password/reset/request`, {
      method: "POST", headers: { Origin: "https://dufesh.cn", "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "legacy@example.com" }),
    });
    assert.equal(reply.status, 202);
    assert.deepEqual(await reply.json(), { ok: true });
    assert.equal(issued, 0);
  });
});

test("legacy email verification requires the current password before issuing mail", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const { cookie } = seedLegacyCredential(store);
    for (const body of [{}, { password: "wrong" }, { password: "LegacyHarbor!2026", verified: true }]) {
      const reply = await fetch(`${baseUrl}/api/auth/email/verification/request`, {
        method: "POST", headers: { Cookie: cookie, Origin: "https://dufesh.cn", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(reply.status, body.password === "wrong" ? 401 : 400);
      assert.equal(JSON.stringify(await reply.json()).includes("debugToken"), false);
    }
  });
});

test("disabled recovery modes reject token confirmation as well as issuance", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const { cookie } = seedLegacyCredential(store);
    for (const path of ["password/reset/confirm", "email/verification/confirm"]) {
      const reply = await fetch(`${baseUrl}/api/auth/${path}`, {
        method: "POST", headers: { Cookie: cookie, Origin: "https://dufesh.cn", "Content-Type": "application/json" },
        body: JSON.stringify({ token: createOpaqueToken(), password: "SomeNewHarbor!2026" }),
      });
      assert.equal(reply.status, 503);
    }
  }, { config: { passwordResetMode: "disabled", emailVerificationMode: "disabled" } });
});

test("SMTP and delivery-state failures never activate email verification tokens", async () => {
  for (const failure of ["smtp", "budget", "token-store"]) {
    let sentToken;
    await withServer(async ({ baseUrl, store }) => {
      const { cookie, principal } = seedLegacyCredential(store);
      if (failure === "budget") store.finishSecurityMail = async () => { throw new Error("synthetic-private-failure"); };
      if (failure === "token-store") store.finishEmailVerificationDelivery = async () => { throw new Error("synthetic-private-failure"); };
      const headers = { Cookie: cookie, Origin: "https://dufesh.cn", "Content-Type": "application/json" };
      const request = await fetch(`${baseUrl}/api/auth/email/verification/request`, {
        method: "POST", headers, body: JSON.stringify({ password: "LegacyHarbor!2026" }),
      });
      assert.ok([500, 503].includes(request.status));
      const payload = JSON.stringify(await request.json());
      assert.equal(payload.includes("synthetic-private-failure"), false);
      assert.equal(payload.includes(sentToken), false);
      const confirm = await fetch(`${baseUrl}/api/auth/email/verification/confirm`, {
        method: "POST", headers, body: JSON.stringify({ token: sentToken }),
      });
      assert.equal(confirm.status, 400);
      assert.equal(principal.emailVerified, false);
    }, { config: { emailVerificationMode: "smtp" }, mailDelivery: {
      async sendEmailVerification({ token }) { sentToken = token; if (failure === "smtp") throw new Error("synthetic-private-failure"); },
    } });
  }
});

test("a reset token is unusable while SMTP is pending or when delivery fails", async () => {
  let sentToken;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withServer(async ({ baseUrl, store }) => {
    const { principal } = seedLegacyCredential(store);
    principal.emailVerified = true;
    const headers = { Origin: "https://dufesh.cn", "Content-Type": "application/json" };
    const request = await fetch(`${baseUrl}/api/auth/password/reset/request`, {
      method: "POST", headers, body: JSON.stringify({ identifier: principal.email }),
    });
    assert.deepEqual(await request.json(), { ok: true });
    assert.equal(request.status, 202);
    while (!sentToken) await new Promise((resolve) => setTimeout(resolve, 1));
    const confirm = () => fetch(`${baseUrl}/api/auth/password/reset/confirm`, {
      method: "POST", headers, body: JSON.stringify({ token: sentToken, password: "SomeNewHarbor!2026" }),
    });
    assert.equal((await confirm()).status, 400);
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await confirm()).status, 400);
    assert.equal(principal.passwordHash, "test-hash:LegacyHarbor!2026");
  }, { config: { passwordResetMode: "smtp" }, mailDelivery: {
    async sendPasswordReset({ token }) { sentToken = token; await gate; throw new Error("synthetic-private-failure"); },
  } });
});
async function registerWithProof(url, options) {
  const base = new URL(url).origin;
  const body = JSON.parse(options.body);
  const challenge = await fetch(base+"/api/auth/register/challenge", { ...options, body:JSON.stringify({email:body.email}) });
  if(!challenge.ok) return challenge;
  const payload = await challenge.json();
  await new Promise((resolve)=>setTimeout(resolve,5));
  const cookie = challenge.headers.getSetCookie().map((v)=>v.split(";",1)[0]).join("; ");
  return fetch(url,{...options,headers:{...options.headers,Cookie:cookie},body:JSON.stringify({...body,challengeId:payload.challengeId,code:mailboxes.get(base).get(body.email)})});
}

async function withServer(callback, options = {}) {
  const store = createFakeStore();
  const runtimeConfig = { ...config, ...(options.config ?? {}) };
  const wechatProvider = createMockWechatProvider(runtimeConfig);
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
    config: runtimeConfig,
    wechatProvider,
    passwordService,
    avatarProcessor,
    mailDelivery: { ...options.mailDelivery,
      async sendRegistrationCode(input) { mailboxes.get(baseUrl).set(input.to,input.code); },
    },
    academicConnector: options.academicConnector,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  mailboxes.set(baseUrl, new Map());

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

test("SMTP reset response is independent of account lookup and redacts background failures", async () => {
  await withServer(async ({ baseUrl, store }) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    store.getCredentialPrincipal = async () => { await gate; return null; };
    try {
      const response = await fetch(`${baseUrl}/api/auth/password/reset/request`, {
        method: "POST", headers: { Origin: "https://dufesh.cn", "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "unknown@example.com" }), signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { ok: true });
    } finally { release(); }
    const logs = []; const original = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    try {
      store.getCredentialPrincipal = async () => { throw new Error("synthetic-password-and-SMTP-secret"); };
      const response = await fetch(`${baseUrl}/api/auth/password/reset/request`, {
        method: "POST", headers: { Origin: "https://dufesh.cn", "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "known@example.com" }),
      });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { ok: true });
      assert.ok(logs.includes("Security password reset request failed"));
      assert.equal(logs.join(" ").includes("synthetic-password-and-SMTP-secret"), false);
    } finally { console.error = original; }
  }, { config: { passwordResetMode: "smtp" } });
});

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

test("academic import routes support anonymous device continuity without exposing credentials", async () => {
  let principalKey = "";
  const academicConnector = {
    async start(input) {
      principalKey = input.principalKey;
      assert.equal(input.username, "20260001");
      assert.equal(input.password, "school-password");
      return {
        status: "sms_destination_required",
        transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
        destination: "enter",
        phoneOptions: [],
        expiresInSeconds: 300,
      };
    },
    async sendSms(input) {
      assert.equal(input.principalKey, principalKey);
      assert.equal(input.transactionId, "abcdefghijklmnopqrstuvwxyzABCDEFGH");
      assert.equal(input.phone, "13800000000");
      return {
        status: "sms_required",
        transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
        maskedPhone: "138****0000",
        expiresInSeconds: 300,
      };
    },
    async verifySms(input) {
      assert.equal(input.principalKey, principalKey);
      assert.equal(input.transactionId, "abcdefghijklmnopqrstuvwxyzABCDEFGH");
      assert.equal(input.code, "123456");
      return {
        status: "sso_verification_required",
        transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
        challenge: {
          backgroundImage: "data:image/png;base64,iVBORw0KGgo=",
          pieceImage: "data:image/png;base64,iVBORw0KGgo=",
          width: 280,
          height: 155,
          pieceWidth: 80,
          maxOffset: 240,
        },
        expiresInSeconds: 300,
      };
    },
    async verifySso(input) {
      assert.equal(input.principalKey, principalKey);
      assert.equal(input.transactionId, "abcdefghijklmnopqrstuvwxyzABCDEFGH");
      assert.equal(input.verifyCode, "117");
      return {
        status: "imported",
        snapshot: {
          schemaVersion: 1,
          id: "2026-2027-fall",
          academicYear: "2026-2027",
          term: "fall",
          termLabel: "第一学期",
          importedAt: "2026-09-28T00:00:00.000Z",
          sections: [],
          exams: [],
        },
      };
    },
  };
  await withServer(
    async ({ baseUrl }) => {
      const connected = await fetch(`${baseUrl}/api/auth/academic/connect`, {
        method: "POST",
        headers: {
          Origin: "https://dufesh.cn",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: "20260001",
          password: "school-password",
        }),
      });
      assert.equal(connected.status, 200);
      assert.equal((await connected.json()).status, "sms_destination_required");
      const deviceCookie = connected.headers
        .get("set-cookie")
        .split(";", 1)[0];
      assert.match(deviceCookie, /^__Host-dufesh_device=/u);
      assert.match(principalKey, /^device:anonymous-1$/u);

      const sent = await fetch(`${baseUrl}/api/auth/academic/sms/send`, {
        method: "POST",
        headers: {
          Origin: "https://dufesh.cn",
          "Content-Type": "application/json",
          Cookie: deviceCookie,
        },
        body: JSON.stringify({
          transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
          phone: "13800000000",
        }),
      });
      assert.equal(sent.status, 200);
      assert.equal((await sent.json()).status, "sms_required");

      const verified = await fetch(`${baseUrl}/api/auth/academic/sms`, {
        method: "POST",
        headers: {
          Origin: "https://dufesh.cn",
          "Content-Type": "application/json",
          Cookie: deviceCookie,
        },
        body: JSON.stringify({
          transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
          code: "123456",
        }),
      });
      assert.equal(verified.status, 200);
      assert.equal((await verified.json()).status, "sso_verification_required");

      const ssoVerified = await fetch(`${baseUrl}/api/auth/academic/sso`, {
        method: "POST",
        headers: {
          Origin: "https://dufesh.cn",
          "Content-Type": "application/json",
          Cookie: deviceCookie,
        },
        body: JSON.stringify({
          transactionId: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
          verifyCode: "117",
        }),
      });
      assert.equal(ssoVerified.status, 200);
      assert.equal((await ssoVerified.json()).status, "imported");

      const untrusted = await fetch(`${baseUrl}/api/auth/academic/connect`, {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: "x", password: "y" }),
      });
      assert.equal(untrusted.status, 403);
    },
    {
      config: { academicImportEnabled: true },
      academicConnector,
    },
  );
});

test("academic parser diagnostics log only allowlisted anonymous structure", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(" "));
  const academicConnector = {
    async start() {
      const error = new Error("school response did not match");
      error.code = "ACADEMIC_PLAN_FORMAT_CHANGED";
      error.stage = "plan_parse";
      error.diagnostic = {
        parseReason: "plan_course_pattern_invalid",
        courseIndex: 12,
        courseLabelLength: 48,
        stableCodeLength: 8,
        bracketGroupCount: 1,
        hasStableCourseCode: true,
        hasAsciiBrackets: true,
        hasCreditMarker: false,
        raw: "private course label",
        courseCode: "private course code",
        courseName: "private course name",
      };
      throw error;
    },
  };
  try {
    await withServer(
      async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/auth/academic/connect`, {
          method: "POST",
          headers: {
            Origin: "https://dufesh.cn",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: "20260001",
            password: "school-password",
          }),
        });
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), {
          error: "academic_plan_format_changed",
          stage: "plan_parse",
        });
      },
      {
        config: { academicImportEnabled: true },
        academicConnector,
      },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  const diagnostic = JSON.parse(warnings[0]);
  assert.equal(diagnostic.parseReason, "plan_course_pattern_invalid");
  assert.equal(diagnostic.courseIndex, 12);
  assert.equal(diagnostic.courseLabelLength, 48);
  assert.equal(diagnostic.hasStableCourseCode, true);
  assert.equal(diagnostic.hasCreditMarker, false);
  assert.equal("raw" in diagnostic, false);
  assert.equal("courseCode" in diagnostic, false);
  assert.equal("courseName" in diagnostic, false);
});

test("academic routes return verified timetable data when only the plan import fails", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(" "));
  const partialSnapshot = {
    schemaVersion: 1,
    id: "2026-2027-fall",
    academicYear: "2026-2027",
    term: "fall",
    termLabel: "第一学期",
    importedAt: "2026-10-05T03:00:00.000Z",
    sections: [{ id: "academic-section:test", meetings: [] }],
    exams: [{ id: "academic-exam:test" }],
  };
  const academicConnector = {
    async start() {
      const planError = new Error("private upstream response");
      planError.code = "ACADEMIC_PLAN_FORMAT_CHANGED";
      planError.stage = "plan_parse";
      planError.diagnostic = {
        parseReason: "plan_course_credit_value_invalid",
        courseIndex: 379,
        raw: "private course label",
      };
      return {
        status: "partial_imported",
        snapshot: partialSnapshot,
        trainingPlan: null,
        warning: "academic_plan_format_changed",
        planError,
      };
    },
  };

  try {
    await withServer(
      async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/auth/academic/connect`, {
          method: "POST",
          headers: {
            Origin: "https://dufesh.cn",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: "20260001",
            password: "school-password",
          }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          status: "partial_imported",
          snapshot: partialSnapshot,
          trainingPlan: null,
          warning: "academic_plan_format_changed",
        });
      },
      {
        config: { academicImportEnabled: true },
        academicConnector,
      },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  const diagnostic = JSON.parse(warnings[0]);
  assert.equal(diagnostic.event, "academic_import_partial");
  assert.equal(diagnostic.parseReason, "plan_course_credit_value_invalid");
  assert.equal(diagnostic.courseIndex, 379);
  assert.equal(diagnostic.sections, 1);
  assert.equal(diagnostic.exams, 1);
  assert.equal("raw" in diagnostic, false);
});

test("academic routes return timetable and plan when only the exam page is unknown", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(" "));
  const partialSnapshot = {
    schemaVersion: 1,
    id: "2026-2027-fall",
    academicYear: "2026-2027",
    term: "fall",
    termLabel: "第一学期",
    importedAt: "2026-10-06T05:40:52.000Z",
    sections: [{ id: "academic-section:test", meetings: [{ id: "meeting:test" }] }],
    exams: [],
    examStatus: "unavailable",
  };
  const trainingPlan = { courses: [{ courseCode: "test-course" }] };
  const academicConnector = {
    async start() {
      const examError = new Error("private upstream response");
      examError.code = "ACADEMIC_EXAM_FORMAT_CHANGED";
      examError.stage = "exam_parse";
      examError.diagnostic = {
        parseReason: "exam_structure_unknown",
        tableCount: 2,
        tableShapes: ["3x4", "1x1"],
        knownHeaders: ["考试时间", "考场"],
        widgetCount: 1,
        widgetTitleCount: 0,
        textLength: 245,
        hasExamMarker: true,
        hasEmptyMarker: false,
        raw: "private exam page",
      };
      return {
        status: "partial_imported",
        snapshot: partialSnapshot,
        trainingPlan,
        warning: "academic_exam_format_changed",
        examError,
      };
    },
  };

  try {
    await withServer(
      async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/auth/academic/connect`, {
          method: "POST",
          headers: {
            Origin: "https://dufesh.cn",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: "20260001",
            password: "school-password",
          }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          status: "partial_imported",
          snapshot: partialSnapshot,
          trainingPlan,
          warning: "academic_exam_format_changed",
        });
      },
      {
        config: { academicImportEnabled: true },
        academicConnector,
      },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  const diagnostic = JSON.parse(warnings[0]);
  assert.equal(diagnostic.event, "academic_import_partial");
  assert.equal(diagnostic.code, "ACADEMIC_EXAM_FORMAT_CHANGED");
  assert.equal(diagnostic.stage, "exam_parse");
  assert.equal(diagnostic.parseReason, "exam_structure_unknown");
  assert.equal(diagnostic.widgetCount, 1);
  assert.equal(diagnostic.widgetTitleCount, 0);
  assert.equal(diagnostic.hasExamMarker, true);
  assert.equal(diagnostic.hasEmptyMarker, false);
  assert.equal(diagnostic.sections, 1);
  assert.equal(diagnostic.exams, 0);
  assert.equal(diagnostic.examStatus, "unavailable");
  assert.equal(diagnostic.planCourses, 1);
  assert.equal("raw" in diagnostic, false);
});

test("academic routes preserve all optional-service warnings", async () => {
  const warningLogs = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warningLogs.push(values.join(" "));
  const snapshot = {
    schemaVersion: 1,
    id: "2026-2027-fall",
    academicYear: "2026-2027",
    term: "fall",
    termLabel: "第一学期",
    importedAt: "2026-10-06T11:17:10.000Z",
    sections: [{ id: "academic-section:test", meetings: [{ id: "meeting:test" }] }],
    exams: [],
    examStatus: "unavailable",
  };
  const examError = Object.assign(new Error("private upstream response"), {
    code: "ACADEMIC_UPSTREAM_UNAVAILABLE",
    stage: "exam_fetch",
  });
  const planError = Object.assign(new Error("private upstream response"), {
    code: "ACADEMIC_UPSTREAM_UNAVAILABLE",
    stage: "plan_fetch",
  });
  const academicConnector = {
    async start() {
      return {
        status: "partial_imported",
        snapshot,
        trainingPlan: null,
        warning: "academic_exam_unavailable",
        warnings: [
          "academic_exam_unavailable",
          "academic_plan_unavailable",
        ],
        examError,
        planError,
      };
    },
  };

  try {
    await withServer(
      async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/auth/academic/connect`, {
          method: "POST",
          headers: {
            Origin: "https://dufesh.cn",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: "20260001",
            password: "school-password",
          }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          status: "partial_imported",
          snapshot,
          trainingPlan: null,
          warning: "academic_exam_unavailable",
          warnings: [
            "academic_exam_unavailable",
            "academic_plan_unavailable",
          ],
        });
      },
      {
        config: { academicImportEnabled: true },
        academicConnector,
      },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warningLogs.length, 2);
  const diagnostics = warningLogs.map((value) => JSON.parse(value));
  assert.deepEqual(
    diagnostics.map((item) => item.warning),
    ["academic_exam_unavailable", "academic_plan_unavailable"],
  );
  assert.deepEqual(
    diagnostics.map((item) => item.stage),
    ["exam_fetch", "plan_fetch"],
  );
  assert.equal(diagnostics.every((item) => item.sections === 1), true);
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
    /AUTH_DB_PASSWORD or POSTGRES_PASSWORD is required/,
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
        AUTH_TOKEN_PEPPER: config.tokenPepper,
        POSTGRES_PASSWORD: "database-secret",
        AUTH_ADMIN_ENABLED: "true",
        AUTH_ADMIN_MFA_ACTIVE_KEY_ID: "v1",
        AUTH_ADMIN_MFA_KEYS: '{"v1":"not-a-valid-key"}',
        AUTH_ADMIN_RECOVERY_PEPPER: `${config.tokenPepper}-admin`,
      }),
    /AUTH_ADMIN_MFA_KEYS/u,
  );
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
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        AUTH_TOKEN_PEPPER: config.tokenPepper,
        POSTGRES_PASSWORD: "database-secret",
        AUTH_EMAIL_VERIFICATION_MODE: "response",
      }),
    /AUTH_EMAIL_VERIFICATION_MODE=response is forbidden in production/u,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        AUTH_TOKEN_PEPPER: config.tokenPepper,
        POSTGRES_PASSWORD: "database-secret",
        AUTH_PASSWORD_RESET_MODE: "smtp",
      }),
    /AUTH_SMTP_HOST/u,
  );
  const smtp = loadConfig({
    NODE_ENV: "production",
    AUTH_TOKEN_PEPPER: config.tokenPepper,
    POSTGRES_PASSWORD: "database-secret",
    AUTH_PASSWORD_RESET_MODE: "smtp",
    AUTH_EMAIL_VERIFICATION_MODE: "smtp",
    AUTH_SMTP_HOST: "smtp.example.com",
    AUTH_SMTP_SECURE: "false",
    AUTH_SMTP_USER: "mailer",
    AUTH_SMTP_PASSWORD: "smtp-secret",
    AUTH_EMAIL_FROM: "no-reply@dufesh.cn",
  });
  assert.deepEqual(smtp.smtp, {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    user: "mailer",
    password: "smtp-secret",
    from: "no-reply@dufesh.cn",
  });
});

test("SMTP mode delivers reset and verification tokens without returning them", async () => {
  const deliveries = [];
  let resetDeliveryComplete = false;
  let releaseResetDelivery;
  const mailDelivery = {
    async sendPasswordReset(input) {
      deliveries.push({ type: "reset", ...input });
      await new Promise((resolve) => {
        releaseResetDelivery = resolve;
      });
      resetDeliveryComplete = true;
    },
    async sendEmailVerification(input) {
      deliveries.push({ type: "verify", ...input });
    },
  };

  await withServer(
    async ({ baseUrl, store }) => {
      const headers = {
        Origin: "https://dufesh.cn",
        "Content-Type": "application/json",
      };
      const registration = await registerWithProof(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          username: "smtp-student",
          email: "smtp-student@example.com",
          password: "PaperHarbor!2026",
        }),
      });
      assert.equal(registration.status, 201);

      const reset = await fetch(`${baseUrl}/api/auth/password/reset/request`, {
        method: "POST",
        headers,
        body: JSON.stringify({ identifier: "smtp-student@example.com" }),
      });
      assert.equal(reset.status, 202);
      assert.deepEqual(await reset.json(), { ok: true });
      assert.equal(
        resetDeliveryComplete,
        false,
        "password reset response must not wait for the SMTP network",
      );
      releaseResetDelivery();

      const legacy = seedLegacyCredential(store, "smtp-legacy@example.com");

      const verification = await fetch(
        `${baseUrl}/api/auth/email/verification/request`,
        {
          method: "POST",
          headers: { ...headers, Cookie: legacy.cookie },
          body: JSON.stringify({ password: "LegacyHarbor!2026" }),
        },
      );
      assert.equal(verification.status, 202);
      assert.deepEqual(await verification.json(), { ok: true, expiresIn: 86_400 });
    },
    {
      config: {
        passwordResetMode: "smtp",
        emailVerificationMode: "smtp",
      },
      mailDelivery,
    },
  );

  assert.deepEqual(deliveries.map(({ type, to }) => ({ type, to })), [
    { type: "reset", to: "smtp-student@example.com" },
    { type: "verify", to: "smtp-legacy@example.com" },
  ]);
  for (const delivery of deliveries) {
    assert.equal(isOpaqueToken(delivery.token), true);
    assert.ok(delivery.expiresAt instanceof Date);
  }
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
      academicSnapshots: [
        {
          schemaVersion: 1,
          id: "2026-2027-fall",
          academicYear: "2026-2027",
          term: "fall",
          termLabel: "第一学期",
          importedAt: "2026-10-06T05:40:52.000Z",
          sections: [],
          exams: [],
          examStatus: "unavailable",
        },
      ],
      trainingPlan: {
        schemaVersion: 1,
        planNumber: "P2025",
        planName: "2025级审计学培养方案",
        majorCode: "120207",
        majorName: "审计学",
        cohortYear: 2025,
        requiredCredits: 160,
        categories: [
          { code: "A", name: "专业必修课", requiredCredits: null },
        ],
        courses: [
          {
            courseCode: "31131862",
            courseName: "内部审计",
            categoryCode: "A",
            categoryName: "专业必修课",
            attribute: "required",
            credits: 2,
            replacementCourseCodes: [],
          },
        ],
        importedAt: "2026-10-04T01:02:03.000Z",
      },
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

    const invalidExamStatus = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
        Cookie: cookie,
      },
      body: JSON.stringify({
        ...write,
        state: {
          ...state,
          academicSnapshots: state.academicSnapshots.map((snapshot) => ({
            ...snapshot,
            examStatus: "unknown",
          })),
        },
      }),
    });
    assert.equal(invalidExamStatus.status, 400);

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
    assert.equal(
      acceptedBody.state.academicSnapshots[0].examStatus,
      "unavailable",
    );
    assert.equal(acceptedBody.state.trainingPlan.courses.length, 1);
    assert.equal(
      acceptedBody.state.trainingPlan.categories[0].requiredCredits,
      null,
    );

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
      password: "Moonlight!2026-Long",
      schoolAccount: "2026123456",
    };

    const registered = await registerWithProof(`${baseUrl}/api/auth/register`, {
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

    const duplicate = await registerWithProof(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(registration),
    });
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).error, "invalid_registration_verification");

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

test("HTTP registration accepts one-character usernames and reset enforces the shared eight-character minimum", async () => {
  await withServer(async ({ baseUrl }) => {
    const headers = { "Content-Type": "application/json", Origin: "https://dufesh.cn" };
    const post = (path, body) => fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const short = await post("/api/auth/register", { username: "A", email: "single@example.com", password: "river77" });
    assert.equal(short.status, 400);
    const invalid = await short.json();
    assert.equal(invalid.error, "invalid_registration");
    assert.deepEqual(Object.keys(invalid.fields), ["password"]);
    assert.match(invalid.fields.password, /8—128/u);
    const registered = await registerWithProof(`${baseUrl}/api/auth/register`, { method: "POST", headers,
      body: JSON.stringify({ username: "A", email: "single@example.com", password: "aRiver77" }) });
    assert.equal(registered.status, 201);
    assert.equal((await registered.json()).user.username, "A");
    const duplicate = await registerWithProof(`${baseUrl}/api/auth/register`, { method: "POST", headers,
      body: JSON.stringify({ username: "Ａ", email: "duplicate@example.com", password: "aRiver77" }) });
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).error, "invalid_registration_verification");
    const requested = await post("/api/auth/password/reset/request", { identifier: "single@example.com" });
    const { debugToken } = await requested.json();
    assert.equal(requested.status, 202); assert.equal(isOpaqueToken(debugToken), true);
    const rejected = await post("/api/auth/password/reset/confirm", { token: debugToken, password: "river77" });
    assert.equal(rejected.status, 400);
    const accepted = await post("/api/auth/password/reset/confirm", { token: debugToken, password: "harbor88" });
    assert.equal(accepted.status, 200);
    const login = await post("/api/auth/login", { identifier: "ａ", password: "harbor88" });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.username, "A");
  });
});

test("SMTP registration permits separate momo profiles but no caller-selected names or privilege fields", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const headers = { "Content-Type": "application/json", Origin: "https://dufesh.cn" };
    const signUp = (body) => registerWithProof(`${baseUrl}/api/auth/register`, { method: "POST", headers, body: JSON.stringify(body) });
    const accounts = [];
    for (const [username, email, displayName] of [["海", "momo-one@example.com", "momo"], ["风", "momo-two@example.com", "ＭＯＭＯ"]]) {
      const response = await signUp({ username, email, displayName, password: "river777" });
      assert.equal(response.status, 201);
      const body = await response.json();
      accounts.push(body.user);
      assert.equal(body.user.username, username);
      assert.equal(body.user.accountName, username);
      assert.equal(body.user.displayName, "momo");
      assert.equal(body.user.nameMode, "momo");
      const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
      const session = await (await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookie } })).json();
      assert.equal(session.user.role, "user");
      assert.equal(session.user.id, body.user.id);
      assert.equal(session.user.accountName, username);
      const oldClientSave = await fetch(`${baseUrl}/api/auth/profile`, { method: "PUT", headers: { ...headers, Cookie: cookie },
        body: JSON.stringify({ username, displayName: "momo", schoolAccount: "20261234" }) });
      assert.equal(oldClientSave.status, 200);
      const updated = (await oldClientSave.json()).profile;
      assert.equal(updated.accountName, username);
      assert.equal(updated.displayName, "momo");
      assert.equal(updated.nameMode, "momo");
      assert.equal(updated.schoolAccount, "20261234");
    }
    assert.notEqual(accounts[0].id, accounts[1].id);
    const reservedLogin = await signUp({ username: "MOMO", email: "actual-momo@example.com", password: "river777" });
    assert.equal(reservedLogin.status, 201);
    assert.equal((await reservedLogin.json()).user.nameMode, "name");
    const invalidName = await signUp({ username: "月", email: "invalid-name@example.com", displayName: "任意昵称", password: "river777" });
    assert.equal(invalidName.status, 400);
    assert.deepEqual(Object.keys((await invalidName.json()).fields), ["displayName"]);
    const privilege = await signUp({ username: "云", email: "privilege-name@example.com", displayName: "momo", password: "river777", role: "admin", verified: true });
    assert.equal(privilege.status, 400);
    assert.equal((await privilege.json()).error, "invalid_registration_verification");
    assert.equal(store.credentialPrincipals.size, 6);
    const duplicate = await signUp({ username: "海", email: "duplicate-momo@example.com", displayName: "momo", password: "river777" });
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).error, "invalid_registration_verification");
    const repeatedMomoLogin = await signUp({ username: "momo", email: "repeat-actual-momo@example.com", displayName: "momo", password: "river777" });
    assert.equal(repeatedMomoLogin.status, 400);
  });
});

test("registration maps a reserved public name conflict without exposing private account details", async () => {
  await withServer(async ({ baseUrl, store }) => {
    store.registerCredentialUser = async () => { throw Object.assign(new Error("secret-email@example.com DB details"), { code: "AUTH_NAME_TAKEN" }); };
    const response = await registerWithProof(`${baseUrl}/api/auth/register`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://dufesh.cn" },
      body: JSON.stringify({ username: "云", email: "public-conflict@example.com", password: "river777" }) });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "name_conflict", fields: { displayName: "这个名字已被使用" } });
  });
});

test("name-change requests derive the account and session from authentication and remain pending", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const { principal, cookie } = seedLegacyCredential(store);
    const inputs = [];
    const receipts = new Map();
    store.getAccountNameChange = async userId => receipts.get(userId) ?? null;
    store.requestAccountNameChange = async input => {
      inputs.push(input);
      const receipt = { id: "00000000-0000-4000-8000-000000000901", userId: input.userId,
        username: principal.username, displayName: principal.displayName, requestedUsername: input.username ?? null,
        requestedDisplayName: input.displayName ?? null, status: "pending", reason: null, createdAt: new Date(0).toISOString(), reviewedAt: null };
      receipts.set(input.userId, receipt); return receipt;
    };
    const headers = { "Content-Type": "application/json", Origin: "https://dufesh.cn", Cookie: cookie };
    const post = (body, extraHeaders = {}) => fetch(`${baseUrl}/api/auth/name-change`, { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${baseUrl}/api/auth/name-change`)).status, 401);
    assert.equal((await post({ displayName: "海风" }, { Origin: "https://attacker.invalid" })).status, 403);
    assert.equal((await post({ displayName: "海风" }, { "X-Account-Owner": "previous-user" })).status, 409);
    for (const body of [{ displayName: "海风", userId: "victim" }, { username: "海", role: "admin" }, { schoolAccount: "20260001" }, {}, { displayName: "momo" }]) {
      assert.equal((await post(body)).status, 400);
    }
    assert.equal(inputs.length, 0);
    assert.equal((await fetch(`${baseUrl}/api/auth/name-change?userId=victim`, { headers })).status, 400);
    const empty = await fetch(`${baseUrl}/api/auth/name-change`, { headers });
    assert.deepEqual(await empty.json(), { request: null });
    const requested = await post({ username: " Ａ ", displayName: " 海风 " });
    assert.equal(requested.status, 202);
    assert.match(requested.headers.get("Cache-Control"), /no-store/u);
    const proposed = (await requested.json()).request;
    assert.equal(proposed.status, "pending");
    assert.deepEqual(inputs[0], { userId: principal.id, sessionId: "legacy-fixture-session", username: "A", normalizedUsername: "a", displayName: "海风" });
    assert.equal(principal.username, "legacy-fixture");
    assert.equal(principal.displayName, "合成旧用户");
    const latest = await fetch(`${baseUrl}/api/auth/name-change`, { headers });
    assert.deepEqual(await latest.json(), { request: proposed });
    const otherToken = createOpaqueToken();
    store.sessions.set(tokenDigest(otherToken, config.tokenPepper), { id: "another-session", userId: "another-user" });
    const other = await fetch(`${baseUrl}/api/auth/name-change`, { headers: { Cookie: `${config.sessionCookie}=${otherToken}` } });
    assert.deepEqual(await other.json(), { request: null });
    const staleTab = await post({ displayName: "旧账号草稿" }, { Cookie: `${config.sessionCookie}=${otherToken}`, "X-Account-Owner": principal.id });
    assert.equal(staleTab.status, 409);
    assert.deepEqual(await staleTab.json(), { error: "account_changed" });
    assert.equal(inputs.length, 1);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const token = createOpaqueToken();
      store.sessions.set(tokenDigest(token, config.tokenPepper), { id: `renewed-${attempt}`, userId: principal.id });
      const result = await post({ displayName: "海风" }, { Cookie: `${config.sessionCookie}=${token}`, "X-Forwarded-For": `192.0.2.${attempt}` });
      assert.equal(result.status, attempt < 3 ? 202 : 429);
    }
    const fresh = await post({ displayName: "其他名字" }, { Cookie: `${config.sessionCookie}=${otherToken}` });
    assert.equal(fresh.status, 202);
    assert.equal(inputs.at(-1).userId, "another-user");
    assert.equal(inputs.at(-1).sessionId, "another-session");
  });
});

test("name-change dependency conflicts and expired sessions return fixed public errors", async () => {
  for (const [code, status, error] of [["AUTH_NAME_TAKEN", 409, "name_conflict"], ["AUTH_NAME_CHANGE_CONFLICT", 409, "name_change_conflict"],
    ["AUTH_NAME_CHANGE_INVALID", 400, "invalid_name_change"], ["AUTH_SESSION_REQUIRED", 401, "authentication_required"]]) {
    await withServer(async ({ baseUrl, store }) => {
      const { cookie } = seedLegacyCredential(store);
      store.requestAccountNameChange = async () => { throw Object.assign(new Error("DB implementation and secret account details"), { code }); };
      const response = await fetch(`${baseUrl}/api/auth/name-change`, { method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://dufesh.cn", Cookie: cookie }, body: JSON.stringify({ displayName: "海风" }) });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
    });
  }
});

test("name-mode switching has strict authenticated input and honors server cooldown metadata", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const { principal, cookie } = seedLegacyCredential(store);
    const inputs = [];
    const availableAt = "2026-10-19T00:00:00.000Z";
    let mode = "name";
    store.setAccountNameMode = async input => {
      inputs.push(input);
      if (mode === "momo" && input.mode !== mode) throw Object.assign(new Error("private internal date"), { code: "AUTH_NAME_MODE_COOLDOWN", availableAt });
      mode = input.mode;
      return { accountName: principal.displayName, displayName: mode === "momo" ? "momo" : principal.displayName,
        nameMode: mode, nameModeChangedAt: "2026-10-12T00:00:00.000Z", nameModeAvailableAt: availableAt };
    };
    const headers = { "Content-Type": "application/json", Origin: "https://dufesh.cn", Cookie: cookie };
    const post = (body, extra = {}) => fetch(`${baseUrl}/api/auth/name-mode`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    assert.equal((await post({ mode: "momo" }, { Cookie: "" })).status, 401);
    assert.equal((await post({ mode: "momo" }, { Origin: "https://attacker.invalid" })).status, 403);
    assert.equal((await post({ mode: "momo" }, { "X-Account-Owner": "previous-user" })).status, 409);
    for (const body of [{}, [], { mode: "admin" }, { mode: "momo", userId: "victim" }, { mode: "momo", now: "2099-01-01" },
      { mode: "momo", displayName: "抢名字" }, { mode: "momo", role: "admin" }]) assert.equal((await post(body)).status, 400);
    assert.equal(inputs.length, 0);
    const otherToken = createOpaqueToken();
    store.sessions.set(tokenDigest(otherToken, config.tokenPepper), { id: "mode-other-session", userId: "mode-other-user" });
    const staleTab = await post({ mode: "momo" }, { Cookie: `${config.sessionCookie}=${otherToken}`, "X-Account-Owner": principal.id });
    assert.equal(staleTab.status, 409);
    assert.deepEqual(await staleTab.json(), { error: "account_changed" });
    assert.equal(inputs.length, 0);
    const switched = await post({ mode: "momo" });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).nameMode, "momo");
    assert.deepEqual(inputs[0], { userId: principal.id, sessionId: "legacy-fixture-session", mode: "momo" });
    assert.equal(principal.displayName, "合成旧用户");
    const sameMode = await post({ mode: "momo" });
    assert.equal(sameMode.status, 200);
    assert.equal((await sameMode.json()).nameModeAvailableAt, availableAt);
    const tooSoon = await post({ mode: "name" }, { "X-Forwarded-For": "192.0.2.99" });
    assert.equal(tooSoon.status, 409);
    assert.deepEqual(await tooSoon.json(), { error: "name_mode_cooldown", availableAt });
  });
});

test("name-mode failures do not expose dependency details or fall back to unauthenticated writes", async () => {
  for (const [code, status, error] of [["AUTH_NAME_MODE_INVALID", 400, "invalid_name_mode"],
    ["AUTH_NAME_MODE_NAME_REQUIRED", 409, "name_mode_name_required"], ["AUTH_SESSION_REQUIRED", 401, "authentication_required"]]) {
    await withServer(async ({ baseUrl, store }) => {
      const { cookie } = seedLegacyCredential(store);
      store.setAccountNameMode = async () => { throw Object.assign(new Error("private implementation details"), { code }); };
      const response = await fetch(`${baseUrl}/api/auth/name-mode`, { method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://dufesh.cn", Cookie: cookie }, body: JSON.stringify({ mode: "momo" }) });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
    });
  }
});

test("repeated credential failures lock the account even when the password later matches", async () => {
  await withServer(async ({ baseUrl }) => {
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://dufesh.cn",
    };
    await registerWithProof(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: "locked-student",
        email: "locked@example.com",
        password: "Moonlight!2026-Long",
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
        password: "Moonlight!2026-Long",
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
    const registered = await registerWithProof(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: "profile-student",
        email: "profile@example.com",
        password: "Moonlight!2026-Long",
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

    const rename = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PUT",
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify({
        username: "海风-2026",
        displayName: "海风",
        schoolAccount: "2026123456",
      }),
    });
    assert.equal(rename.status, 409);
    assert.deepEqual(await rename.json(), { error: "name_review_required" });
    const updated = await fetch(`${baseUrl}/api/auth/profile`, {
      method: "PUT",
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify({ username: "profile-student", displayName: "profile-student", schoolAccount: " 2026123456 " }),
    });
    const updatedBody = await updated.json();
    assert.equal(updated.status, 200);
    assert.equal(updatedBody.profile.username, "profile-student");
    assert.equal(updatedBody.profile.displayName, "profile-student");
    assert.equal(updatedBody.profile.schoolAccount, "2026123456");
    assert.equal(updatedBody.profile.schoolAccountVerified, false);
  });
});

test("email verification is session-bound, single-use, and updates the account", async () => {
  await withServer(async ({ baseUrl, store }) => {
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://dufesh.cn",
    };
    const register = async (username, email) => {
      const response = await registerWithProof(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          username,
          email,
          password: "Moonlight!2026-Long",
        }),
      });
      assert.equal(response.status, 201);
      return response.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
    };

    const ownerCookie = seedLegacyCredential(store, "verify@example.com").cookie;
    const otherCookie = await register("other-student", "other@example.com");

    const untrusted = await fetch(
      `${baseUrl}/api/auth/email/verification/request`,
      {
        method: "POST",
        headers: {
          Origin: "https://attacker.invalid",
          Cookie: ownerCookie,
        },
      },
    );
    assert.equal(untrusted.status, 403);

    const requested = await fetch(
      `${baseUrl}/api/auth/email/verification/request`,
      {
        method: "POST",
        headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ password: "LegacyHarbor!2026" }),
      },
    );
    const requestedBody = await requested.json();
    assert.equal(requested.status, 202);
    assert.equal(isOpaqueToken(requestedBody.debugToken), true);

    const requestedAgain = await fetch(
      `${baseUrl}/api/auth/email/verification/request`,
      {
        method: "POST",
        headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ password: "LegacyHarbor!2026" }),
      },
    );
    const requestedAgainBody = await requestedAgain.json();
    assert.equal(requestedAgain.status, 202);
    assert.notEqual(requestedAgainBody.debugToken, requestedBody.debugToken);

    const superseded = await fetch(
      `${baseUrl}/api/auth/email/verification/confirm`,
      {
        method: "POST",
        headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ token: requestedBody.debugToken }),
      },
    );
    assert.equal(superseded.status, 400);

    const crossAccount = await fetch(
      `${baseUrl}/api/auth/email/verification/confirm`,
      {
        method: "POST",
        headers: { ...headers, Cookie: otherCookie },
        body: JSON.stringify({ token: requestedAgainBody.debugToken }),
      },
    );
    assert.equal(crossAccount.status, 400);

    const confirmed = await fetch(
      `${baseUrl}/api/auth/email/verification/confirm`,
      {
        method: "POST",
        headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ token: requestedAgainBody.debugToken }),
      },
    );
    assert.equal(confirmed.status, 200);

    const replay = await fetch(
      `${baseUrl}/api/auth/email/verification/confirm`,
      {
        method: "POST",
        headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ token: requestedAgainBody.debugToken }),
      },
    );
    assert.equal(replay.status, 400);

    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal((await session.json()).user.emailVerified, true);
  });
});

test("avatar upload validates content, serves versioned WebP, and supports deletion", async () => {
  await withServer(async ({ baseUrl }) => {
    const registration = await registerWithProof(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dufesh.cn",
      },
      body: JSON.stringify({
        username: "avatar-student",
        email: "avatar@example.com",
        password: "Moonlight!2026-Long",
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
