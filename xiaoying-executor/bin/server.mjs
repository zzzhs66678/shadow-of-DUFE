#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { normalizeBaiguoSnapshot } from "../src/baiguo-normalizer.mjs";
import { BaiguoClient, BaiguoError } from "../src/baiguo-client.mjs";
import { DemoLibraryAdapter } from "../src/demo-library-adapter.mjs";
import { XiaoyingExecutor } from "../src/executor.mjs";
import { XiaoyingLocalStore } from "../src/local-store.mjs";
import { loadOrCreateMasterKey } from "../src/secret-vault.mjs";
import { PairingService } from "../src/pairing-service.mjs";
import { toPublicHttpError, toPublicTaskError } from "../src/public-errors.mjs";
import { SeatWatchRunner } from "../src/seat-watch-runner.mjs";
import { ScheduledReservationRunner } from "../src/scheduled-reservation-runner.mjs";
import { ReservationGuardRunner } from "../src/reservation-guard-runner.mjs";
import { TraceIntClient } from "../src/traceint-client.mjs";
import { TraceIntLibraryAdapter } from "../src/traceint-library-adapter.mjs";
import { loadTraceIntProtocolConfig } from "../src/traceint-protocol-config.mjs";

const host = process.env.XIAOYING_EXECUTOR_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.XIAOYING_EXECUTOR_PORT ?? "43120", 10);
const bearerToken = process.env.XIAOYING_EXECUTOR_TOKEN ?? "";
const isProduction = process.env.NODE_ENV === "production";
const defaultInviteCode =
  process.env.XIAOYING_DEFAULT_INVITE_CODE ?? (isProduction ? "" : "fjbadguy");
const defaultInviteMaxUses = Number.parseInt(
  process.env.XIAOYING_DEFAULT_INVITE_MAX_USES ?? (isProduction ? "" : "20"),
  10,
);
const configuredPublicBaseUrl = process.env.XIAOYING_PUBLIC_BASE_URL ?? "";
const configuredBasePath = process.env.XIAOYING_BASE_PATH ?? "";
const DURABLE_CONFIRM_TASKS = new Set([
  "library.confirm_reservation",
  "library.confirm_cancellation",
]);

function failedTaskResult(task, code) {
  return {
    taskId: typeof task?.taskId === "string" ? task.taskId : "invalid-task",
    type: typeof task?.type === "string" ? task.type : "unknown",
    status: "failed",
    completedAt: new Date().toISOString(),
    error: toPublicTaskError(code),
  };
}

function normalizeBasePath(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === "/") return "";
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
  if (!/^\/[a-z0-9/_-]+$/i.test(normalized)) {
    throw new Error("XIAOYING_BASE_PATH 只能包含字母、数字、斜杠、短横线和下划线");
  }
  return normalized;
}

const serviceBasePath = normalizeBasePath(configuredBasePath);
const cookiePath = serviceBasePath || "/";
const secureCookie = configuredPublicBaseUrl.startsWith("https://");
const sessionCookieName = secureCookie
  ? "__Secure-dufesh_xiaoying_session"
  : "dufesh_xiaoying_session";

if (isProduction && defaultInviteCode.length < 12) {
  console.error("生产环境必须配置至少 12 位的 XIAOYING_DEFAULT_INVITE_CODE");
  process.exit(1);
}
if (
  !Number.isInteger(defaultInviteMaxUses) ||
  defaultInviteMaxUses < 1 ||
  defaultInviteMaxUses > 500
) {
  console.error("必须配置 1-500 之间的 XIAOYING_DEFAULT_INVITE_MAX_USES");
  process.exit(1);
}
if (isProduction && !process.env.XIAOYING_MASTER_KEY) {
  console.error("生产环境必须通过 XIAOYING_MASTER_KEY 提供主密钥");
  process.exit(1);
}
if (isProduction && !configuredPublicBaseUrl.startsWith("https://")) {
  console.error("生产环境必须配置 HTTPS 的 XIAOYING_PUBLIC_BASE_URL");
  process.exit(1);
}

if (!["127.0.0.1", "0.0.0.0"].includes(host)) {
  console.error("XIAOYING_EXECUTOR_HOST 只支持 127.0.0.1 或 0.0.0.0。");
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("XIAOYING_EXECUTOR_PORT 必须是 1024-65535 之间的端口。");
  process.exit(1);
}

const baiguoClient = new BaiguoClient();
const userExecutors = new Map();
const uiPath = fileURLToPath(new URL("../public/index.html", import.meta.url));
const uiHtml = await readFile(uiPath, "utf8");
const pairPath = fileURLToPath(new URL("../public/pair.html", import.meta.url));
const pairHtml = await readFile(pairPath, "utf8");
function htmlForBasePath(html) {
  if (!serviceBasePath) return html;
  return html
    .replaceAll('"/v1', `"${serviceBasePath}/v1`)
    .replaceAll("'/v1", `'${serviceBasePath}/v1`)
    .replaceAll('href="/v1', `href="${serviceBasePath}/v1`);
}
const servedUiHtml = htmlForBasePath(uiHtml);
const servedPairHtml = htmlForBasePath(pairHtml);
function inlineHashes(html, expression) {
  return [...html.matchAll(expression)].map(
    (match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`,
  );
}
const servedDocuments = `${servedUiHtml}\n${servedPairHtml}`;
const scriptHashes = inlineHashes(servedDocuments, /<script[^>]*>([\s\S]*?)<\/script>/g);
const styleHashes = inlineHashes(servedDocuments, /<style[^>]*>([\s\S]*?)<\/style>/g);
const styleAttributeHashes = inlineHashes(servedDocuments, /\sstyle="([^"]*)"/g);
const xiaoyingContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  `script-src 'self' ${scriptHashes.join(" ")}`,
  `style-src 'self' ${styleHashes.join(" ")}`,
  `style-src-attr 'unsafe-hashes' ${styleAttributeHashes.join(" ")}`,
].join("; ");
const localDataDirectory = fileURLToPath(new URL("../.local-data/", import.meta.url));
const databasePath =
  process.env.XIAOYING_DATABASE_PATH ??
  fileURLToPath(new URL("../.local-data/xiaoying.sqlite", import.meta.url));
const masterKeyPath =
  process.env.XIAOYING_MASTER_KEY_PATH ??
  fileURLToPath(new URL("../.local-data/master-key", import.meta.url));
const traceIntProtocolPath =
  process.env.XIAOYING_TRACEINT_PROTOCOL_PATH ??
  fileURLToPath(new URL("../.local-data/traceint-protocol.json", import.meta.url));
const traceIntProtocolState =
  await loadTraceIntProtocolConfig(traceIntProtocolPath);
const traceIntClient = new TraceIntClient({
  protocol: traceIntProtocolState.protocol,
});
const masterKey = await loadOrCreateMasterKey(
  masterKeyPath,
  process.env.XIAOYING_MASTER_KEY ?? "",
);
const store = new XiaoyingLocalStore({
  databasePath,
  masterKey,
  defaultInviteCode,
  defaultInviteMaxUses,
});
const pairingService = new PairingService();

function publicBaseUrlFor(request) {
  if (configuredPublicBaseUrl) return configuredPublicBaseUrl;
  if (host === "0.0.0.0") {
    const address = Object.values(networkInterfaces())
      .flat()
      .find((item) => item && item.family === "IPv4" && !item.internal)?.address;
    if (address) return `http://${address}:${port}`;
  }
  return `http://${request.headers.host ?? `127.0.0.1:${port}`}`;
}

function executorFor(user) {
  const connection = store.getExternalConnection(user.id, "traceint");
  const mode = connection.status === "connected" ? "traceint" : "demo";
  const cacheKey = `${user.id}:${mode}`;
  const cached = userExecutors.get(cacheKey);
  if (cached) return cached;

  const libraryAdapter =
    mode === "traceint"
      ? new TraceIntLibraryAdapter({
          client: traceIntClient,
          credentialProvider: () =>
            store.readExternalCredential(user.id, "traceint"),
          connectionStateProvider: () =>
            store.getExternalConnection(user.id, "traceint"),
          onSessionExpired: () =>
            store.markExternalConnection(user.id, "traceint", {
              status: "needs_reauthorization",
              errorCode: "SESSION_EXPIRED",
            }),
          favoritesProvider: () => store.listFavoriteSeats(user.id),
        })
      : new DemoLibraryAdapter();
  const executor = new XiaoyingExecutor({ libraryAdapter });
  userExecutors.set(cacheKey, executor);
  return executor;
}

function clearUserExecutor(userId) {
  for (const key of userExecutors.keys()) {
    if (key.startsWith(`${userId}:`)) userExecutors.delete(key);
  }
}

function libraryAdapterForUserId(userId) {
  return executorFor({ id: userId }).libraryAdapter;
}

const seatWatchRunner = new SeatWatchRunner({
  store,
  adapterForUser: libraryAdapterForUserId,
});
seatWatchRunner.start();
const scheduledReservationRunner = new ScheduledReservationRunner({
  store,
  adapterForUser: libraryAdapterForUserId,
});
scheduledReservationRunner.start();
const reservationGuardRunner = new ReservationGuardRunner({
  store,
  adapterForUser: libraryAdapterForUserId,
});
reservationGuardRunner.start();

function applySecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    xiaoyingContentSecurityPolicy,
  );
  response.setHeader(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
}

function sendJson(response, status, body) {
  applySecurityHeaders(response);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator < 0) return [part, ""];
        return [
          decodeURIComponent(part.slice(0, separator)),
          decodeURIComponent(part.slice(separator + 1)),
        ];
      }),
  );
}

function sessionToken(request) {
  return parseCookies(request)[sessionCookieName] ?? "";
}

function authenticatedUser(request) {
  return store.authenticate(sessionToken(request));
}

function setSessionCookie(response, token, expiresAt) {
  const secure = secureCookie ? "; Secure" : "";
  response.setHeader(
    "set-cookie",
    `${sessionCookieName}=${encodeURIComponent(token)}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${secure}`,
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    "set-cookie",
    `${sessionCookieName}=; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? "; Secure" : ""}`,
  );
}

function legacyBearerAuthorized(request) {
  return Boolean(
    bearerToken && request.headers.authorization === `Bearer ${bearerToken}`,
  );
}

async function readJson(request, maxBytes = 64 * 1024) {
  const contentType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("请求必须使用 application/json");
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("请求内容过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求 JSON 格式无效");
    error.statusCode = 400;
    throw error;
  }
}

function requestIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded.at(-1) || request.socket.remoteAddress || "unknown";
}

function withinRateLimit(request, bucket, limit, windowMs) {
  return store.consumePublicRateLimit({
    scope: bucket,
    key: requestIp(request),
    limit,
    windowMs,
  });
}

function sameOriginRequest(request) {
  if (!isProduction || ["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")) {
    return true;
  }
  const origin = String(request.headers.origin ?? "");
  if (!origin) return false;
  try {
    const expected = new URL(configuredPublicBaseUrl).origin;
    const left = Buffer.from(origin);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  applySecurityHeaders(response);
  if (!sameOriginRequest(request)) {
    return sendJson(response, 403, { error: "request_origin_rejected" });
  }
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return response.end(servedUiHtml);
  }
  if (request.method === "GET" && requestUrl.pathname === "/pair") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    });
    return response.end(servedPairHtml);
  }
  if (request.method === "GET" && request.url === "/health") {
    return sendJson(response, 200, {
      status: "ok",
      adapter: "demo",
      externalWrites: "preview-confirm-only",
      authentication: "local-vip-session",
      persistence: databasePath === ":memory:" ? "memory" : "sqlite",
      protocolVersion: traceIntProtocolState.activeVersion,
    });
  }

  try {
    if (request.method === "GET" && requestUrl.pathname === "/v1/public/pairing") {
      const session = pairingService.getByToken(requestUrl.searchParams.get("token"));
      if (!session) return sendJson(response, 404, { error: "pairing_not_found" });
      return sendJson(response, 200, {
        status: session.status,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/public/pairing") {
      if (!withinRateLimit(request, "public-pairing", 12, 15 * 60_000)) {
        return sendJson(response, 429, { error: "too_many_requests" });
      }
      const body = await readJson(request);
      const result = await pairingService.submit({
        token: body.token,
        authorization: body.authorization,
        complete: async (session, authorization) => {
          const credential = await traceIntClient.exchangeAuthorization(authorization);
          store.setExternalCredential(session.userId, "traceint", credential);
          clearUserExecutor(session.userId);
          store.createNotification(session.userId, {
            kind: "success",
            title: "图书馆账号已连接",
            body: "现在可以在东财之影里选座和查看预约。",
            actionUrl: `${serviceBasePath || ""}/#campus`,
            deduplicationKey: `traceint-connected:${session.id}`,
          });
        },
      });
      return sendJson(response, 200, result);
    }

    if (request.method === "POST" && requestUrl.pathname === "/v1/auth/invite") {
      if (!withinRateLimit(request, "invite", 5, 15 * 60_000)) {
        return sendJson(response, 429, { error: "too_many_requests" });
      }
      const body = await readJson(request);
      if (
        typeof body.inviteCode !== "string" ||
        body.inviteCode.length > 128 ||
        typeof body.displayName !== "string" ||
        body.displayName.trim().length < 1 ||
        body.displayName.length > 32
      ) {
        return sendJson(response, 400, { error: "请检查称呼和邀请码" });
      }
      const unlocked = store.unlockVip({
        inviteCode: body.inviteCode,
        displayName: body.displayName,
      });
      setSessionCookie(response, unlocked.sessionToken, unlocked.expiresAt);
      return sendJson(response, 201, { user: unlocked.user });
    }

    const user = authenticatedUser(request);
    if (request.method === "POST" && requestUrl.pathname === "/v1/auth/logout") {
      store.revokeSession(sessionToken(request));
      clearSessionCookie(response);
      return sendJson(response, 200, { signedOut: true });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/me") {
      if (!user) return sendJson(response, 401, { error: "vip_required" });
      return sendJson(response, 200, {
        user: store.getUser(user.id),
        modelKey: store.getModelKeySummary(user.id),
        libraryConnection: store.getExternalConnection(user.id, "traceint"),
        baiguoConnection: store.getExternalConnection(user.id, "baiguo"),
        capabilities: {
          remoteAuthorization:
            Boolean(configuredPublicBaseUrl) || host === "0.0.0.0",
          publicBaseUrlConfigured: Boolean(configuredPublicBaseUrl),
          protocolVersion: traceIntProtocolState.activeVersion,
          protocolSource: traceIntProtocolState.source,
        },
      });
    }

    if (request.method === "DELETE" && requestUrl.pathname === "/v1/me") {
      if (!user) return sendJson(response, 401, { error: "vip_required" });
      clearUserExecutor(user.id);
      store.deleteUser(user.id);
      clearSessionCookie(response);
      return sendJson(response, 200, { deleted: true });
    }

    if (!user && !legacyBearerAuthorized(request)) {
      return sendJson(response, 401, { error: "vip_required" });
    }
    if (!user) {
      return sendJson(response, 401, { error: "local_session_required" });
    }

    if (request.method === "PUT" && requestUrl.pathname === "/v1/me/model-key") {
      const body = await readJson(request);
      const summary = store.setModelKey(user.id, body);
      return sendJson(response, 200, { modelKey: summary });
    }
    if (request.method === "DELETE" && requestUrl.pathname === "/v1/me/model-key") {
      store.deleteModelKey(user.id);
      return sendJson(response, 200, { modelKey: { connected: false } });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/me/export") {
      const backup = store.exportUserData(user.id);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="dufesh-xiaoying-${new Date().toISOString().slice(0, 10)}.json"`,
        "cache-control": "no-store",
      });
      return response.end(JSON.stringify(backup, null, 2));
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/me/import") {
      const backup = await readJson(request, 1024 * 1024);
      return sendJson(response, 200, {
        summary: store.importUserData(user.id, backup),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/library/connection") {
      return sendJson(response, 200, {
        connection: store.getExternalConnection(user.id, "traceint"),
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/library/pairing") {
      const pairing = pairingService.create({
        userId: user.id,
        publicBaseUrl: publicBaseUrlFor(request),
      });
      const qrDataUrl = await QRCode.toDataURL(pairing.mobileUrl, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 320,
        color: { dark: "#17221d", light: "#ffffff" },
      });
      return sendJson(response, 201, {
        pairing: {
          id: pairing.id,
          status: pairing.status,
          expiresAt: pairing.expiresAt,
          mobileUrl: pairing.mobileUrl,
          qrDataUrl,
          remoteReady: Boolean(configuredPublicBaseUrl) || host === "0.0.0.0",
        },
      });
    }
    const pairingStatusMatch = requestUrl.pathname.match(
      /^\/v1\/library\/pairing\/([0-9a-f-]+)$/,
    );
    if (request.method === "GET" && pairingStatusMatch) {
      const pairing = pairingService.getForUser(pairingStatusMatch[1], user.id);
      if (!pairing) return sendJson(response, 404, { error: "pairing_not_found" });
      return sendJson(response, 200, {
        pairing,
        connection: store.getExternalConnection(user.id, "traceint"),
      });
    }
    if (request.method === "DELETE" && pairingStatusMatch) {
      pairingService.cancel(pairingStatusMatch[1], user.id);
      return sendJson(response, 200, { cancelled: true });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/library/connect") {
      const body = await readJson(request);
      const credential = await traceIntClient.exchangeAuthorization(body.authorization);
      const connection = store.setExternalCredential(
        user.id,
        "traceint",
        credential,
      );
      clearUserExecutor(user.id);
      return sendJson(response, 200, { connection });
    }
    if (request.method === "DELETE" && requestUrl.pathname === "/v1/library/connection") {
      store.disconnectExternal(user.id, "traceint");
      clearUserExecutor(user.id);
      return sendJson(response, 200, {
        connection: store.getExternalConnection(user.id, "traceint"),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/library/libraries") {
      const adapter = executorFor(user).libraryAdapter;
      if (typeof adapter.listLibraries !== "function") {
        return sendJson(response, 200, { mode: "demo", libraries: [] });
      }
      return sendJson(response, 200, {
        mode: "traceint",
        libraries: await adapter.listLibraries(),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/library/favorites") {
      return sendJson(response, 200, {
        seats: store.listFavoriteSeats(user.id),
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/library/favorites") {
      const body = await readJson(request);
      return sendJson(response, 200, {
        seats: store.saveFavoriteSeat(user.id, body),
      });
    }
    if (request.method === "DELETE" && requestUrl.pathname === "/v1/library/favorites") {
      return sendJson(response, 200, {
        seats: store.deleteFavoriteSeat(
          user.id,
          requestUrl.searchParams.get("favoriteId"),
        ),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/library/watches") {
      return sendJson(response, 200, {
        watches: store.listSeatWatches(user.id),
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/library/watches/discovery") {
      const body = await readJson(request);
      const libraries = Array.isArray(body.libraries) ? body.libraries.slice(0, 12) : [];
      if (!libraries.length) throw new Error("请选择空位发现的场馆");
      for (const library of libraries) {
        store.saveSeatWatch(user.id, {
          libraryId: library.libraryId,
          libraryName: library.name,
          seatKey: "*",
          seatLabel: `${library.name}任意座位`,
        });
      }
      await seatWatchRunner.runDue();
      return sendJson(response, 200, {
        watches: store.listSeatWatches(user.id),
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/library/watches") {
      const body = await readJson(request);
      const watches = store.saveSeatWatch(user.id, body);
      await seatWatchRunner.runDue();
      return sendJson(response, 200, { watches });
    }
    if (request.method === "DELETE" && requestUrl.pathname === "/v1/library/watches") {
      return sendJson(response, 200, {
        watches: store.deleteSeatWatch(
          user.id,
          requestUrl.searchParams.get("watchId"),
        ),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/library/scheduled") {
      return sendJson(response, 200, {
        reservations: store.listScheduledReservations(user.id),
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/library/scheduled") {
      const body = await readJson(request);
      return sendJson(response, 201, {
        reservations: store.saveScheduledReservation(user.id, body),
      });
    }
    if (request.method === "DELETE" && requestUrl.pathname === "/v1/library/scheduled") {
      return sendJson(response, 200, {
        reservations: store.cancelScheduledReservation(
          user.id,
          requestUrl.searchParams.get("actionId"),
        ),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/library/guard") {
      return sendJson(response, 200, {
        guard: store.getReservationGuard(user.id),
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/library/guard") {
      const body = await readJson(request);
      return sendJson(response, 201, {
        guard: store.enableReservationGuard(user.id, body),
      });
    }
    if (request.method === "DELETE" && requestUrl.pathname === "/v1/library/guard") {
      return sendJson(response, 200, {
        guard: store.disableReservationGuard(user.id),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/library/layout") {
      const adapter = executorFor(user).libraryAdapter;
      if (typeof adapter.getLibraryLayout !== "function") {
        return sendJson(response, 400, { error: "请先连接我去图书馆" });
      }
      return sendJson(response, 200, {
        layout: await adapter.getLibraryLayout(requestUrl.searchParams.get("libraryId")),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/baiguo/connection") {
      return sendJson(response, 200, {
        connection: store.getExternalConnection(user.id, "baiguo"),
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/baiguo/connect") {
      const body = await readJson(request);
      const synced = body.authorization
        ? await baiguoClient.connectFromAuthorization(body.authorization)
        : await baiguoClient.sync(body);
      const normalized = normalizeBaiguoSnapshot(synced.snapshot);
      store.setExternalCredential(
        user.id,
        "baiguo",
        JSON.stringify(synced.credentials),
      );
      const summary = store.syncBaiguoSnapshot(user.id, normalized);
      return sendJson(response, 200, {
        connection: store.getExternalConnection(user.id, "baiguo"),
        summary,
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/baiguo/sync") {
      const encrypted = store.readExternalCredential(user.id, "baiguo");
      if (!encrypted) {
        return sendJson(response, 400, { error: "请先连接白果云" });
      }
      try {
        const synced = await baiguoClient.sync(JSON.parse(encrypted));
        const normalized = normalizeBaiguoSnapshot(synced.snapshot);
        store.setExternalCredential(
          user.id,
          "baiguo",
          JSON.stringify(synced.credentials),
        );
        const summary = store.syncBaiguoSnapshot(user.id, normalized);
        return sendJson(response, 200, {
          connection: store.getExternalConnection(user.id, "baiguo"),
          summary,
        });
      } catch (error) {
        if (error instanceof BaiguoError && error.code === "SESSION_EXPIRED") {
          store.markExternalConnection(user.id, "baiguo", {
            status: "needs_reauthorization",
            errorCode: error.code,
          });
        }
        throw error;
      }
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/baiguo/items") {
      return sendJson(response, 200, store.getBaiguoItems(user.id));
    }
    if (request.method === "DELETE" && requestUrl.pathname === "/v1/baiguo/connection") {
      store.disconnectExternal(user.id, "baiguo");
      return sendJson(response, 200, {
        connection: store.getExternalConnection(user.id, "baiguo"),
      });
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/tasks/execute") {
      const task = await readJson(request);
      const durable = DURABLE_CONFIRM_TASKS.has(task?.type);
      const claim = durable ? store.claimTaskExecution(user.id, task) : null;
      if (claim?.state === "replay") {
        return sendJson(
          response,
          claim.result.status === "succeeded" ? 200 : 400,
          claim.result,
        );
      }
      if (claim?.state && claim.state !== "claimed") {
        const code =
          claim.state === "in_progress"
            ? "EXECUTION_IN_PROGRESS"
            : claim.state === "conflict"
              ? "IDEMPOTENCY_CONFLICT"
              : "EXECUTION_REVIEW_REQUIRED";
        return sendJson(response, 409, failedTaskResult(task, code));
      }
      const executor = executorFor(user);
      const result = await executor.execute(task);
      const latestAudit = executor.getAuditLog().at(-1);
      if (durable && latestAudit) {
        const stored = store.finishTaskExecution(
          user.id,
          task.idempotencyKey,
          claim.leaseToken,
          result,
          latestAudit,
        );
        if (!stored) {
          return sendJson(
            response,
            409,
            failedTaskResult(task, "EXECUTION_REVIEW_REQUIRED"),
          );
        }
      } else if (latestAudit) {
        store.appendAudit(user.id, latestAudit);
      }
      return sendJson(response, result.status === "succeeded" ? 200 : 400, result);
    }
    if (request.method === "POST" && requestUrl.pathname === "/v1/baiguo/normalize") {
      const snapshot = await readJson(request);
      return sendJson(response, 200, normalizeBaiguoSnapshot(snapshot));
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/preferences") {
      return sendJson(response, 200, {
        preferences: store.getUserPreferences(user.id),
      });
    }
    if (request.method === "PUT" && requestUrl.pathname === "/v1/preferences") {
      const body = await readJson(request);
      return sendJson(response, 200, {
        preferences: store.saveUserPreferences(user.id, body),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/notifications") {
      return sendJson(response, 200, {
        notifications: store.listNotifications(user.id),
      });
    }
    if (request.method === "PUT" && requestUrl.pathname === "/v1/notifications/read") {
      const body = await readJson(request);
      return sendJson(response, 200, {
        notifications: store.markNotificationRead(user.id, body.notificationId),
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/audit") {
      return sendJson(response, 200, { records: store.listAudit(user.id) });
    }
    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    const publicError = toPublicHttpError(error, { fallbackStatus: 400 });
    return sendJson(response, publicError.status, {
      error: publicError.message,
      code: publicError.code,
    });
  }
});

server.listen(port, host, () => {
  console.log(`小影 X1 本地验证台已启动：http://${host}:${port}`);
  console.log("默认使用演示数据；只有用户主动授权并确认后才会操作真实图书馆账户。");
  console.log(`本地数据目录：${localDataDirectory}`);
});

function close() {
  reservationGuardRunner.stop();
  scheduledReservationRunner.stop();
  seatWatchRunner.stop();
  store.close();
  server.close(() => process.exit(0));
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
