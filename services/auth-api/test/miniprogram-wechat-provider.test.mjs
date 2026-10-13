import assert from "node:assert/strict";
import test from "node:test";
import { createMiniProgramWechatProvider } from "../src/miniprogram-wechat-provider.mjs";
import { loadConfig } from "../src/config.mjs";

const syntheticConfig = { miniProgramWechatEnabled: true, miniProgramWechatAppId: "wx0000000000000000",
  miniProgramWechatAppSecret: "S".repeat(32) };
const baseEnv = { AUTH_TOKEN_PEPPER: "synthetic-config-pepper-32-characters", POSTGRES_PASSWORD: "synthetic-db-fixture" };

test("native WeChat remains off by default and enabled mode requires complete server configuration", () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.miniProgramWechatEnabled, false);
  assert.equal(createMiniProgramWechatProvider(config), null);
  for (const missing of [{}, { AUTH_MINIPROGRAM_ENABLED: "true" },
    { AUTH_MINIPROGRAM_ENABLED: "true", AUTH_MINIPROGRAM_WECHAT_APP_ID: "wx0000000000000000" },
    { AUTH_MINIPROGRAM_ENABLED: "true", AUTH_MINIPROGRAM_WECHAT_APP_ID: "wx0000000000000000",
      AUTH_MINIPROGRAM_WECHAT_APP_SECRET: "S".repeat(32), AUTH_CREDENTIALS_ENABLED: "false" }]) {
    assert.throws(() => loadConfig({ ...baseEnv, AUTH_MINIPROGRAM_WECHAT_ENABLED: "true", ...missing }), /server-side app credentials/u);
  }
  const enabled = loadConfig({ ...baseEnv, AUTH_MINIPROGRAM_ENABLED: "true", AUTH_MINIPROGRAM_WECHAT_ENABLED: "true",
    AUTH_MINIPROGRAM_WECHAT_APP_ID: syntheticConfig.miniProgramWechatAppId,
    AUTH_MINIPROGRAM_WECHAT_APP_SECRET: syntheticConfig.miniProgramWechatAppSecret });
  assert.equal(enabled.miniProgramWechatEnabled, true);
});

test("code exchange uses only fixed WeChat HTTPS endpoint and discards session key, UnionID and profile", async () => {
  let requests = 0;
  const provider = createMiniProgramWechatProvider(syntheticConfig, { fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url.origin, "https://api.weixin.qq.com");
    assert.equal(url.pathname, "/sns/jscode2session");
    assert.equal(url.searchParams.get("grant_type"), "authorization_code");
    assert.equal(url.searchParams.get("appid"), syntheticConfig.miniProgramWechatAppId);
    assert.equal(url.searchParams.get("secret"), syntheticConfig.miniProgramWechatAppSecret);
    assert.equal(url.searchParams.get("js_code"), "fixture_code");
    assert.equal(options.redirect, "error");
    assert.equal(options.method, "GET");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ openid: "synthetic_openid_A", session_key: "synthetic_session_key",
      unionid: "synthetic_union_id", nickname: "momo" }));
  } });
  assert.deepEqual(await provider.exchangeCode("fixture_code"), { openid: "synthetic_openid_A" });
  assert.equal(requests, 1);
});

test("provider failures have fixed messages without upstream bodies, URL, code, secret, or causes", async () => {
  for (const failure of [
    async () => { throw new Error("upstream leaked URL secret session_key synthetic-sensitive-body"); },
    async () => new Response(JSON.stringify({ errcode: 40029, errmsg: "sensitive-provider-text" })),
    async () => new Response("sensitive-invalid-json"),
    async () => new Response(JSON.stringify({ openid: "synthetic_openid_A" })),
    async () => new Response("x".repeat(8193)),
    async () => new Response("redirect-sensitive-body", { status: 302, headers: { location: "https://other.invalid" } }),
  ]) {
    const provider = createMiniProgramWechatProvider(syntheticConfig, { fetchImpl: failure });
    await assert.rejects(provider.exchangeCode("fixture_code"), error => {
      assert.equal(error.message, "WeChat login is unavailable");
      assert.equal(error.cause, undefined);
      assert.ok(["WECHAT_LOGIN_REJECTED", "WECHAT_EXCHANGE_UNAVAILABLE"].includes(error.code));
      return true;
    });
  }
});

test("untrusted codes never initiate provider requests", async () => {
  let requests = 0;
  const provider = createMiniProgramWechatProvider(syntheticConfig, { fetchImpl: async () => { requests++; } });
  for (const code of ["", "a".repeat(257), "https://other.invalid", {}, null, "a\n"]) {
    await assert.rejects(provider.exchangeCode(code), { code: "WECHAT_LOGIN_REJECTED" });
  }
  assert.equal(requests, 0);
});
