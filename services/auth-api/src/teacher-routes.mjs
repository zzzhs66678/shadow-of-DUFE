import { parseCookies } from "./cookies.mjs";
import { isOpaqueToken, tokenDigest } from "./tokens.mjs";
import {
  validateTeacherReviewDelete,
  validateTeacherReviewWrite,
} from "./teacher-review-contract.mjs";

function sendJson(response, statusCode, body, { privateResponse = false } = {}) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader(
    "Cache-Control",
    privateResponse ? "no-store, private" : "public, max-age=60, stale-while-revalidate=300",
  );
  if (privateResponse) response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

function methodNotAllowed(response, allow) {
  response.setHeader("Allow", allow);
  sendJson(response, 405, { error: "method_not_allowed" });
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value, fields) {
  if (!value) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (Object.keys(parsed).sort().join("|") !== [...fields].sort().join("|")) return undefined;
    if (fields.some((field) => typeof parsed[field] !== "string")) return undefined;
    if (!isUuid(parsed.id)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function boundedText(value, maxLength) {
  const text = String(value ?? "").normalize("NFKC").trim();
  return text.length <= maxLength ? text : null;
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

async function readJsonBody(request, maxBytes = 16_384) {
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

async function optionalSession(request, store, config) {
  const token = parseCookies(request.headers.cookie).get(config.sessionCookie);
  if (!isOpaqueToken(token)) return null;
  return store.getActiveSession(tokenDigest(token, config.tokenPepper));
}

async function writeRateAllowed(request, userId, rateLimiters, config) {
  const limiter = rateLimiters.teacherReviewWrite ?? rateLimiters.write;
  const userKey = tokenDigest(`teacher-review:user:${userId}`, config.tokenPepper);
  const ipKey = tokenDigest(
    `teacher-review:ip:${clientAddress(request)}`,
    config.tokenPepper,
  );
  if (!(await limiter.consume(userKey))) return false;
  return limiter.consume(ipKey);
}

function withoutCursor(item) {
  const result = { ...item };
  delete result.cursor;
  return result;
}

export function createTeacherRequestHandler({ store, config, rateLimiters }) {
  return async function handleTeacherRequest(request, response, url) {
    if (!url.pathname.startsWith("/api/teachers")) return false;

    if (url.pathname === "/api/teachers") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      const query = boundedText(url.searchParams.get("q"), 64);
      const college = boundedText(url.searchParams.get("college"), 160);
      const limitValue = url.searchParams.get("limit") ?? "30";
      const limit = /^\d{1,2}$/u.test(limitValue) ? Number(limitValue) : 0;
      const after = decodeCursor(
        url.searchParams.get("after"),
        ["normalizedName", "normalizedCollege", "id"],
      );
      if (query === null || college === null || limit < 1 || limit > 50 || after === undefined) {
        sendJson(response, 400, { error: "invalid_teacher_query" });
        return true;
      }
      const teachers = await store.listPublicTeachers({ query, college, after, limit });
      const last = teachers.length === limit ? teachers.at(-1) : null;
      sendJson(response, 200, {
        items: teachers.map(withoutCursor),
        nextCursor: last ? encodeCursor(last.cursor) : null,
      });
      return true;
    }

    const myReviewMatch = url.pathname.match(
      /^\/api\/teachers\/([0-9a-f-]{36})\/my-review$/iu,
    );
    if (myReviewMatch) {
      if (!isUuid(myReviewMatch[1])) {
        sendJson(response, 404, { error: "teacher_not_found" }, { privateResponse: true });
        return true;
      }
      if (!["GET", "PUT", "DELETE"].includes(request.method)) {
        methodNotAllowed(response, "GET, PUT, DELETE");
        return true;
      }
      if (
        request.method !== "GET" &&
        !trustedOrigin(request, config.allowedOrigins)
      ) {
        sendJson(response, 403, { error: "untrusted_origin" }, { privateResponse: true });
        return true;
      }
      const session = await optionalSession(request, store, config);
      if (!session) {
        sendJson(response, 401, { error: "authentication_required" }, { privateResponse: true });
        return true;
      }
      if (request.method === "GET") {
        const teacher = await store.getPublicTeacherDetail(myReviewMatch[1]);
        if (!teacher) {
          sendJson(response, 404, { error: "teacher_not_found" }, { privateResponse: true });
          return true;
        }
        const review = await store.getUserTeacherReview({
          teacherId: myReviewMatch[1],
          userId: session.userId,
        });
        sendJson(response, 200, { review }, { privateResponse: true });
        return true;
      }
      if (
        !(await writeRateAllowed(
          request,
          session.userId,
          rateLimiters,
          config,
        ))
      ) {
        response.setHeader("Retry-After", "300");
        sendJson(
          response,
          429,
          { error: "teacher_review_rate_limit_exceeded" },
          { privateResponse: true },
        );
        return true;
      }
      const body = await readJsonBody(request);
      try {
        if (request.method === "PUT") {
          const input = validateTeacherReviewWrite(body);
          if (!input) {
            sendJson(response, 400, { error: "invalid_teacher_review" }, { privateResponse: true });
            return true;
          }
          const review = await store.saveUserTeacherReview({
            teacherId: myReviewMatch[1],
            userId: session.userId,
            ...input,
          });
          sendJson(
            response,
            input.expectedVersion === null ? 201 : 200,
            { review },
            { privateResponse: true },
          );
          return true;
        }
        const input = validateTeacherReviewDelete(body);
        if (!input) {
          sendJson(response, 400, { error: "invalid_teacher_review_delete" }, { privateResponse: true });
          return true;
        }
        const review = await store.deleteUserTeacherReview({
          teacherId: myReviewMatch[1],
          userId: session.userId,
          ...input,
        });
        sendJson(response, 200, { review }, { privateResponse: true });
        return true;
      } catch (error) {
        if (error?.code === "TEACHER_REVIEW_TARGET_NOT_FOUND") {
          sendJson(response, 404, { error: "teacher_not_found" }, { privateResponse: true });
          return true;
        }
        if (error?.code === "TEACHER_REVIEW_NOT_FOUND") {
          sendJson(response, 404, { error: "teacher_review_not_found" }, { privateResponse: true });
          return true;
        }
        if (error?.code === "TEACHER_REVIEW_VERSION_CONFLICT") {
          sendJson(
            response,
            409,
            { error: "teacher_review_version_conflict", currentVersion: error.currentVersion },
            { privateResponse: true },
          );
          return true;
        }
        throw error;
      }
    }

    const reviewsMatch = url.pathname.match(
      /^\/api\/teachers\/([0-9a-f-]{36})\/reviews$/iu,
    );
    if (reviewsMatch) {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      if (!isUuid(reviewsMatch[1])) {
        sendJson(response, 404, { error: "teacher_not_found" });
        return true;
      }
      const limitValue = url.searchParams.get("limit") ?? "20";
      const limit = /^\d{1,2}$/u.test(limitValue) ? Number(limitValue) : 0;
      const after = decodeCursor(url.searchParams.get("after"), ["publishedAt", "id"]);
      if (limit < 1 || limit > 30 || after === undefined) {
        sendJson(response, 400, { error: "invalid_teacher_review_query" });
        return true;
      }
      const teacher = await store.getPublicTeacherDetail(reviewsMatch[1]);
      if (!teacher) {
        sendJson(response, 404, { error: "teacher_not_found" });
        return true;
      }
      const reviews = await store.listPublicTeacherReviews({
        teacherId: reviewsMatch[1],
        after,
        limit,
      });
      const last = reviews.length === limit ? reviews.at(-1) : null;
      sendJson(response, 200, {
        items: reviews.map(withoutCursor),
        nextCursor: last ? encodeCursor(last.cursor) : null,
      });
      return true;
    }

    const detailMatch = url.pathname.match(/^\/api\/teachers\/([0-9a-f-]{36})$/iu);
    if (detailMatch) {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return true;
      }
      if (!isUuid(detailMatch[1])) {
        sendJson(response, 404, { error: "teacher_not_found" });
        return true;
      }
      const teacher = await store.getPublicTeacherDetail(detailMatch[1]);
      if (!teacher) {
        sendJson(response, 404, { error: "teacher_not_found" });
      } else {
        sendJson(response, 200, { teacher });
      }
      return true;
    }

    sendJson(response, 404, { error: "not_found" });
    return true;
  };
}
