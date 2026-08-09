function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
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

function withoutCursor(item) {
  const result = { ...item };
  delete result.cursor;
  return result;
}

export function createTeacherRequestHandler({ store }) {
  return async function handleTeacherRequest(request, response, url) {
    if (!url.pathname.startsWith("/api/teachers")) return false;
    if (request.method !== "GET") {
      methodNotAllowed(response, "GET");
      return true;
    }

    if (url.pathname === "/api/teachers") {
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

    const reviewsMatch = url.pathname.match(
      /^\/api\/teachers\/([0-9a-f-]{36})\/reviews$/iu,
    );
    if (reviewsMatch) {
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
