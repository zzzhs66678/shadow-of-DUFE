import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createAuthServer } from "../src/server.mjs";
import { createOpaqueToken, tokenDigest } from "../src/tokens.mjs";
import { miniSessionDigest } from "../src/miniprogram-routes.mjs";
import { miniWechatOpenidDigest } from "../src/miniprogram-wechat-routes.mjs";
import { parseTrustedProxies } from "../src/request-security.mjs";

const pepper = "synthetic-wechat-budget-pepper-32-characters", appId = "wx0000000000000000";
function bucket(capacity) {
  const calls = [], balances = new Map();
  return { calls, balances, async consume(key) {
    calls.push(key);
    const remaining = balances.get(key) ?? capacity;
    if (remaining <= 0) return false;
    balances.set(key, remaining - 1); return true;
  } };
}
async function fixture({ networkCapacity = 100 } = {}) {
  const account = bucket(1), credential = bucket(1), network = bucket(networkCapacity);
  const providerCodes = [], challenged = [], sessions = new Map();
  const config = { tokenPepper: pepper, miniProgramEnabled: true, credentialsEnabled: true, miniProgramWechatEnabled: true,
    miniProgramWechatAppId: appId, miniProgramWechatAppSecret: "S".repeat(32), registrationMode: "disabled",
    passwordResetMode: "disabled", emailVerificationMode: "disabled", sessionMaxAgeSeconds: 2592000,
    allowedOrigins: new Set(["https://dufesh.cn"]), trustedProxyRanges: parseTrustedProxies("127.0.0.1/32") };
  const store = {
    async miniProgramWechatReady() { return true; },
    async getActiveSession(hash) { return sessions.get(hash) ?? null; },
    async getMiniProgramWechatIdentity() { return null; },
    async createMiniProgramWechatChallenge(input) { challenged.push(input); return { expiresAt: new Date(Date.now() + 300000).toISOString() }; },
  };
  const server = createAuthServer({ store, config, passwordService: { hash: async () => "synthetic-dummy" },
    miniProgramWechatProvider: { async exchangeCode(code) {
      providerCodes.push(code);
      if (code.startsWith("invalid")) { const error = new Error("synthetic-rejection"); error.code = "WECHAT_LOGIN_REJECTED"; throw error; }
      return { openid: code.startsWith("a_") ? "synthetic_identity_A" : "synthetic_identity_B" };
    } }, rateLimiters: { read: { consume: async () => true }, write: { consume: async () => true },
      authNetwork: network, authAccount: account, credential } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  async function exchange(code, token) {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/auth/miniprogram/wechat", {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify({ code }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { exchange, account, credential, network, providerCodes, challenged, sessions,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

test("anonymous WeChat identities have independent account budgets, and each exchange consumes network once", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.exchange("a_first")).status, 200);
    assert.equal((await f.exchange("a_another_code_same_identity")).status, 429);
    assert.equal((await f.exchange("b_first")).status, 200);
    assert.equal(f.network.calls.length, 3);
    const identityA = `mini-wechat:${appId}:${miniWechatOpenidDigest(appId, "synthetic_identity_A", pepper)}`;
    const identityB = `mini-wechat:${appId}:${miniWechatOpenidDigest(appId, "synthetic_identity_B", pepper)}`;
    assert.deepEqual(f.account.calls, [identityA, identityA, identityB].map(id => tokenDigest(`auth-account:${id}`, pepper)));
    assert.deepEqual(f.credential.calls, [identityA, identityA, identityB].map(id => tokenDigest(`credential:${id}`, pepper)));
    assert.equal(f.account.balances.size, 2); assert.equal(f.credential.balances.size, 2);
    assert.equal(f.challenged.length, 2);
  } finally { await f.close(); }
});

test("invalid and unverified codes consume no other account budget; network denies before further provider calls", async () => {
  const f = await fixture({ networkCapacity: 4 });
  try {
    assert.equal((await f.exchange("invalid_one")).status, 401);
    assert.equal((await f.exchange("invalid_two")).status, 401);
    assert.equal((await f.exchange("bad/code")).status, 400);
    assert.equal(f.account.calls.length, 0); assert.equal(f.credential.calls.length, 0);
    assert.equal(f.providerCodes.length, 2);
    assert.equal((await f.exchange("b_legitimate")).status, 200);
    assert.equal(f.account.balances.size, 1);
    assert.equal((await f.exchange("a_over_network_budget")).status, 429);
    assert.equal(f.providerCodes.length, 3);
    assert.equal(f.network.calls.length, 5);
    assert.equal(f.account.calls.length, 1); assert.equal(f.credential.calls.length, 1);
  } finally { await f.close(); }
});

test("authenticated exchange budgets use exact website UUID before provider call and preserve account isolation", async () => {
  const f = await fixture();
  try {
    const ownerA = randomUUID(), ownerB = randomUUID(), tokenA = createOpaqueToken(), tokenB = createOpaqueToken();
    f.sessions.set(miniSessionDigest(tokenA, pepper), { id: randomUUID(), userId: ownerA });
    f.sessions.set(miniSessionDigest(tokenB, pepper), { id: randomUUID(), userId: ownerB });
    assert.equal((await f.exchange("a_first", tokenA)).status, 200);
    assert.equal((await f.exchange("a_second", tokenA)).status, 429);
    assert.equal((await f.exchange("b_first", tokenB)).status, 200);
    assert.equal(f.providerCodes.length, 2);
    assert.deepEqual(f.account.calls, [ownerA, ownerA, ownerB].map(id => tokenDigest(`auth-account:${id}`, pepper)));
    assert.equal(f.network.calls.length, 3);
    assert.equal(f.account.balances.size, 2);
  } finally { await f.close(); }
});
