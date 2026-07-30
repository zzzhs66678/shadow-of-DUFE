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

function trustedOrigin(request, allowedOrigins) {
  const origin = request.headers.origin;
  return typeof origin === "string" && allowedOrigins.has(origin);
}

async function resolveDevice(request, store, config) {
  const cookies = parseCookies(request.headers.cookie);
  const existingToken = cookies.get(config.deviceCookie);
  const token = isOpaqueToken(existingToken)
    ? existingToken
    : createOpaqueToken();
  const deviceId = await store.getOrCreateAnonymousDevice(
    tokenDigest(token, config.tokenPepper),
  );

  return {
    cookies,
    deviceId,
    setCookie: token === existingToken
      ? null
      : serializeSecureCookie(
          config.deviceCookie,
          token,
          config.deviceMaxAgeSeconds,
        ),
  };
}

export function createAuthServer({ store, config }) {
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
