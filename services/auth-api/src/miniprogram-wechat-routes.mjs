import { createOpaqueToken, isOpaqueToken, tokenDigest } from "./tokens.mjs";
import { validWechatCode } from "./miniprogram-wechat-provider.mjs";

export function miniWechatOpenidDigest(appId, openid, pepper) {
  return tokenDigest(`miniprogram-wechat-openid:v1:${appId}:${openid}`, pepper);
}
export function miniWechatChallengeDigest(token, pepper) {
  return tokenDigest(`miniprogram-wechat-binding:v1:${token}`, pepper);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function exactObject(body, fields) {
  return body && !Array.isArray(body) && typeof body === "object" &&
    Object.keys(body).length === fields.length && fields.every(key => Object.hasOwn(body, key));
}

export function createMiniProgramWechatRequestHandler({ store, config, provider, passwordService, dummyPasswordHash,
  authLimit, readJsonBody, sendJson, methodNotAllowed, bearer, userView, miniSessionDigest }) {
  async function ready() {
    return config.miniProgramWechatEnabled === true && config.credentialsEnabled !== false && Boolean(passwordService) &&
      /^wx[0-9a-f]{16}$/u.test(config.miniProgramWechatAppId ?? "") &&
      /^[A-Za-z0-9]{32}$/u.test(config.miniProgramWechatAppSecret ?? "") && Boolean(provider) &&
      typeof store.miniProgramWechatReady === "function" && await store.miniProgramWechatReady();
  }
  async function linkedState(userId) {
    if (!(await ready())) return {};
    return { wechatLinked: await store.hasMiniProgramWechatIdentity({ appId: config.miniProgramWechatAppId, userId }) };
  }
  async function readBody(request, response) {
    try { return { value: await readJsonBody(request, 8_192) }; }
    catch (error) {
      if (["JSON_CONTENT_TYPE_REQUIRED", "JSON_BODY_INVALID", "REQUEST_BODY_TOO_LARGE"].includes(error.code)) {
        sendJson(response, error.code === "REQUEST_BODY_TOO_LARGE" ? 413 : 400, { error: "invalid_wechat_request" });
        return null;
      }
      throw error;
    }
  }
  function storeRejection(response, error) {
    const errors = {
      MINI_AUTHENTICATION_REQUIRED: [401, "authentication_required"],
      MINI_BINDING_CREDENTIALS_INVALID: [401, "invalid_binding_credentials"],
      MINI_BINDING_CHALLENGE_INVALID: [409, "binding_challenge_expired"],
      MINI_WECHAT_ACCOUNT_CONFLICT: [409, "wechat_account_conflict"],
    };
    const failure = errors[error.code];
    if (!failure) return false;
    sendJson(response, failure[0], { error: failure[1] });
    return true;
  }
  async function currentSession(request) {
    const token = bearer(request);
    return { token, session: token ? await store.getActiveSession(miniSessionDigest(token, config.tokenPepper)) : null };
  }
  async function sessionReply(response, session, extra = {}) {
    sendJson(response, 200, { authenticated: true, user: userView(session),
      session: { expiresAt: session.expiresAt }, ...extra });
  }
  return { linkedState, async handleRequest(request, response, url) {
    if (url.pathname === "/api/auth/miniprogram/capabilities") {
      if (request.method !== "GET") { methodNotAllowed(response, "GET"); return true; }
      const enabled = await ready();
      sendJson(response, 200, { passwordLogin: config.credentialsEnabled !== false && Boolean(passwordService),
        wechatLogin: enabled, wechatBinding: enabled });
      return true;
    }
    if (!["/api/auth/miniprogram/wechat", "/api/auth/miniprogram/wechat/bind"].includes(url.pathname)) return false;
    if (request.method !== "POST") { methodNotAllowed(response, "POST"); return true; }
    if (!(await ready())) { sendJson(response, 503, { error: "wechat_login_unavailable" }); return true; }
    const { token, session } = await currentSession(request);
    // A presented invalid/old credential must not become an anonymous exchange.
    if ((Object.hasOwn(request.headers, "authorization") && !session) ||
        (url.pathname.endsWith("/bind") && !session)) {
      sendJson(response, 401, { error: "authentication_required" }); return true;
    }
    if (!(await authLimit(request, session?.userId ?? null, "credential", session ? "all" : "network"))) {
      response.setHeader("Retry-After", "60"); sendJson(response, 429, { error: "wechat_rate_limit_exceeded" }); return true;
    }
    const parsed = await readBody(request, response);
    if (!parsed) return true;
    const body = parsed.value;
    if (url.pathname.endsWith("/bind")) {
      if (!exactObject(body, ["challengeToken", "expectedOwner", "password"]) || !isOpaqueToken(body.challengeToken) ||
          typeof body.expectedOwner !== "string" || !UUID.test(body.expectedOwner) ||
          typeof body.password !== "string" || !body.password || Array.from(body.password).length > 128) {
        sendJson(response, 400, { error: "invalid_wechat_request" }); return true;
      }
      if (body.expectedOwner !== session.userId) { sendJson(response, 409, { error: "account_changed" }); return true; }
      const principal = await store.getMiniProgramCredentialPrincipal(session.userId);
      const matches = await passwordService.verify(principal?.passwordHash ?? await dummyPasswordHash, body.password);
      const locked = principal?.lockedUntil && Date.parse(principal.lockedUntil) > Date.now();
      if (!principal || !matches || locked || principal.status !== "active") {
        if (principal && !locked && principal.status === "active") await store.recordCredentialFailure(principal.id);
        sendJson(response, 401, { error: "invalid_binding_credentials" }); return true;
      }
      try {
        await store.bindMiniProgramWechatIdentity({ appId: config.miniProgramWechatAppId, userId: session.userId,
          sessionId: session.id, sessionTokenHash: miniSessionDigest(token, config.tokenPepper),
          expectedPasswordHash: principal.passwordHash, challengeHash: miniWechatChallengeDigest(body.challengeToken, config.tokenPepper) });
      } catch (error) { if (storeRejection(response, error)) return true; throw error; }
      const current = await store.getActiveSession(miniSessionDigest(token, config.tokenPepper));
      if (!current || current.id !== session.id || current.userId !== session.userId) {
        sendJson(response, 401, { error: "authentication_required" }); return true;
      }
      await sessionReply(response, current, { linked: true, wechatLinked: true });
      return true;
    }
    if (!exactObject(body, ["code"]) || !validWechatCode(body.code)) {
      sendJson(response, 400, { error: "invalid_wechat_request" }); return true;
    }
    let identity;
    try { identity = await provider.exchangeCode(body.code); }
    catch (error) {
      sendJson(response, error.code === "WECHAT_LOGIN_REJECTED" ? 401 : 503,
        { error: error.code === "WECHAT_LOGIN_REJECTED" ? "wechat_login_failed" : "wechat_login_unavailable" });
      return true;
    }
    // Defence in depth for injected adapters: only server-obtained OpenID is
    // consumed, never a client profile, UnionID, or phone number.
    if (typeof identity?.openid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(identity.openid)) {
      sendJson(response, 503, { error: "wechat_login_unavailable" }); return true;
    }
    const appId = config.miniProgramWechatAppId;
    const openidHash = miniWechatOpenidDigest(appId, identity.openid, config.tokenPepper);
    if (!session && !(await authLimit(request, `mini-wechat:${appId}:${openidHash}`, "credential", "identity"))) {
      response.setHeader("Retry-After", "60"); sendJson(response, 429, { error: "wechat_rate_limit_exceeded" }); return true;
    }
    const existing = await store.getMiniProgramWechatIdentity({ appId, openidHash });
    if (session && existing) {
      if (existing.userId !== session.userId) { sendJson(response, 409, { error: "wechat_account_conflict" }); return true; }
      const current = await store.getActiveSession(miniSessionDigest(token, config.tokenPepper));
      if (!current || current.id !== session.id || current.userId !== session.userId) {
        sendJson(response, 401, { error: "authentication_required" }); return true;
      }
      await sessionReply(response, current, { linked: true, wechatLinked: true }); return true;
    }
    if (!existing) {
      const challengeToken = createOpaqueToken();
      let challenge;
      try {
        challenge = await store.createMiniProgramWechatChallenge({ appId, openidHash,
          challengeHash: miniWechatChallengeDigest(challengeToken, config.tokenPepper),
          ...(session ? { userId: session.userId, sessionId: session.id,
            sessionTokenHash: miniSessionDigest(token, config.tokenPepper) } : {}) });
      } catch (error) { if (storeRejection(response, error)) return true; throw error; }
      sendJson(response, 200, { authenticated: false, needsBinding: true, binding: {
        challengeToken, expiresAt: challenge.expiresAt, requiresAuthenticatedExchange: !session } });
      return true;
    }
    const inputDevice = request.headers["x-dufesh-mini-device"];
    const deviceToken = isOpaqueToken(inputDevice) ? inputDevice : createOpaqueToken();
    const device = await store.getOrCreateAnonymousDevice(tokenDigest(`miniprogram-device:v1:${deviceToken}`, config.tokenPepper));
    const accessToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + Math.min(config.sessionMaxAgeSeconds, 86_400) * 1000);
    try {
      await store.createMiniProgramWechatSession({ appId, openidHash, userId: existing.userId, anonymousDeviceId: device.id,
        sessionTokenHash: miniSessionDigest(accessToken, config.tokenPepper), sessionExpiresAt: expiresAt });
    } catch (error) { if (storeRejection(response, error)) return true; throw error; }
    const current = await store.getActiveSession(miniSessionDigest(accessToken, config.tokenPepper));
    if (!current || current.userId !== existing.userId) { sendJson(response, 401, { error: "authentication_required" }); return true; }
    sendJson(response, 200, { authenticated: true, linked: true, wechatLinked: true, user: userView(current),
      session: { accessToken, expiresAt: current.expiresAt }, deviceToken });
    return true;
  } };
}
