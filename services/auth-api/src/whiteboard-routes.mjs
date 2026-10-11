import { randomUUID } from "node:crypto";
import { parseCookies } from "./cookies.mjs";
import { isOpaqueToken, tokenDigest } from "./tokens.mjs";
import { createSharedTokenBucket } from "./rate-limit.mjs";
import { isWhiteboardUuid, whiteboardPageQuery } from "./whiteboard-contract.mjs";

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  // Expiry and withdrawal must take effect on the next read, including anonymous
  // reads. Do not reuse a stale public cache or cache any privileged response.
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
  return true;
}
async function readBody(request) {
  if (String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") return null;
  if (Number(request.headers["content-length"]) > 49152) { request.resume(); return null; }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 49152) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}
const address = request => String(request.headers["x-forwarded-for"] ?? "").split(",").map(x => x.trim()).filter(Boolean).at(-1) || request.socket.remoteAddress || "unknown";

export function createWhiteboardRateLimiters(store) {
  const bucket = (scope, capacity, refillPerSecond) => createSharedTokenBucket({ store, scope, capacity, refillPerSecond });
  return {
    publicRead: bucket("whiteboard-public-read", 120, 2),
    adminRead: bucket("whiteboard-admin-read", 120, 2),
    write: bucket("whiteboard-admin-write", 30, 1 / 10),
  };
}

// Must be registered before BOTH generic community and admin handlers.
export function createWhiteboardRequestHandler({ store, config, adminSecurity, rateLimiters }) {
  return async (request, response, url) => {
    const publicRoot = "/api/community/whiteboard", adminRoot = "/api/admin/whiteboard";
    const admin = url.pathname === adminRoot || url.pathname.startsWith(`${adminRoot}/`);
    if (!admin && url.pathname !== publicRoot && !url.pathname.startsWith(`${publicRoot}/`)) return false;
    try {
      if (admin && (!config.adminEnabled || !adminSecurity)) return json(response, 404, { error: "not_found" });
      const suffix = url.pathname.slice((admin ? adminRoot : publicRoot).length);
      const entryId = suffix.startsWith("/") ? suffix.slice(1) : null;
      if (suffix && (!admin || !isWhiteboardUuid(entryId))) return json(response, 404, { error: "not_found" });
      if (!admin) {
        if (request.method !== "GET") { response.setHeader("Allow", "GET"); return json(response, 405, { error: "method_not_allowed" }); }
        const page = whiteboardPageQuery(url.searchParams);
        if (!page) return json(response, 400, { error: "invalid_whiteboard" });
        rateLimiters ??= createWhiteboardRateLimiters(store);
        if (!(await rateLimiters.publicRead.consume(tokenDigest(`whiteboard-ip:${address(request)}`, config.tokenPepper)))) {
          response.setHeader("Retry-After", "1"); return json(response, 429, { error: "whiteboard_rate_limited" });
        }
        // No session reader, cookies, user profile or MFA call on the public path.
        return json(response, 200, await store.listPublicWhiteboard(page));
      }
      response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      const write = request.method !== "GET";
      const origin = request.headers.origin;
      if (request.headers["sec-fetch-site"] === "cross-site" ||
          (origin !== undefined && !config.allowedOrigins.has(origin)) || (write && !config.allowedOrigins.has(origin))) {
        return json(response, 403, { error: "untrusted_origin" });
      }
      const cookies = parseCookies(request.headers.cookie);
      const token = cookies.get(config.sessionCookie);
      const session = isOpaqueToken(token) ? await store.getWhiteboardSession(tokenDigest(token, config.tokenPepper)) : null;
      if (!session) return json(response, 401, { error: "authentication_required" });
      if (session.role !== "admin") return json(response, 403, { error: "admin_forbidden" });
      const elevation = cookies.get(config.adminCookie);
      const input = { userId: session.userId, sessionId: session.id,
        elevationTokenHash: isOpaqueToken(elevation) ? tokenDigest(elevation, config.tokenPepper) : null,
        requestId: randomUUID(), ipHash: tokenDigest(`whiteboard-admin-ip:${address(request)}`, config.tokenPepper),
        userAgentHash: tokenDigest(`whiteboard-admin-ua:${String(request.headers["user-agent"] ?? "")}`, config.tokenPepper) };
      const access = await store.getAdminAccessState(input);
      if (!access?.elevated) return json(response, 403, { error: "admin_mfa_required" });
      response.setHeader("X-Request-ID", input.requestId);
      if (write && request.headers["x-whiteboard-owner"] !== String(session.userId)) return json(response, 409, { error: "whiteboard_account_changed" });
      const methods = entryId ? ["PATCH"] : ["GET", "POST"];
      if (!methods.includes(request.method)) { response.setHeader("Allow", methods.join(", ")); return json(response, 405, { error: "method_not_allowed" }); }
      const page = !write ? whiteboardPageQuery(url.searchParams, true) : null;
      if ((write && url.searchParams.size) || (!write && !page)) return json(response, 400, { error: "invalid_whiteboard" });
      rateLimiters ??= createWhiteboardRateLimiters(store);
      if (!(await rateLimiters[write ? "write" : "adminRead"].consume(tokenDigest(`whiteboard-admin:${session.userId}`, config.tokenPepper)))) {
        response.setHeader("Retry-After", write ? "10" : "1"); return json(response, 429, { error: "whiteboard_rate_limited" });
      }
      if (!write) return json(response, 200, { ...await store.listAdminWhiteboard({ ...input, page }), elevatedUntil: access.elevatedUntil, viewerId: String(session.userId) });
      const result = await store.mutateWhiteboard({ ...input, entryId, data: await readBody(request) });
      return json(response, request.method === "POST" && !result.replayed ? 201 : 200, { entry: result.entry, elevatedUntil: access.elevatedUntil });
    } catch (error) {
      const errors = {
        WHITEBOARD_INVALID: [400, "invalid_whiteboard"], WHITEBOARD_NOT_FOUND: [404, "whiteboard_not_found"],
        WHITEBOARD_CONFLICT: [409, "whiteboard_conflict"], WHITEBOARD_MUTATION_CONFLICT: [409, "whiteboard_mutation_conflict"],
        AUTH_ADMIN_FORBIDDEN: [403, "admin_mfa_required"],
      };
      const [status, code] = errors[error?.code] ?? [503, "service_unavailable"];
      return json(response, status, { error: code });
    }
  };
}
