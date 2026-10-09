import { parseCookies } from "./cookies.mjs";
import { isOpaqueToken, tokenDigest } from "./tokens.mjs";
import { createSharedTokenBucket } from "./rate-limit.mjs";
import { isMaterialBookmarkId, MAX_MATERIAL_BOOKMARKS } from "./material-bookmarks-store.mjs";

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, private",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    Vary: "Cookie",
  });
  response.end(JSON.stringify(body));
}

export function createMaterialBookmarkRateLimiters({ store }) {
  const bucket = (scope, capacity, refillPerSecond) => createSharedTokenBucket({ store, scope, capacity, refillPerSecond });
  return {
    readAccount: bucket("material-bookmarks-read-account", 120, 2),
    readNetwork: bucket("material-bookmarks-read-network", 1200, 20),
    writeAccount: bucket("material-bookmarks-write-account", 60, 1),
    writeNetwork: bucket("material-bookmarks-write-network", 600, 10),
  };
}

async function emptyJson(request) {
  if (String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") return false;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256) return false;
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
  } catch { return false; }
}

// Integration: compose createMaterialBookmarkStore(pool) into store, construct this
// handler once, then await it after the server's global limiter and before its 404.
// No catalog snapshot is copied here; IDs are inert references, never file grants.
export function createMaterialBookmarkRequestHandler({ store, config, rateLimiters }) {
  // Lazy creation keeps unrelated routes/test stores independent of this extension.
  // The first authenticated bookmark request still requires persistent limiters.
  let limits = rateLimiters;
  return async function handleMaterialBookmarkRequest(request, response, url) {
    const base = "/api/material-bookmarks";
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
    const materialId = url.pathname === base ? null : url.pathname.slice(base.length + 1);
    if (materialId !== null && !isMaterialBookmarkId(materialId)) {
      send(response, 404, { error: "material_bookmark_not_found" });
      return true;
    }
    const allowed = materialId === null ? ["GET"] : ["PUT", "DELETE"];
    if (!allowed.includes(request.method)) {
      response.setHeader("Allow", allowed.join(", "));
      send(response, 405, { error: "method_not_allowed" });
      return true;
    }
    const write = request.method !== "GET";
    if (url.searchParams.size) {
      send(response, 400, { error: "invalid_material_bookmark_query" });
      return true;
    }
    if (write && (typeof request.headers.origin !== "string" || !config.allowedOrigins.has(request.headers.origin))) {
      send(response, 403, { error: "untrusted_origin" });
      return true;
    }
    try {
      const token = parseCookies(request.headers.cookie).get(config.sessionCookie);
      const session = isOpaqueToken(token) ? await store.getActiveSession(tokenDigest(token, config.tokenPepper)) : null;
      if (!session) {
        send(response, 401, { error: "authentication_required" });
        return true;
      }
      // Guard a tab left open across an account switch. This header is a comparison,
      // never an authority for selecting the user whose records are read or written.
      if (write && request.headers["x-material-bookmark-owner"] !== String(session.userId)) {
        send(response, 409, { error: "material_bookmark_account_changed" });
        return true;
      }
      limits ??= createMaterialBookmarkRateLimiters({ store });
      const address = String(request.headers["x-forwarded-for"] ?? "").split(",").map((item) => item.trim()).filter(Boolean).at(-1) || request.socket.remoteAddress || "unknown";
      const account = write ? limits.writeAccount : limits.readAccount;
      const network = write ? limits.writeNetwork : limits.readNetwork;
      if (!(await account.consume(tokenDigest(`material-bookmarks:user:${session.userId}`, config.tokenPepper))) ||
          !(await network.consume(tokenDigest(`material-bookmarks:ip:${address}`, config.tokenPepper)))) {
        response.setHeader("Retry-After", "15");
        send(response, 429, { error: "rate_limit_exceeded" });
        return true;
      }
      const identity = { userId: session.userId, sessionId: session.id };
      if (!write) {
        send(response, 200, { userId: String(session.userId), items: await store.listMaterialBookmarks(identity), limit: MAX_MATERIAL_BOOKMARKS });
      } else if (!(await emptyJson(request))) {
        send(response, 400, { error: "invalid_material_bookmark_body" });
      } else {
        send(response, 200, { userId: String(session.userId), ...await store.setMaterialBookmark({ ...identity, materialId, active: request.method === "PUT" }) });
      }
    } catch (error) {
      if (error.code === "MATERIAL_BOOKMARK_SESSION_INVALID") send(response, 401, { error: "authentication_required" });
      else if (error.code === "MATERIAL_BOOKMARK_LIMIT") send(response, 409, { error: "material_bookmark_limit" });
      else send(response, 503, { error: "material_bookmarks_unavailable" });
    }
    return true;
  };
}
