import { parseCookies } from "./cookies.mjs";
import { isOpaqueToken, tokenDigest } from "./tokens.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

function methodNotAllowed(response, allow) {
  response.setHeader("Allow", allow);
  sendJson(response, 405, { error: "method_not_allowed" });
}

function pageLimit(value) {
  if (value === null || value === "") return 20;
  if (!/^\d{1,2}$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= 30 ? parsed : null;
}

function encodeCursor(cursor) {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (value === null || value === "") return null;
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !UUID_PATTERN.test(parsed.id) ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt))
    ) {
      return false;
    }
    return { id: parsed.id, createdAt: new Date(parsed.createdAt).toISOString() };
  } catch {
    return false;
  }
}

async function optionalSession(request, store, config) {
  const sessionToken = parseCookies(request.headers.cookie).get(
    config.sessionCookie,
  );
  if (!isOpaqueToken(sessionToken)) return null;
  return store.getActiveSession(
    tokenDigest(sessionToken, config.tokenPepper),
  );
}

export function createCommunityRequestHandler({ store, config }) {
  return async function handleCommunityRequest(request, response, url) {
    if (!url.pathname.startsWith("/api/community/")) return false;

    const session = await optionalSession(request, store, config);
    const viewerUserId = session?.userId ?? null;

    if (url.pathname === "/api/community/topics") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const limit = pageLimit(url.searchParams.get("limit"));
      const cursor = decodeCursor(url.searchParams.get("cursor"));
      const sort = url.searchParams.get("sort") ?? "latest";
      if (limit === null || cursor === false || sort !== "latest") {
        sendJson(response, 400, { error: "invalid_community_query" });
        return true;
      }
      const result = await store.listCommunityTopics({
        viewerUserId,
        cursor,
        limit,
      });
      sendJson(response, 200, {
        items: result.items,
        nextCursor: encodeCursor(result.nextCursor),
      });
      return true;
    }

    const topicMatch = url.pathname.match(
      /^\/api\/community\/topics\/([0-9a-f-]{36})$/iu,
    );
    if (topicMatch) {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      if (!UUID_PATTERN.test(topicMatch[1])) {
        sendJson(response, 404, { error: "community_topic_not_found" });
        return true;
      }
      const topic = await store.getCommunityTopic({
        topicId: topicMatch[1],
        viewerUserId,
      });
      if (!topic) {
        sendJson(response, 404, { error: "community_topic_not_found" });
      } else if (topic.status !== "published") {
        sendJson(response, topic.status === "deleted" ? 410 : 404, {
          error: "community_topic_unavailable",
          status: topic.status,
          fallbackPath: topic.fallbackPath,
        });
      } else {
        sendJson(response, 200, { topic });
      }
      return true;
    }

    const commentsMatch = url.pathname.match(
      /^\/api\/community\/topics\/([0-9a-f-]{36})\/comments$/iu,
    );
    if (commentsMatch) {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      if (!UUID_PATTERN.test(commentsMatch[1])) {
        sendJson(response, 404, { error: "community_topic_not_found" });
        return true;
      }
      const limit = pageLimit(url.searchParams.get("limit"));
      const cursor = decodeCursor(url.searchParams.get("cursor"));
      if (limit === null || cursor === false) {
        sendJson(response, 400, { error: "invalid_community_query" });
        return true;
      }
      const topic = await store.getCommunityTopic({
        topicId: commentsMatch[1],
        viewerUserId,
      });
      if (!topic || topic.status !== "published") {
        sendJson(response, topic?.status === "deleted" ? 410 : 404, {
          error: topic ? "community_topic_unavailable" : "community_topic_not_found",
          ...(topic?.fallbackPath ? { fallbackPath: topic.fallbackPath } : {}),
        });
        return true;
      }
      const result = await store.listCommunityComments({
        topicId: commentsMatch[1],
        viewerUserId,
        cursor,
        limit,
      });
      sendJson(response, 200, {
        items: result.items,
        nextCursor: encodeCursor(result.nextCursor),
      });
      return true;
    }

    sendJson(response, 404, { error: "not_found" });
    return true;
  };
}

export const __test = { decodeCursor, encodeCursor, pageLimit };
