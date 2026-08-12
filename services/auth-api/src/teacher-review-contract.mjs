const RATING_KEYS = [
  "courseOrganization",
  "contentClarity",
  "assessmentExplanation",
  "classroomInteraction",
  "materialCompleteness",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeBody(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (
    normalized.length < 20 ||
    normalized.length > 3_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeCommentBody(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (
    normalized.length < 1 ||
    normalized.length > 3_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) return null;
  return normalized;
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function normalizeRatings(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(RATING_KEYS)) ||
    Object.keys(value).length !== RATING_KEYS.length
  ) {
    return null;
  }
  const ratings = {};
  for (const key of RATING_KEYS) {
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 5) return null;
    ratings[key] = value[key];
  }
  return ratings;
}

export function validateTeacherReviewWrite(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["body", "ratings", "expectedVersion"]))
  ) {
    return null;
  }
  const body = normalizeBody(value.body);
  const ratings = normalizeRatings(value.ratings);
  const hasVersion = Object.hasOwn(value, "expectedVersion");
  const expectedVersion = hasVersion ? value.expectedVersion : null;
  if (
    !body ||
    !ratings ||
    (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))
  ) {
    return null;
  }
  return { body, ratings, expectedVersion };
}

export function validateTeacherReviewDelete(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["version"])) ||
    Object.keys(value).length !== 1 ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  ) {
    return null;
  }
  return { expectedVersion: value.version };
}

export function validateTeacherReviewCommentCreate(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["body", "replyToCommentId"]))
  ) return null;
  const body = normalizeCommentBody(value.body);
  const replyToCommentId = value.replyToCommentId ?? null;
  if (!body || (replyToCommentId !== null && !isUuid(replyToCommentId))) return null;
  return { body, replyToCommentId };
}

export function validateTeacherReviewCommentUpdate(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["body", "version"])) ||
    Object.keys(value).length !== 2
  ) return null;
  const body = normalizeCommentBody(value.body);
  return body && Number.isSafeInteger(value.version) && value.version >= 1
    ? { body, expectedVersion: value.version }
    : null;
}

export const __test = { RATING_KEYS };
