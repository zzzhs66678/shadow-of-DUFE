// Only the server talks to WeChat. Never retain or forward the session key,
// UnionID, provider error text, or a URL containing the application secret.
export function validWechatCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}

function providerError(code) {
  const error = new Error("WeChat login is unavailable");
  error.code = code;
  return error;
}

export function createMiniProgramWechatProvider(config, { fetchImpl = fetch } = {}) {
  if (!config.miniProgramWechatEnabled) return null;
  return {
    async exchangeCode(code) {
      if (!validWechatCode(code)) throw providerError("WECHAT_LOGIN_REJECTED");
      const endpoint = new URL("https://api.weixin.qq.com/sns/jscode2session");
      endpoint.searchParams.set("appid", config.miniProgramWechatAppId);
      endpoint.searchParams.set("secret", config.miniProgramWechatAppSecret);
      endpoint.searchParams.set("js_code", code);
      endpoint.searchParams.set("grant_type", "authorization_code");
      try {
        const response = await fetchImpl(endpoint, {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(5_000),
          headers: { Accept: "application/json" },
        });
        if (!response.ok || !response.body) throw providerError("WECHAT_EXCHANGE_UNAVAILABLE");
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 8_192) {
            throw providerError("WECHAT_EXCHANGE_UNAVAILABLE");
          }
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body?.errcode && body.errcode !== 0) throw providerError("WECHAT_LOGIN_REJECTED");
        if (!body || typeof body.openid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(body.openid) ||
            typeof body.session_key !== "string" || body.session_key.length > 256 || !body.session_key) {
          throw providerError("WECHAT_EXCHANGE_UNAVAILABLE");
        }
        return { openid: body.openid };
      } catch (error) {
        // Do not preserve a fetch/JSON/provider cause: it may include a URL,
        // secret, code, session key, or an upstream response fragment.
        throw providerError(error.code === "WECHAT_LOGIN_REJECTED" ? error.code : "WECHAT_EXCHANGE_UNAVAILABLE");
      }
    },
  };
}
