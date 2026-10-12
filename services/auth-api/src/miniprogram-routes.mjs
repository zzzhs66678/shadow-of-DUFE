import { createOpaqueToken, isOpaqueToken, tokenDigest } from "./tokens.mjs";
import { validateLogin } from "./credentials.mjs";

// Domain separation prevents a native bearer token from being a website Cookie,
// and prevents an existing website session token from authorizing native routes.
export function miniSessionDigest(token, pepper) {
  return tokenDigest(`miniprogram-session:v1:${token}`, pepper);
}
function bearer(request) {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
  const token = value.slice(7);
  return isOpaqueToken(token) ? token : null;
}
function userView(user) {
  return { id: user.userId ?? user.id, username: user.username, displayName: user.displayName,
    accountName: user.accountName ?? user.displayName, nameMode: user.nameMode ?? "name",
    nameModeAvailableAt: user.nameModeAvailableAt ?? null };
}
export function createMiniProgramRequestHandler({ store, config, passwordService, dummyPasswordHash,
  authLimit, readJsonBody, sendJson, methodNotAllowed }) {
  return async function handleMiniProgram(request, response, url) {
    if (!url.pathname.startsWith("/api/auth/miniprogram/")) return false;
    if (!config.miniProgramEnabled) { sendJson(response, 503, { error: "miniprogram_unavailable" }); return true; }
    // Native endpoints never consume browser cookies or relax website CSRF checks.
    if (Object.hasOwn(request.headers, "origin")) { sendJson(response, 403, { error: "native_client_required" }); return true; }
    if (url.search) { sendJson(response, 400, { error: "invalid_native_query" }); return true; }
    if (url.pathname === "/api/auth/miniprogram/login") {
      if (request.method !== "POST") { methodNotAllowed(response, "POST"); return true; }
      if (config.credentialsEnabled === false || !passwordService) {
        sendJson(response, 503, { error: "credential_login_not_ready" }); return true;
      }
      let body;
      try { body = await readJsonBody(request, 8192); }
      catch (error) {
        if (["JSON_CONTENT_TYPE_REQUIRED", "JSON_BODY_INVALID", "REQUEST_BODY_TOO_LARGE"].includes(error.code)) {
          sendJson(response, error.code === "REQUEST_BODY_TOO_LARGE" ? 413 : 400, { error: "invalid_login_request" }); return true;
        }
        throw error;
      }
      const login = body && !Array.isArray(body) && Object.keys(body).every(key => ["identifier", "password"].includes(key))
        ? validateLogin(body) : null;
      if (!(await authLimit(request, login?.identifier ?? "invalid", "credential"))) {
        response.setHeader("Retry-After", "60"); sendJson(response, 429, { error: "credential_rate_limit_exceeded" }); return true;
      }
      const principal = login ? await store.getCredentialPrincipal(login.identifier) : null;
      const matches = await passwordService.verify(principal?.passwordHash ?? await dummyPasswordHash, login?.password ?? "");
      const locked = principal?.lockedUntil && new Date(principal.lockedUntil).getTime() > Date.now();
      if (!principal || !matches || locked || principal.status !== "active") {
        if (principal && !locked && principal.status === "active") await store.recordCredentialFailure(principal.id);
        sendJson(response, 401, { error: "invalid_credentials" }); return true;
      }
      const inputDevice = request.headers["x-dufesh-mini-device"];
      const deviceToken = isOpaqueToken(inputDevice) ? inputDevice : createOpaqueToken();
      const device = await store.getOrCreateAnonymousDevice(tokenDigest(`miniprogram-device:v1:${deviceToken}`, config.tokenPepper));
      const token = createOpaqueToken();
      const expiresAt = new Date(Date.now() + Math.min(config.sessionMaxAgeSeconds, 86400) * 1000);
      try {
        await store.createCredentialSession({ userId: principal.id, expectedPasswordHash: principal.passwordHash,
          anonymousDeviceId: device.id, sessionTokenHash: miniSessionDigest(token, config.tokenPepper), sessionExpiresAt: expiresAt });
      } catch (error) {
        if (error.code === "AUTH_CREDENTIAL_LOGIN_REJECTED") { sendJson(response, 401, { error: "invalid_credentials" }); return true; }
        throw error;
      }
      sendJson(response, 200, { authenticated: true, user: userView(principal),
        session: { accessToken: token, expiresAt: expiresAt.toISOString() }, deviceToken });
      return true;
    }
    const actions = new Map([
      ["/api/auth/miniprogram/session", "GET"], ["/api/auth/miniprogram/snapshot", "GET"],
      ["/api/auth/miniprogram/logout", "POST"]
    ]);
    if (!actions.has(url.pathname)) { sendJson(response, 404, { error: "not_found" }); return true; }
    if (request.method !== actions.get(url.pathname)) { methodNotAllowed(response, actions.get(url.pathname)); return true; }
    const token = bearer(request);
    const session = token ? await store.getActiveSession(miniSessionDigest(token, config.tokenPepper)) : null;
    if (!session) { sendJson(response, 401, { error: "authentication_required" }); return true; }
    if (url.pathname.endsWith("/logout")) {
      await store.revokeSession(miniSessionDigest(token, config.tokenPepper)); sendJson(response, 200, { ok: true }); return true;
    }
    if (url.pathname.endsWith("/session")) {
      sendJson(response, 200, { authenticated: true, user: userView(session), session: { expiresAt: session.expiresAt } }); return true;
    }
    const snapshot = await store.getPersonalState(session.userId);
    // Recheck the exact session after the private query, including logout/reset races.
    const current = await store.getActiveSession(miniSessionDigest(token, config.tokenPepper));
    if (!current || current.id !== session.id || current.userId !== session.userId) {
      sendJson(response, 401, { error: "authentication_required" }); return true;
    }
    sendJson(response, 200, snapshot); return true;
  };
}
