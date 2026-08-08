import { parseCookies } from "./cookies.mjs";
import { isOpaqueToken, tokenDigest } from "./tokens.mjs";
import {
  isCommunityUuid,
  validateCommentCreate,
  validateCommentUpdate,
  validateTopicCreate,
  validateTopicUpdate,
  validateVersionedDelete,
} from "./community-contract.mjs";

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

function trustedOrigin(request, allowedOrigins) {
  const origin = request.headers.origin;
  return typeof origin === "string" && allowedOrigins.has(origin);
}

function clientAddress(request) {
  const forwarded = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded.at(-1) || request.socket.remoteAddress || "unknown";
}

async function readJsonBody(request, maxBytes = 24_576) {
  const contentType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
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

function writeRateAllowed(request, userId, rateLimiters, config) {
  const limiter = rateLimiters.communityWrite ?? rateLimiters.write;
  const userKey = tokenDigest(
    `community-write:user:${userId}`,
    config.tokenPepper,
  );
  const ipKey = tokenDigest(
    `community-write:ip:${clientAddress(request)}`,
    config.tokenPepper,
  );
  return limiter.consume(userKey) && limiter.consume(ipKey);
}

function handleStoreError(error, response) {
  if (error?.code === "COMMUNITY_POSTING_FORBIDDEN") {
    sendJson(response, 403, { error: "community_posting_forbidden" });
    return true;
  }
  if (error?.code === "COMMUNITY_CONTENT_NOT_FOUND") {
    sendJson(response, 404, { error: "community_content_not_found" });
    return true;
  }
  if (
    error?.code === "COMMUNITY_CONTENT_UNAVAILABLE" ||
    error?.code === "COMMUNITY_TOPIC_UNAVAILABLE" ||
    error?.code === "COMMUNITY_REPLY_TARGET_UNAVAILABLE"
  ) {
    sendJson(response, 409, { error: "community_content_unavailable" });
    return true;
  }
  if (error?.code === "COMMUNITY_VERSION_CONFLICT") {
    sendJson(response, 409, {
      error: "community_version_conflict",
      currentVersion: error.currentVersion,
    });
    return true;
  }
  return false;
}

export function createCommunityRequestHandler({ store, config, rateLimiters }) {
  return async function handleCommunityRequest(request, response, url) {
    if (!url.pathname.startsWith("/api/community/")) return false;

    const isWrite = request.method !== "GET" && request.method !== "HEAD";
    if (isWrite && !trustedOrigin(request, config.allowedOrigins)) {
      sendJson(response, 403, { error: "untrusted_origin" });
      return true;
    }
    const session = await optionalSession(request, store, config);
    const viewerUserId = session?.userId ?? null;

    async function writeInput(validator) {
      if (!session) {
        sendJson(response, 401, { error: "authentication_required" });
        return null;
      }
      if (!writeRateAllowed(request, session.userId, rateLimiters, config)) {
        response.setHeader("Retry-After", "30");
        sendJson(response, 429, { error: "community_write_rate_limited" });
        return null;
      }
      const input = validator(await readJsonBody(request));
      if (!input) {
        sendJson(response, 400, { error: "invalid_community_body" });
        return null;
      }
      return input;
    }

    async function runWrite(callback, successStatus = 200) {
      try {
        const result = await callback();
        sendJson(response, successStatus, result);
      } catch (error) {
        if (!handleStoreError(error, response)) throw error;
      }
    }

    if (url.pathname === "/api/community/topics") {
      if (request.method === "POST") {
        const input = await writeInput(validateTopicCreate);
        if (!input) return true;
        await runWrite(async () => ({
          topic: await store.createCommunityTopic({
            userId: session.userId,
            ...input,
          }),
        }), 201);
        return true;
      }
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET, POST");
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
      if (!UUID_PATTERN.test(topicMatch[1])) {
        sendJson(response, 404, { error: "community_topic_not_found" });
        return true;
      }
      if (request.method === "PATCH" || request.method === "DELETE") {
        const validator = request.method === "PATCH"
          ? validateTopicUpdate
          : validateVersionedDelete;
        const input = await writeInput(validator);
        if (!input) return true;
        await runWrite(async () => ({
          topic: request.method === "PATCH"
            ? await store.updateCommunityTopic({
                topicId: topicMatch[1],
                userId: session.userId,
                ...input,
              })
            : await store.deleteCommunityTopic({
                topicId: topicMatch[1],
                userId: session.userId,
                ...input,
              }),
        }));
        return true;
      }
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET, PATCH, DELETE");
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
      if (!UUID_PATTERN.test(commentsMatch[1])) {
        sendJson(response, 404, { error: "community_topic_not_found" });
        return true;
      }
      if (request.method === "POST") {
        const input = await writeInput(validateCommentCreate);
        if (!input) return true;
        await runWrite(async () => ({
          comment: await store.createCommunityComment({
            topicId: commentsMatch[1],
            userId: session.userId,
            ...input,
          }),
        }), 201);
        return true;
      }
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET, POST");
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

    const commentMatch = url.pathname.match(
      /^\/api\/community\/comments\/([0-9a-f-]{36})$/iu,
    );
    if (commentMatch) {
      if (!isCommunityUuid(commentMatch[1])) {
        sendJson(response, 404, { error: "community_content_not_found" });
        return true;
      }
      if (request.method !== "PATCH" && request.method !== "DELETE") {
        methodNotAllowed(response, "PATCH, DELETE");
        return true;
      }
      const validator = request.method === "PATCH"
        ? validateCommentUpdate
        : validateVersionedDelete;
      const input = await writeInput(validator);
      if (!input) return true;
      await runWrite(async () => ({
        comment: request.method === "PATCH"
          ? await store.updateCommunityComment({
              commentId: commentMatch[1],
              userId: session.userId,
              ...input,
            })
          : await store.deleteCommunityComment({
              commentId: commentMatch[1],
              userId: session.userId,
              ...input,
            }),
      }));
      return true;
    }

    sendJson(response, 404, { error: "not_found" });
    return true;
  };
}

export const __test = { decodeCursor, encodeCursor, pageLimit };
