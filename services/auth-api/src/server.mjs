import { createServer } from "node:http";
import {
  clearSecureCookie,
  parseCookies,
  serializeSecureCookie,
} from "./cookies.mjs";
import {
  createOpaqueToken,
  isOpaqueToken,
  tokenDigest,
} from "./tokens.mjs";
import { validateSyncWrite } from "./sync-contract.mjs";

function sendJson(response, statusCode, body, setCookies = []) {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (setCookies.length > 0) response.setHeader("Set-Cookie", setCookies);
  response.end(payload);
}

function methodNotAllowed(response, allow) {
  response.setHeader("Allow", allow);
  sendJson(response, 405, { error: "method_not_allowed" });
}

function sendRedirect(response, location, setCookies = [], statusCode = 302) {
  response.statusCode = statusCode;
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (setCookies.length > 0) response.setHeader("Set-Cookie", setCookies);
  response.end();
}

function trustedOrigin(request, allowedOrigins) {
  const origin = request.headers.origin;
  return typeof origin === "string" && allowedOrigins.has(origin);
}

function safeReturnTo(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.length > 512
  ) {
    return "/";
  }
  return value;
}

function forwardedOrigin(request) {
  const protocol = String(
    request.headers["x-forwarded-proto"] || "http",
  ).split(",", 1)[0].trim();
  const host = String(
    request.headers["x-forwarded-host"] || request.headers.host || "",
  ).split(",", 1)[0].trim();
  return host ? `${protocol}://${host}` : "";
}

async function readJsonBody(request, maxBytes = 524_288) {
  const contentType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("JSON content type is required");
    error.code = "JSON_CONTENT_TYPE_REQUIRED";
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("request body is too large");
      error.code = "REQUEST_BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("request body is not valid JSON");
    error.code = "JSON_BODY_INVALID";
    throw error;
  }
}

async function resolveSession(request, store, config) {
  const cookies = parseCookies(request.headers.cookie);
  const sessionToken = cookies.get(config.sessionCookie);
  if (!isOpaqueToken(sessionToken)) return null;
  return store.getActiveSession(
    tokenDigest(sessionToken, config.tokenPepper),
  );
}

async function resolveDevice(request, store, config) {
  const cookies = parseCookies(request.headers.cookie);
  const existingToken = cookies.get(config.deviceCookie);
  const token = isOpaqueToken(existingToken)
    ? existingToken
    : createOpaqueToken();
  const device = await store.getOrCreateAnonymousDevice(
    tokenDigest(token, config.tokenPepper),
  );

  return {
    cookies,
    id: device.id,
    deviceId: device.publicId,
    setCookie: token === existingToken
      ? null
      : serializeSecureCookie(
          config.deviceCookie,
          token,
          config.deviceMaxAgeSeconds,
        ),
  };
}

export function createAuthServer({ store, config, wechatProvider }) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://auth-api.local");

      if (url.pathname === "/api/auth/health") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          methodNotAllowed(response, "GET, HEAD");
          return;
        }
        await store.health();
        if (request.method === "HEAD") {
          response.statusCode = 204;
          response.end();
        } else {
          sendJson(response, 200, { ok: true });
        }
        return;
      }

      if (url.pathname === "/api/auth/session") {
        if (request.method !== "GET") {
          methodNotAllowed(response, "GET");
          return;
        }

        const device = await resolveDevice(request, store, config);
        const setCookies = device.setCookie ? [device.setCookie] : [];
        const sessionToken = device.cookies.get(config.sessionCookie);

        if (!isOpaqueToken(sessionToken)) {
          if (sessionToken) {
            setCookies.push(clearSecureCookie(config.sessionCookie));
          }
          sendJson(
            response,
            200,
            { authenticated: false, deviceId: device.deviceId, user: null },
            setCookies,
          );
          return;
        }

        const session = await store.getActiveSession(
          tokenDigest(sessionToken, config.tokenPepper),
        );

        if (!session) {
          setCookies.push(clearSecureCookie(config.sessionCookie));
          sendJson(
            response,
            200,
            { authenticated: false, deviceId: device.deviceId, user: null },
            setCookies,
          );
          return;
        }

        sendJson(
          response,
          200,
          {
            authenticated: true,
            deviceId: device.deviceId,
            user: {
              id: session.userId,
              displayName: session.displayName,
              avatarUrl: session.avatarUrl,
            },
            session: { expiresAt: session.expiresAt },
          },
          setCookies,
        );
        return;
      }

      if (url.pathname === "/api/auth/sync") {
        if (request.method !== "GET" && request.method !== "PUT") {
          methodNotAllowed(response, "GET, PUT");
          return;
        }

        if (
          request.method === "PUT" &&
          !trustedOrigin(request, config.allowedOrigins)
        ) {
          sendJson(response, 403, { error: "untrusted_origin" });
          return;
        }

        const session = await resolveSession(request, store, config);
        if (!session) {
          sendJson(response, 401, { error: "authentication_required" });
          return;
        }

        if (request.method === "GET") {
          const snapshot = await store.getPersonalState(session.userId);
          sendJson(response, 200, snapshot);
          return;
        }

        let payload;
        try {
          payload = validateSyncWrite(await readJsonBody(request));
        } catch (error) {
          if (
            error?.code === "SYNC_PAYLOAD_INVALID" ||
            error?.code === "JSON_CONTENT_TYPE_REQUIRED" ||
            error?.code === "JSON_BODY_INVALID"
          ) {
            sendJson(response, 400, { error: "invalid_sync_payload" });
            return;
          }
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            sendJson(response, 413, { error: "sync_payload_too_large" });
            return;
          }
          throw error;
        }

        let result;
        try {
          result = await store.replacePersonalState(
            session.userId,
            payload,
          );
        } catch (error) {
          if (error?.code === "SYNC_MUTATION_REUSED") {
            sendJson(response, 409, { error: "sync_mutation_reused" });
            return;
          }
          throw error;
        }

        sendJson(response, result.conflict ? 409 : 200, result);
        return;
      }

      if (url.pathname === "/api/auth/wechat/start") {
        if (request.method !== "GET") {
          methodNotAllowed(response, "GET");
          return;
        }

        if (wechatProvider.mode === "disabled") {
          sendJson(response, 503, { error: "wechat_login_not_ready" });
          return;
        }

        if (
          wechatProvider.mode === "mock" &&
          !wechatProvider.acceptsSecret(
            request.headers["x-dufesh-mock-secret"],
          )
        ) {
          sendJson(response, 403, { error: "mock_login_forbidden" });
          return;
        }

        if (forwardedOrigin(request) !== config.publicOrigin) {
          const canonical = new URL(url.pathname + url.search, config.publicOrigin);
          sendRedirect(response, canonical.toString(), [], 307);
          return;
        }

        const device = await resolveDevice(request, store, config);
        const state = createOpaqueToken();
        const oauthBrowserToken = createOpaqueToken();
        const returnTo = safeReturnTo(url.searchParams.get("returnTo") || "/");
        const expiresAt = new Date(
          Date.now() + config.oauthTtlSeconds * 1000,
        );

        await store.createOAuthTransaction({
          provider: wechatProvider.id,
          stateHash: tokenDigest(state, config.tokenPepper),
          browserTokenHash: tokenDigest(
            oauthBrowserToken,
            config.tokenPepper,
          ),
          anonymousDeviceId: device.id,
          returnTo,
          expiresAt,
        });

        const setCookies = [
          serializeSecureCookie(
            config.oauthCookie,
            oauthBrowserToken,
            config.oauthTtlSeconds,
          ),
        ];
        if (device.setCookie) setCookies.unshift(device.setCookie);

        sendRedirect(
          response,
          wechatProvider.createAuthorizationUrl({ state }),
          setCookies,
        );
        return;
      }

      if (url.pathname === "/api/auth/mock/authorize") {
        if (request.method !== "GET") {
          methodNotAllowed(response, "GET");
          return;
        }
        if (wechatProvider.mode !== "mock") {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        if (
          !wechatProvider.acceptsSecret(
            request.headers["x-dufesh-mock-secret"],
          )
        ) {
          sendJson(response, 403, { error: "mock_login_forbidden" });
          return;
        }

        const state = url.searchParams.get("state");
        if (!isOpaqueToken(state)) {
          sendJson(response, 400, { error: "invalid_oauth_state" });
          return;
        }

        const subject = String(
          request.headers["x-dufesh-mock-subject"] ||
          "stage3-smoke-user",
        );
        sendRedirect(
          response,
          wechatProvider.createMockCallbackUrl({ state, subject }),
        );
        return;
      }

      if (url.pathname === "/api/auth/wechat/callback") {
        if (request.method !== "GET") {
          methodNotAllowed(response, "GET");
          return;
        }
        if (wechatProvider.mode === "disabled") {
          sendJson(response, 503, { error: "wechat_login_not_ready" });
          return;
        }

        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const cookies = parseCookies(request.headers.cookie);
        const oauthBrowserToken = cookies.get(config.oauthCookie);
        const clearOAuth = clearSecureCookie(config.oauthCookie);

        if (
          !isOpaqueToken(state) ||
          !code ||
          !isOpaqueToken(oauthBrowserToken)
        ) {
          sendJson(
            response,
            400,
            { error: "invalid_oauth_callback" },
            [clearOAuth],
          );
          return;
        }

        let identity;
        try {
          identity = await wechatProvider.exchangeCode({ code });
        } catch {
          sendJson(
            response,
            400,
            { error: "invalid_oauth_code" },
            [clearOAuth],
          );
          return;
        }

        const sessionToken = createOpaqueToken();
        const sessionExpiresAt = new Date(
          Date.now() + config.sessionMaxAgeSeconds * 1000,
        );

        let login;
        try {
          login = await store.consumeOAuthAndCreateSession({
            provider: wechatProvider.id,
            stateHash: tokenDigest(state, config.tokenPepper),
            browserTokenHash: tokenDigest(
              oauthBrowserToken,
              config.tokenPepper,
            ),
            identity,
            sessionTokenHash: tokenDigest(
              sessionToken,
              config.tokenPepper,
            ),
            sessionExpiresAt,
          });
        } catch (error) {
          if (
            error?.code === "AUTH_OAUTH_TRANSACTION_INVALID" ||
            error?.code === "AUTH_ANONYMOUS_DEVICE_INVALID"
          ) {
            sendJson(
              response,
              400,
              { error: "oauth_transaction_invalid" },
              [clearOAuth],
            );
            return;
          }
          throw error;
        }

        sendRedirect(
          response,
          new URL(login.returnTo, config.publicOrigin).toString(),
          [
            serializeSecureCookie(
              config.sessionCookie,
              sessionToken,
              config.sessionMaxAgeSeconds,
            ),
            clearOAuth,
          ],
        );
        return;
      }

      if (url.pathname === "/api/auth/logout") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }

        if (!trustedOrigin(request, config.allowedOrigins)) {
          sendJson(response, 403, { error: "untrusted_origin" });
          return;
        }

        const device = await resolveDevice(request, store, config);
        const sessionToken = device.cookies.get(config.sessionCookie);
        if (isOpaqueToken(sessionToken)) {
          await store.revokeSession(
            tokenDigest(sessionToken, config.tokenPepper),
          );
        }

        const setCookies = [clearSecureCookie(config.sessionCookie)];
        if (device.setCookie) setCookies.unshift(device.setCookie);
        sendJson(
          response,
          200,
          { ok: true, authenticated: false, deviceId: device.deviceId },
          setCookies,
        );
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      console.error("Auth API request failed", error);
      if (!response.headersSent) {
        sendJson(response, 503, { error: "service_unavailable" });
      } else {
        response.destroy();
      }
    }
  });
}
