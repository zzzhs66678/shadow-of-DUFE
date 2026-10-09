import { randomUUID } from "node:crypto";
import { parseCookies } from "./cookies.mjs";
import { isOpaqueToken, tokenDigest } from "./tokens.mjs";
import { createSharedTokenBucket } from "./rate-limit.mjs";
import { feedbackPageQuery, isFeedbackUuid, validateDataFeedback, validateFeedbackResolution } from "./data-feedback-contract.mjs";

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.end(JSON.stringify(body));
  return true;
}
async function body(request) {
  if (String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8192) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}
const clientAddress = request => String(request.headers["x-forwarded-for"] ?? "").split(",").map(x => x.trim()).filter(Boolean).at(-1) || request.socket.remoteAddress || "unknown";

// Independent initialization: production always uses the existing persistent limiter store.
export function createDataFeedbackRateLimiters(store) {
  const bucket = (scope, capacity, refillPerSecond) => createSharedTokenBucket({ store, scope, capacity, refillPerSecond });
  return {
    submit: bucket("data-feedback-account", 5, 1 / 300),
    ip: bucket("data-feedback-network", 50, 1 / 30),
    admin: bucket("data-feedback-admin", 30, 1 / 10),
    read: bucket("data-feedback-read", 120, 2),
  };
}

// Register BEFORE createAdminRequestHandler's catch-all in server.mjs.
export function createDataFeedbackRequestHandler({ store, config, adminSecurity, rateLimiters }) {
  return async function handleDataFeedbackRequest(request, response, url) {
    const ownRoot = "/api/auth/data-feedback";
    const adminRoot = "/api/admin/data-feedback";
    const admin = url.pathname === adminRoot || url.pathname.startsWith(`${adminRoot}/`);
    if (!admin && url.pathname !== ownRoot && !url.pathname.startsWith(`${ownRoot}/`)) return false;
    const root = admin ? adminRoot : ownRoot;
    try {
      if (admin && (!config.adminEnabled || !adminSecurity)) return json(response, 404, { error: "not_found" });
      // Reject cross-site reads too; no-Origin same-origin GETs are used by browsers.
      const origin = request.headers.origin;
      if (request.headers["sec-fetch-site"] === "cross-site" ||
          (origin !== undefined && !config.allowedOrigins.has(origin)) ||
          (request.method !== "GET" && !config.allowedOrigins.has(origin))) return json(response, 403, { error: "untrusted_origin" });
      const cookies = parseCookies(request.headers.cookie);
      const token = cookies.get(config.sessionCookie);
      const session = isOpaqueToken(token) ? await store.getDataFeedbackSession(tokenDigest(token, config.tokenPepper)) : null;
      if (!session) return json(response, 401, { error: "authentication_required" });
      const input = { userId: session.userId, sessionId: session.id };
      let access;
      if (admin) {
        if (session.role !== "admin") return json(response, 403, { error: "admin_forbidden" });
        const elevation = cookies.get(config.adminCookie);
        input.elevationTokenHash = isOpaqueToken(elevation) ? tokenDigest(elevation, config.tokenPepper) : null;
        access = await store.getAdminAccessState(input);
        if (!access?.elevated) return json(response, 403, { error: "admin_mfa_required" });
        input.requestId = randomUUID();
        response.setHeader("X-Request-ID", input.requestId);
        input.ipHash = tokenDigest(`admin-ip:${clientAddress(request)}`, config.tokenPepper);
        input.userAgentHash = tokenDigest(`admin-ua:${String(request.headers["user-agent"] ?? "")}`, config.tokenPepper);
      }
      const suffix = url.pathname.slice(root.length);
      const detailId = suffix.startsWith("/") ? suffix.slice(1) : "";
      if (suffix && !(suffix === "/session" && !admin) && !isFeedbackUuid(detailId)) return json(response, 404, { error: "not_found" });
      const allowed = suffix ? "GET" : admin ? "GET" : "GET, POST";
      if (!(request.method === "GET" || (!suffix && !admin && request.method === "POST") || (admin && detailId && request.method === "PATCH"))) {
        response.setHeader("Allow", admin && detailId ? "GET, PATCH" : allowed);
        return json(response, 405, { error: "method_not_allowed" });
      }
      // Lazy construction leaves unrelated routes/test stores untouched. Matched
      // requests still fail closed if a persistent quota store is unavailable.
      rateLimiters ??= createDataFeedbackRateLimiters(store);
      const limiter = request.method === "GET" ? rateLimiters.read : admin ? rateLimiters.admin : rateLimiters.submit;
      const digest = tokenDigest(`data-feedback-user:${session.userId}`, config.tokenPepper);
      if (!(await limiter.consume(digest)) || (request.method === "POST" && !(await rateLimiters.ip.consume(tokenDigest(`data-feedback-ip:${clientAddress(request)}`, config.tokenPepper))))) {
        response.setHeader("Retry-After", request.method === "GET" ? "1" : admin ? "10" : "300");
        return json(response, 429, { error: "data_feedback_rate_limited" });
      }
      if (suffix || request.method === "POST") {
        if ([...url.searchParams].length) return json(response, 400, { error: "invalid_data_feedback_query" });
      }
      if (suffix === "/session") return json(response, 200, { authenticated: true });
      if (request.method === "POST") {
        const data = validateDataFeedback(await body(request));
        if (!data) return json(response, 400, { error: "invalid_data_feedback_body" });
        const result = await store.createDataFeedback({ ...input, data });
        return json(response, result.created ? 201 : 200, result);
      }
      if (request.method === "PATCH") {
        const change = validateFeedbackResolution(await body(request));
        if (!change) return json(response, 400, { error: "invalid_data_feedback_body" });
        const feedback = await store.resolveDataFeedback({ ...input, feedbackId: detailId, change });
        return feedback ? json(response, 200, { feedback, elevatedUntil: access.elevatedUntil }) : json(response, 404, { error: "data_feedback_not_found" });
      }
      if (detailId) {
        const feedback = await store[admin ? "getAdminDataFeedback" : "getOwnDataFeedback"]({ ...input, feedbackId: detailId });
        return feedback ? json(response, 200, { feedback, ...(admin ? { elevatedUntil: access.elevatedUntil } : {}) }) : json(response, 404, { error: "data_feedback_not_found" });
      }
      const page = feedbackPageQuery(url.searchParams, admin);
      if (!page) return json(response, 400, { error: "invalid_data_feedback_query" });
      const result = await store[admin ? "listAdminDataFeedback" : "listOwnDataFeedback"]({ ...input, ...page });
      return json(response, 200, { ...result, ...(admin ? { elevatedUntil: access.elevatedUntil } : {}) });
    } catch (error) {
      const errors = {
        AUTH_SESSION_REQUIRED: [401, "authentication_required"], AUTH_ADMIN_FORBIDDEN: [403, "admin_mfa_required"],
        FEEDBACK_INVALID_BODY: [400, "invalid_data_feedback_body"], FEEDBACK_INVALID_CURSOR: [400, "invalid_data_feedback_query"],
        FEEDBACK_VERSION_CONFLICT: [409, "data_feedback_version_conflict"], FEEDBACK_REQUEST_CONFLICT: [409, "data_feedback_request_conflict"],
      };
      const [status, code] = errors[error?.code] ?? [503, "service_unavailable"];
      return json(response, status, { error: code });
    }
  };
}
