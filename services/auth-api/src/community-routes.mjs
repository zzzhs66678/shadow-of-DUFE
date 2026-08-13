import { parseCookies } from "./cookies.mjs";
import { isOpaqueToken, tokenDigest } from "./tokens.mjs";
import {
  isCommunityUuid,
  validateCommentCreate,
  validateCommentUpdate,
  validateCommunityReport,
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

function parseCursor(value) {
  if (value === null || value === "") return null;
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return false;
  }
}

function decodeCursor(value) {
  const parsed = parseCursor(value);
  if (parsed === null || parsed === false) return parsed;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Object.keys(parsed).sort().join("|") !== "createdAt|id" ||
    !UUID_PATTERN.test(parsed.id) ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt))
  ) {
    return false;
  }
  return { id: parsed.id, createdAt: new Date(parsed.createdAt).toISOString() };
}

function decodeTopicCursor(value, sort) {
  if (sort === "latest") return decodeCursor(value);
  const parsed = parseCursor(value);
  if (parsed === null || parsed === false) return parsed;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Object.keys(parsed).sort().join("|") !== "createdAt|id|rankedAt|score" ||
    !UUID_PATTERN.test(parsed.id) ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    typeof parsed.rankedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.rankedAt)) ||
    typeof parsed.score !== "string" ||
    !/^\d{1,18}$/u.test(parsed.score)
  ) {
    return false;
  }
  return {
    id: parsed.id,
    createdAt: new Date(parsed.createdAt).toISOString(),
    rankedAt: new Date(parsed.rankedAt).toISOString(),
    score: parsed.score,
  };
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

async function writeRateAllowed(
  request,
  userId,
  rateLimiters,
  config,
  limiterName = "communityWrite",
) {
  const accountLimiter = rateLimiters[limiterName] ?? rateLimiters.write;
  const networkLimiter = rateLimiters[`${limiterName}Ip`] ?? rateLimiters.write;
  const userKey = tokenDigest(
    `${limiterName}:user:${userId}`,
    config.tokenPepper,
  );
  const ipKey = tokenDigest(
    `${limiterName}:ip:${clientAddress(request)}`,
    config.tokenPepper,
  );
  if (!(await accountLimiter.consume(userKey))) return false;
  return networkLimiter.consume(ipKey);
}

function handleStoreError(error, response) {
  if (error?.code === "COMMUNITY_POSTING_FORBIDDEN") {
    sendJson(response, 403, { error: "community_posting_forbidden" });
    return true;
  }
  if (error?.code === "COMMUNITY_ACTION_FORBIDDEN") {
    sendJson(response, 403, { error: "community_action_forbidden" });
    return true;
  }
  if (
    error?.code === "COMMUNITY_BLOCK_SELF" ||
    error?.code === "COMMUNITY_REPORT_SELF"
  ) {
    sendJson(response, 400, { error: "invalid_community_target" });
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

    async function writeAccess(limiterName = "communityWrite") {
      if (!session) {
        sendJson(response, 401, { error: "authentication_required" });
        return false;
      }
      if (
        !(await writeRateAllowed(
          request,
          session.userId,
          rateLimiters,
          config,
          limiterName,
        ))
      ) {
        response.setHeader("Retry-After", "30");
        sendJson(response, 429, {
          error: limiterName === "communityReport"
            ? "community_report_rate_limited"
            : "community_write_rate_limited",
        });
        return false;
      }
      return true;
    }

    async function writeInput(validator, limiterName = "communityWrite") {
      if (!(await writeAccess(limiterName))) return null;
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

    function requireSession() {
      if (session) return true;
      sendJson(response, 401, { error: "authentication_required" });
      return false;
    }

    if (url.pathname === "/api/community/notifications") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      if (!requireSession()) return true;
      const limit = pageLimit(url.searchParams.get("limit"));
      const cursor = decodeCursor(url.searchParams.get("cursor"));
      if (limit === null || cursor === false) {
        sendJson(response, 400, { error: "invalid_community_query" });
        return true;
      }
      const result = await store.listCommunityNotifications({
        userId: session.userId,
        cursor,
        limit,
      });
      sendJson(response, 200, {
        items: result.items,
        nextCursor: encodeCursor(result.nextCursor),
      });
      return true;
    }

    if (url.pathname === "/api/community/notifications/unread-count") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      if (!requireSession()) return true;
      sendJson(response, 200, {
        unread: await store.getCommunityUnreadCount(session.userId),
      });
      return true;
    }

    if (url.pathname === "/api/community/notifications/read-all") {
      if (request.method !== "PUT") {
        methodNotAllowed(response, "PUT");
        return true;
      }
      if (!(await writeAccess("communityReaction"))) return true;
      sendJson(
        response,
        200,
        await store.markAllCommunityNotificationsRead(session.userId),
      );
      return true;
    }

    const notificationMatch = url.pathname.match(
      /^\/api\/community\/notifications\/([0-9a-f-]{36})$/iu,
    );
    if (notificationMatch) {
      if (!isCommunityUuid(notificationMatch[1])) {
        sendJson(response, 404, { error: "community_notification_not_found" });
        return true;
      }
      if (request.method !== "PUT" && request.method !== "DELETE") {
        methodNotAllowed(response, "PUT, DELETE");
        return true;
      }
      if (!(await writeAccess("communityReaction"))) return true;
      if (request.method === "PUT") {
        const notification = await store.markCommunityNotificationRead({
          userId: session.userId,
          notificationId: notificationMatch[1],
        });
        if (!notification) {
          sendJson(response, 404, {
            error: "community_notification_not_found",
          });
        } else {
          sendJson(response, 200, { notification });
        }
      } else {
        const dismissed = await store.dismissCommunityNotification({
          userId: session.userId,
          notificationId: notificationMatch[1],
        });
        if (!dismissed) {
          sendJson(response, 404, {
            error: "community_notification_not_found",
          });
        } else {
          sendJson(response, 200, { dismissed: true });
        }
      }
      return true;
    }

    const userProfileMatch = url.pathname.match(
      /^\/api\/community\/users\/([0-9a-f-]{36})$/iu,
    );
    if (userProfileMatch) {
      if (!isCommunityUuid(userProfileMatch[1])) {
        sendJson(response, 404, { error: "community_user_not_found" });
        return true;
      }
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const limit = pageLimit(url.searchParams.get("limit"));
      const cursor = decodeCursor(url.searchParams.get("cursor"));
      const kind = url.searchParams.get("kind") ?? "topics";
      if (
        limit === null ||
        cursor === false ||
        !["topics", "comments"].includes(kind)
      ) {
        sendJson(response, 400, { error: "invalid_community_query" });
        return true;
      }
      const profile = await store.getCommunityUserProfile({
        userId: userProfileMatch[1],
        viewerUserId,
      });
      if (!profile) {
        sendJson(response, 404, { error: "community_user_not_found" });
        return true;
      }
      const result = await store.listCommunityUserContent({
        userId: userProfileMatch[1],
        viewerUserId,
        kind,
        cursor,
        limit,
      });
      sendJson(response, 200, {
        profile,
        kind,
        items: result.items,
        nextCursor: encodeCursor(result.nextCursor),
      });
      return true;
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
      const sort = url.searchParams.get("sort") ?? "latest";
      if (!["latest", "hot"].includes(sort)) {
        sendJson(response, 400, { error: "invalid_community_query" });
        return true;
      }
      const cursor = decodeTopicCursor(url.searchParams.get("cursor"), sort);
      if (limit === null || cursor === false) {
        sendJson(response, 400, { error: "invalid_community_query" });
        return true;
      }
      const result = await store.listCommunityTopics({
        viewerUserId,
        cursor,
        limit,
        sort,
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

    const topicLikeMatch = url.pathname.match(
      /^\/api\/community\/topics\/([0-9a-f-]{36})\/like$/iu,
    );
    if (topicLikeMatch) {
      if (!isCommunityUuid(topicLikeMatch[1])) {
        sendJson(response, 404, { error: "community_content_not_found" });
        return true;
      }
      if (request.method !== "PUT" && request.method !== "DELETE") {
        methodNotAllowed(response, "PUT, DELETE");
        return true;
      }
      if (!(await writeAccess("communityReaction"))) return true;
      await runWrite(async () => ({
        like: await store.setCommunityLike({
          targetType: "topic",
          targetId: topicLikeMatch[1],
          userId: session.userId,
          active: request.method === "PUT",
        }),
      }));
      return true;
    }

    const topicBookmarkMatch = url.pathname.match(
      /^\/api\/community\/topics\/([0-9a-f-]{36})\/bookmark$/iu,
    );
    if (topicBookmarkMatch) {
      if (!isCommunityUuid(topicBookmarkMatch[1])) {
        sendJson(response, 404, { error: "community_content_not_found" });
        return true;
      }
      if (request.method !== "PUT" && request.method !== "DELETE") {
        methodNotAllowed(response, "PUT, DELETE");
        return true;
      }
      if (!(await writeAccess("communityReaction"))) return true;
      await runWrite(async () => ({
        bookmark: await store.setCommunityBookmark({
          topicId: topicBookmarkMatch[1],
          userId: session.userId,
          active: request.method === "PUT",
        }),
      }));
      return true;
    }

    const commentLikeMatch = url.pathname.match(
      /^\/api\/community\/comments\/([0-9a-f-]{36})\/like$/iu,
    );
    if (commentLikeMatch) {
      if (!isCommunityUuid(commentLikeMatch[1])) {
        sendJson(response, 404, { error: "community_content_not_found" });
        return true;
      }
      if (request.method !== "PUT" && request.method !== "DELETE") {
        methodNotAllowed(response, "PUT, DELETE");
        return true;
      }
      if (!(await writeAccess("communityReaction"))) return true;
      await runWrite(async () => ({
        like: await store.setCommunityLike({
          targetType: "comment",
          targetId: commentLikeMatch[1],
          userId: session.userId,
          active: request.method === "PUT",
        }),
      }));
      return true;
    }

    const blockMatch = url.pathname.match(
      /^\/api\/community\/users\/([0-9a-f-]{36})\/block$/iu,
    );
    if (blockMatch) {
      if (!isCommunityUuid(blockMatch[1])) {
        sendJson(response, 404, { error: "community_content_not_found" });
        return true;
      }
      if (request.method !== "PUT" && request.method !== "DELETE") {
        methodNotAllowed(response, "PUT, DELETE");
        return true;
      }
      if (!(await writeAccess())) return true;
      await runWrite(async () => ({
        block: await store.setCommunityBlock({
          blockerUserId: session.userId,
          blockedUserId: blockMatch[1],
          active: request.method === "PUT",
        }),
      }));
      return true;
    }

    if (url.pathname === "/api/community/reports") {
      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return true;
      }
      const input = await writeInput(
        validateCommunityReport,
        "communityReport",
      );
      if (!input) return true;
      await runWrite(async () => ({
        report: await store.createCommunityReport({
          reporterUserId: session.userId,
          ...input,
        }),
      }), 201);
      return true;
    }

    sendJson(response, 404, { error: "not_found" });
    return true;
  };
}

export const __test = {
  decodeCursor,
  decodeTopicCursor,
  encodeCursor,
  pageLimit,
};
