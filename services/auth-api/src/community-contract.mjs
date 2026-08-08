const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    normalized.length < 4 ||
    normalized.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeBody(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (
    normalized.length < 1 ||
    normalized.length > maxLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeOptionalDetail(value) {
  if (value === undefined || value === null || value === "") return null;
  const detail = normalizeBody(value, 1_000);
  return detail && detail.length >= 8 ? detail : null;
}

function version(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export function isCommunityUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function validateTopicCreate(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["title", "body", "visibility"]))
  ) {
    return null;
  }
  const title = normalizeTitle(value.title);
  const body = normalizeBody(value.body, 5_000);
  const visibility = value.visibility ?? "public";
  if (!title || !body || !["public", "unlisted"].includes(visibility)) {
    return null;
  }
  return { title, body, visibility };
}

export function validateTopicUpdate(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["title", "body", "visibility", "version"]))
  ) {
    return null;
  }
  const expectedVersion = version(value.version);
  if (!expectedVersion) return null;
  const hasTitle = Object.hasOwn(value, "title");
  const hasBody = Object.hasOwn(value, "body");
  const hasVisibility = Object.hasOwn(value, "visibility");
  if (!hasTitle && !hasBody && !hasVisibility) return null;
  const title = hasTitle ? normalizeTitle(value.title) : undefined;
  const body = hasBody ? normalizeBody(value.body, 5_000) : undefined;
  const visibility = hasVisibility ? value.visibility : undefined;
  if (
    (hasTitle && !title) ||
    (hasBody && !body) ||
    (hasVisibility && !["public", "unlisted"].includes(visibility))
  ) {
    return null;
  }
  return { title, body, visibility, expectedVersion };
}

export function validateVersionedDelete(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["version"])) ||
    Object.keys(value).length !== 1
  ) {
    return null;
  }
  const expectedVersion = version(value.version);
  return expectedVersion ? { expectedVersion } : null;
}

export function validateCommentCreate(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["body", "replyToCommentId"]))
  ) {
    return null;
  }
  const body = normalizeBody(value.body, 3_000);
  const replyToCommentId = value.replyToCommentId ?? null;
  if (!body || (replyToCommentId !== null && !isCommunityUuid(replyToCommentId))) {
    return null;
  }
  return { body, replyToCommentId };
}

export function validateCommentUpdate(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["body", "version"])) ||
    Object.keys(value).length !== 2
  ) {
    return null;
  }
  const body = normalizeBody(value.body, 3_000);
  const expectedVersion = version(value.version);
  return body && expectedVersion ? { body, expectedVersion } : null;
}

export function validateCommunityReport(value) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set(["targetType", "targetId", "reasonCode", "detail"]),
    )
  ) {
    return null;
  }
  const targetType = value.targetType;
  const targetId = value.targetId;
  const reasonCode = value.reasonCode;
  const detail = normalizeOptionalDetail(value.detail);
  if (
    !["topic", "comment", "user"].includes(targetType) ||
    !isCommunityUuid(targetId) ||
    ![
      "harassment",
      "privacy",
      "spam",
      "misinformation",
      "illegal",
      "self_harm",
      "other",
    ].includes(reasonCode) ||
    (Object.hasOwn(value, "detail") && value.detail && !detail) ||
    (reasonCode === "other" && !detail)
  ) {
    return null;
  }
  return { targetType, targetId, reasonCode, detail };
}
