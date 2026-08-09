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
import { createApiRateLimiters } from "./rate-limit.mjs";
import { createAdminRequestHandler } from "./admin-routes.mjs";
import { createCommunityRequestHandler } from "./community-routes.mjs";
import { createTeacherRequestHandler } from "./teacher-routes.mjs";
import {
  normalizeLoginIdentifier,
  validateLogin,
  validateNewPassword,
  validateProfileUpdate,
  validateRegistration,
} from "./credentials.mjs";

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

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
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

function clientAddress(request) {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded.at(-1) || request.socket.remoteAddress || "unknown";
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

async function readRawBody(request, maxBytes) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error("request body is too large");
    error.code = "REQUEST_BODY_TOO_LARGE";
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
  return Buffer.concat(chunks);
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

export function createAuthServer({
  store,
  config,
  wechatProvider,
  passwordService,
  avatarProcessor,
  adminSecurity,
  rateLimiters = createApiRateLimiters(),
}) {
  const dummyPasswordHash = passwordService
    ? passwordService.hash("not-a-real-user-password-9f24")
    : Promise.resolve("");
  const handleAdminRequest = createAdminRequestHandler({
    store,
    config,
    adminSecurity,
    rateLimiters,
  });
  const handleCommunityRequest = createCommunityRequestHandler({
    store,
    config,
    rateLimiters,
  });
  const handleTeacherRequest = createTeacherRequestHandler({ store, config, rateLimiters });

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

      const limiter =
        request.method === "GET" &&
        !url.pathname.startsWith("/api/auth/wechat/") &&
        url.pathname !== "/api/auth/mock/authorize"
          ? rateLimiters.read
          : rateLimiters.write;
      const rateKey = tokenDigest(
        `rate:${clientAddress(request)}`,
        config.tokenPepper,
      );
      if (!(await limiter.consume(rateKey))) {
        response.setHeader("Retry-After", "15");
        sendJson(response, 429, { error: "rate_limit_exceeded" });
        return;
      }

      if (await handleAdminRequest(request, response, url)) return;
      if (await handleCommunityRequest(request, response, url)) return;
      if (await handleTeacherRequest(request, response, url)) return;

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
            {
              authenticated: false,
              deviceId: device.deviceId,
              user: null,
              login: {
                credentialsAvailable: config.credentialsEnabled !== false,
                passwordResetAvailable:
                  config.passwordResetMode !== "disabled",
                emailVerificationAvailable:
                  config.emailVerificationMode === "response",
                wechatAvailable: config.wechatMode === "wechat",
              },
            },
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
            {
              authenticated: false,
              deviceId: device.deviceId,
              user: null,
              login: {
                credentialsAvailable: config.credentialsEnabled !== false,
                passwordResetAvailable:
                  config.passwordResetMode !== "disabled",
                emailVerificationAvailable:
                  config.emailVerificationMode === "response",
                wechatAvailable: config.wechatMode === "wechat",
              },
            },
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
              username: session.username,
              displayName: session.displayName,
              avatarUrl: session.avatarUrl,
              email: session.email,
              emailVerified: session.emailVerified,
              schoolAccount: session.schoolAccount,
              schoolAccountVerified: session.schoolAccountVerified,
              createdAt: session.createdAt,
              lastLoginAt: session.lastLoginAt,
              status: session.status,
              role: session.role ?? "user",
            },
            session: {
              expiresAt: session.expiresAt,
              deviceId: session.deviceId,
            },
            login: {
              credentialsAvailable: config.credentialsEnabled !== false,
              passwordResetAvailable:
                config.passwordResetMode !== "disabled",
              emailVerificationAvailable:
                config.emailVerificationMode === "response",
              wechatAvailable: config.wechatMode === "wechat",
            },
          },
          setCookies,
        );
        return;
      }

      const avatarMatch = url.pathname.match(
        /^\/api\/auth\/avatars\/([0-9a-f-]{36})$/i,
      );
      if (avatarMatch) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          methodNotAllowed(response, "GET, HEAD");
          return;
        }
        if (!isUuid(avatarMatch[1])) {
          sendJson(response, 404, { error: "avatar_not_found" });
          return;
        }
        const avatar = await store.getUserAvatar(avatarMatch[1]);
        if (!avatar) {
          sendJson(response, 404, { error: "avatar_not_found" });
          return;
        }
        const etag = `"${avatar.sha256}"`;
        const hasCurrentVersion =
          url.searchParams.get("v") === avatar.sha256.slice(0, 16);
        const cacheControl = hasCurrentVersion
          ? "public, max-age=300, must-revalidate"
          : "no-cache";
        if (request.headers["if-none-match"] === etag) {
          response.statusCode = 304;
          response.setHeader("ETag", etag);
          response.setHeader("Cache-Control", cacheControl);
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", avatar.contentType);
        response.setHeader("Content-Length", String(avatar.byteSize));
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("ETag", etag);
        response.setHeader("Cache-Control", cacheControl);
        if (request.method === "HEAD") response.end();
        else response.end(avatar.bytes);
        return;
      }

      if (url.pathname === "/api/auth/profile/avatar") {
        if (request.method !== "PUT" && request.method !== "DELETE") {
          methodNotAllowed(response, "PUT, DELETE");
          return;
        }
        if (!avatarProcessor) {
          sendJson(response, 503, { error: "avatar_service_unavailable" });
          return;
        }
        if (!trustedOrigin(request, config.allowedOrigins)) {
          sendJson(response, 403, { error: "untrusted_origin" });
          return;
        }
        const session = await resolveSession(request, store, config);
        if (!session) {
          sendJson(response, 401, { error: "authentication_required" });
          return;
        }
        const uploadRateKey = tokenDigest(
          `avatar:${clientAddress(request)}:${session.userId}`,
          config.tokenPepper,
        );
        if (
          !(await (rateLimiters.upload ?? rateLimiters.write).consume(
            uploadRateKey,
          ))
        ) {
          response.setHeader("Retry-After", "300");
          sendJson(response, 429, { error: "avatar_rate_limit_exceeded" });
          return;
        }
        if (request.method === "DELETE") {
          await store.deleteUserAvatar(session.userId);
          sendJson(response, 200, { ok: true, avatarUrl: null });
          return;
        }

        const contentType = String(request.headers["content-type"] ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (!avatarProcessor.acceptedContentTypes.has(contentType)) {
          sendJson(response, 415, { error: "avatar_type_unsupported" });
          return;
        }
        let rawAvatar;
        try {
          rawAvatar = await readRawBody(
            request,
            avatarProcessor.maxInputBytes,
          );
        } catch (error) {
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            sendJson(response, 413, { error: "avatar_too_large" });
            return;
          }
          throw error;
        }
        let avatar;
        try {
          avatar = await avatarProcessor.process(rawAvatar, contentType);
        } catch (error) {
          const clientErrors = new Map([
            ["AVATAR_TOO_LARGE", [413, "avatar_too_large"]],
            ["AVATAR_TYPE_UNSUPPORTED", [415, "avatar_type_unsupported"]],
            ["AVATAR_EMPTY", [400, "avatar_invalid"]],
            ["AVATAR_INVALID_IMAGE", [400, "avatar_invalid"]],
            ["AVATAR_OUTPUT_TOO_LARGE", [400, "avatar_invalid"]],
          ]);
          const mapped = clientErrors.get(error?.code);
          if (mapped) {
            sendJson(response, mapped[0], { error: mapped[1] });
            return;
          }
          throw error;
        }
        const saved = await store.saveUserAvatar(session.userId, avatar);
        sendJson(
          response,
          saved ? 200 : 404,
          saved ?? { error: "profile_not_found" },
        );
        return;
      }

      if (url.pathname === "/api/auth/profile") {
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
          const profile = await store.getUserProfile(session.userId);
          sendJson(
            response,
            profile ? 200 : 404,
            profile ? { profile } : { error: "profile_not_found" },
          );
          return;
        }

        let body;
        try {
          body = await readJsonBody(request, 16_384);
        } catch (error) {
          if (
            error?.code === "JSON_CONTENT_TYPE_REQUIRED" ||
            error?.code === "JSON_BODY_INVALID"
          ) {
            sendJson(response, 400, { error: "invalid_profile" });
            return;
          }
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            sendJson(response, 413, { error: "request_too_large" });
            return;
          }
          throw error;
        }
        const update = validateProfileUpdate(body);
        if (!update.ok) {
          sendJson(response, 400, {
            error: "invalid_profile",
            fields: update.fields,
          });
          return;
        }
        try {
          const profile = await store.updateUserProfile(
            session.userId,
            update.value,
          );
          sendJson(
            response,
            profile ? 200 : 404,
            profile ? { profile } : { error: "profile_not_found" },
          );
        } catch (error) {
          if (error?.code === "AUTH_USERNAME_TAKEN") {
            sendJson(response, 409, {
              error: "profile_conflict",
              fields: { username: "这个用户名已被使用" },
            });
            return;
          }
          throw error;
        }
        return;
      }

      if (url.pathname === "/api/auth/register") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        if (config.credentialsEnabled === false || !passwordService) {
          sendJson(response, 503, { error: "credential_login_not_ready" });
          return;
        }
        if (!trustedOrigin(request, config.allowedOrigins)) {
          sendJson(response, 403, { error: "untrusted_origin" });
          return;
        }

        let body;
        try {
          body = await readJsonBody(request, 16_384);
        } catch (error) {
          if (
            error?.code === "JSON_CONTENT_TYPE_REQUIRED" ||
            error?.code === "JSON_BODY_INVALID"
          ) {
            sendJson(response, 400, { error: "invalid_registration" });
            return;
          }
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            sendJson(response, 413, { error: "request_too_large" });
            return;
          }
          throw error;
        }

        const registration = validateRegistration(body);
        if (!registration.ok) {
          sendJson(response, 400, {
            error: "invalid_registration",
            fields: registration.fields,
          });
          return;
        }
        const credentialRateKey = tokenDigest(
          `register:${clientAddress(request)}:${registration.value.normalizedUsername}`,
          config.tokenPepper,
        );
        if (
          !(await (rateLimiters.credential ?? rateLimiters.write).consume(
            credentialRateKey,
          ))
        ) {
          response.setHeader("Retry-After", "60");
          sendJson(response, 429, { error: "credential_rate_limit_exceeded" });
          return;
        }

        const device = await resolveDevice(request, store, config);
        const sessionToken = createOpaqueToken();
        const sessionExpiresAt = new Date(
          Date.now() + config.sessionMaxAgeSeconds * 1000,
        );
        const passwordHash = await passwordService.hash(
          registration.value.password,
        );

        let registered;
        try {
          registered = await store.registerCredentialUser({
            ...registration.value,
            passwordHash,
            anonymousDeviceId: device.id,
            sessionTokenHash: tokenDigest(
              sessionToken,
              config.tokenPepper,
            ),
            sessionExpiresAt,
          });
        } catch (error) {
          if (error?.code === "AUTH_USERNAME_TAKEN") {
            sendJson(response, 409, {
              error: "registration_conflict",
              fields: { username: "这个用户名已被使用" },
            });
            return;
          }
          if (error?.code === "AUTH_EMAIL_TAKEN") {
            sendJson(response, 409, {
              error: "registration_conflict",
              fields: { email: "这个邮箱已注册" },
            });
            return;
          }
          throw error;
        }

        const setCookies = [
          serializeSecureCookie(
            config.sessionCookie,
            sessionToken,
            config.sessionMaxAgeSeconds,
          ),
        ];
        if (device.setCookie) setCookies.unshift(device.setCookie);
        sendJson(
          response,
          201,
          {
            authenticated: true,
            user: registered.user,
            session: { expiresAt: registered.expiresAt },
          },
          setCookies,
        );
        return;
      }

      if (url.pathname === "/api/auth/login") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        if (config.credentialsEnabled === false || !passwordService) {
          sendJson(response, 503, { error: "credential_login_not_ready" });
          return;
        }
        if (!trustedOrigin(request, config.allowedOrigins)) {
          sendJson(response, 403, { error: "untrusted_origin" });
          return;
        }

        let body;
        try {
          body = await readJsonBody(request, 16_384);
        } catch (error) {
          if (
            error?.code === "JSON_CONTENT_TYPE_REQUIRED" ||
            error?.code === "JSON_BODY_INVALID"
          ) {
            sendJson(response, 401, { error: "invalid_credentials" });
            return;
          }
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            sendJson(response, 413, { error: "request_too_large" });
            return;
          }
          throw error;
        }

        const login = validateLogin(body);
        const identifier = login?.identifier ?? "invalid";
        const credentialRateKey = tokenDigest(
          `login:${clientAddress(request)}:${identifier}`,
          config.tokenPepper,
        );
        if (
          !(await (rateLimiters.credential ?? rateLimiters.write).consume(
            credentialRateKey,
          ))
        ) {
          response.setHeader("Retry-After", "60");
          sendJson(response, 429, { error: "credential_rate_limit_exceeded" });
          return;
        }

        const principal = login
          ? await store.getCredentialPrincipal(login.identifier)
          : null;
        const passwordMatches = principal
          ? await passwordService.verify(principal.passwordHash, login.password)
          : await passwordService.verify(await dummyPasswordHash, login?.password ?? "");
        const locked = principal?.lockedUntil
          ? new Date(principal.lockedUntil).getTime() > Date.now()
          : false;
        if (
          !principal ||
          !passwordMatches ||
          locked ||
          principal.status !== "active"
        ) {
          if (principal && !locked && principal.status === "active") {
            await store.recordCredentialFailure(principal.id);
          }
          sendJson(response, 401, { error: "invalid_credentials" });
          return;
        }

        const device = await resolveDevice(request, store, config);
        const sessionToken = createOpaqueToken();
        const sessionExpiresAt = new Date(
          Date.now() + config.sessionMaxAgeSeconds * 1000,
        );
        try {
          await store.createCredentialSession({
            userId: principal.id,
            anonymousDeviceId: device.id,
            sessionTokenHash: tokenDigest(
              sessionToken,
              config.tokenPepper,
            ),
            sessionExpiresAt,
          });
        } catch (error) {
          if (error?.code === "AUTH_CREDENTIAL_LOGIN_REJECTED") {
            sendJson(response, 401, { error: "invalid_credentials" });
            return;
          }
          throw error;
        }

        const setCookies = [
          serializeSecureCookie(
            config.sessionCookie,
            sessionToken,
            config.sessionMaxAgeSeconds,
          ),
        ];
        if (device.setCookie) setCookies.unshift(device.setCookie);
        sendJson(
          response,
          200,
          {
            authenticated: true,
            user: {
              id: principal.id,
              username: principal.username,
              displayName: principal.displayName,
            },
            session: { expiresAt: sessionExpiresAt.toISOString() },
          },
          setCookies,
        );
        return;
      }

      if (url.pathname === "/api/auth/email/verification/request") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        if (!trustedOrigin(request, config.allowedOrigins)) {
          sendJson(response, 403, { error: "untrusted_origin" });
          return;
        }
        if ((config.emailVerificationMode ?? "disabled") === "disabled") {
          sendJson(response, 503, {
            error: "email_verification_delivery_unavailable",
          });
          return;
        }
        const session = await resolveSession(request, store, config);
        if (!session) {
          sendJson(response, 401, { error: "authentication_required" });
          return;
        }
        if (session.emailVerified) {
          sendJson(response, 200, { ok: true, alreadyVerified: true });
          return;
        }
        if (!session.email) {
          sendJson(response, 409, { error: "email_verification_unavailable" });
          return;
        }
        const verificationRateKey = tokenDigest(
          `email-verification:${clientAddress(request)}:${session.userId}`,
          config.tokenPepper,
        );
        if (
          !(await (
            rateLimiters.emailVerification ?? rateLimiters.write
          ).consume(verificationRateKey))
        ) {
          response.setHeader("Retry-After", "120");
          sendJson(response, 429, {
            error: "email_verification_rate_limit_exceeded",
          });
          return;
        }
        const verificationToken = createOpaqueToken();
        const created = await store.createEmailVerification({
          userId: session.userId,
          tokenHash: tokenDigest(verificationToken, config.tokenPepper),
          expiresAt: new Date(
            Date.now() +
              (config.emailVerificationTtlSeconds ?? 86_400) * 1_000,
          ),
        });
        if (!created) {
          sendJson(response, 409, { error: "email_verification_unavailable" });
          return;
        }
        sendJson(response, 202, {
          ok: true,
          ...(config.emailVerificationMode === "response"
            ? { debugToken: verificationToken }
            : {}),
        });
        return;
      }

      if (url.pathname === "/api/auth/email/verification/confirm") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        if (!trustedOrigin(request, config.allowedOrigins)) {
          sendJson(response, 403, { error: "untrusted_origin" });
          return;
        }
        const session = await resolveSession(request, store, config);
        if (!session) {
          sendJson(response, 401, { error: "authentication_required" });
          return;
        }
        let body;
        try {
          body = await readJsonBody(request, 8_192);
        } catch (error) {
          if (
            error?.code === "JSON_CONTENT_TYPE_REQUIRED" ||
            error?.code === "JSON_BODY_INVALID"
          ) {
            sendJson(response, 400, { error: "invalid_email_verification" });
            return;
          }
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            sendJson(response, 413, { error: "request_too_large" });
            return;
          }
          throw error;
        }
        if (!isOpaqueToken(body?.token)) {
          sendJson(response, 400, { error: "invalid_email_verification" });
          return;
        }
        const consumed = await store.consumeEmailVerification({
          userId: session.userId,
          tokenHash: tokenDigest(body.token, config.tokenPepper),
        });
        sendJson(
          response,
          consumed ? 200 : 400,
          consumed ? { ok: true } : { error: "invalid_email_verification" },
        );
        return;
      }

      if (url.pathname === "/api/auth/password/reset/request") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        if (config.credentialsEnabled === false || !passwordService) {
          sendJson(response, 503, { error: "credential_login_not_ready" });
          return;
        }
        if (!trustedOrigin(request, config.allowedOrigins)) {
          sendJson(response, 403, { error: "untrusted_origin" });
          return;
        }
        if (config.passwordResetMode === "disabled") {
          sendJson(response, 503, {
            error: "password_reset_delivery_unavailable",
          });
          return;
        }

        let body;
        try {
          body = await readJsonBody(request, 8_192);
        } catch (error) {
          if (
            error?.code === "JSON_CONTENT_TYPE_REQUIRED" ||
            error?.code === "JSON_BODY_INVALID"
          ) {
            sendJson(response, 202, { ok: true });
            return;
          }
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            sendJson(response, 413, { error: "request_too_large" });
            return;
          }
          throw error;
        }
        const identifier = normalizeLoginIdentifier(body?.identifier);
        const resetRateKey = tokenDigest(
          `reset:${clientAddress(request)}:${identifier || "invalid"}`,
          config.tokenPepper,
        );
        if (
          !(await (rateLimiters.passwordReset ?? rateLimiters.write).consume(
            resetRateKey,
          ))
        ) {
          response.setHeader("Retry-After", "60");
          sendJson(response, 429, { error: "password_reset_rate_limit_exceeded" });
          return;
        }

        const principal = identifier
          ? await store.getCredentialPrincipal(identifier)
          : null;
        let debugToken;
        if (principal?.status === "active") {
          const resetToken = createOpaqueToken();
          await store.createPasswordReset({
            userId: principal.id,
            tokenHash: tokenDigest(resetToken, config.tokenPepper),
            expiresAt: new Date(
              Date.now() + config.passwordResetTtlSeconds * 1000,
            ),
          });
          if (config.passwordResetMode === "response") {
            debugToken = resetToken;
          }
        }
        sendJson(response, 202, {
          ok: true,
          ...(debugToken ? { debugToken } : {}),
        });
        return;
      }

      if (url.pathname === "/api/auth/password/reset/confirm") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        if (config.credentialsEnabled === false || !passwordService) {
          sendJson(response, 503, { error: "credential_login_not_ready" });
          return;
        }
        if (!trustedOrigin(request, config.allowedOrigins)) {
          sendJson(response, 403, { error: "untrusted_origin" });
          return;
        }

        let body;
        try {
          body = await readJsonBody(request, 16_384);
        } catch (error) {
          if (
            error?.code === "JSON_CONTENT_TYPE_REQUIRED" ||
            error?.code === "JSON_BODY_INVALID"
          ) {
            sendJson(response, 400, { error: "invalid_password_reset" });
            return;
          }
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            sendJson(response, 413, { error: "request_too_large" });
            return;
          }
          throw error;
        }
        if (!isOpaqueToken(body?.token)) {
          sendJson(response, 400, { error: "invalid_password_reset" });
          return;
        }
        const resetTokenHash = tokenDigest(body.token, config.tokenPepper);
        const resetPrincipal = await store.getPasswordResetPrincipal(
          resetTokenHash,
        );
        if (
          !resetPrincipal ||
          !validateNewPassword(body?.password, [
            resetPrincipal.username,
            resetPrincipal.email,
          ])
        ) {
          sendJson(response, 400, { error: "invalid_password_reset" });
          return;
        }
        const passwordHash = await passwordService.hash(body.password);
        const consumed = await store.consumePasswordReset({
          tokenHash: resetTokenHash,
          passwordHash,
        });
        sendJson(
          response,
          consumed ? 200 : 400,
          consumed ? { ok: true } : { error: "invalid_password_reset" },
          [
            clearSecureCookie(config.sessionCookie),
            clearSecureCookie(config.adminCookie, { sameSite: "Strict" }),
          ],
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

      if (url.pathname === "/api/auth/devices") {
        if (request.method !== "GET" && request.method !== "DELETE") {
          methodNotAllowed(response, "GET, DELETE");
          return;
        }
        if (
          request.method === "DELETE" &&
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
          const devices = await store.listUserDevices(
            session.userId,
            session.id,
          );
          sendJson(response, 200, { devices });
          return;
        }

        let body;
        try {
          body = await readJsonBody(request, 16_384);
        } catch (error) {
          if (
            error?.code === "JSON_CONTENT_TYPE_REQUIRED" ||
            error?.code === "JSON_BODY_INVALID"
          ) {
            sendJson(response, 400, { error: "invalid_device_request" });
            return;
          }
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            sendJson(response, 413, { error: "request_too_large" });
            return;
          }
          throw error;
        }
        if (!isUuid(body?.deviceId)) {
          sendJson(response, 400, { error: "invalid_device_request" });
          return;
        }
        const revoked = await store.revokeUserDevice(
          session.userId,
          session.id,
          body.deviceId,
        );
        if (!revoked) {
          sendJson(response, 404, { error: "device_not_found" });
          return;
        }
        sendJson(
          response,
          200,
          { ok: true, currentSessionRevoked: revoked.current },
          revoked.current
            ? [
                clearSecureCookie(config.sessionCookie),
                clearSecureCookie(config.adminCookie, { sameSite: "Strict" }),
              ]
            : [],
        );
        return;
      }

      if (url.pathname === "/api/auth/account/delete") {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
          return;
        }
        if (!trustedOrigin(request, config.allowedOrigins)) {
          sendJson(response, 403, { error: "untrusted_origin" });
          return;
        }
        const session = await resolveSession(request, store, config);
        if (!session) {
          sendJson(response, 401, { error: "authentication_required" });
          return;
        }

        let body;
        try {
          body = await readJsonBody(request, 16_384);
        } catch (error) {
          if (
            error?.code === "JSON_CONTENT_TYPE_REQUIRED" ||
            error?.code === "JSON_BODY_INVALID"
          ) {
            sendJson(response, 400, { error: "invalid_delete_request" });
            return;
          }
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            sendJson(response, 413, { error: "request_too_large" });
            return;
          }
          throw error;
        }
        if (body?.confirmation !== "DELETE_MY_ACCOUNT") {
          sendJson(response, 400, { error: "delete_confirmation_required" });
          return;
        }

        const deleted = await store.deleteAccount(session.userId);
        sendJson(
          response,
          deleted ? 200 : 404,
          deleted ? { ok: true, deleted: true } : { error: "account_not_found" },
          [
            clearSecureCookie(config.sessionCookie),
            clearSecureCookie(config.adminCookie, { sameSite: "Strict" }),
          ],
        );
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

        const setCookies = [
          clearSecureCookie(config.sessionCookie),
          clearSecureCookie(config.adminCookie, { sameSite: "Strict" }),
        ];
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
