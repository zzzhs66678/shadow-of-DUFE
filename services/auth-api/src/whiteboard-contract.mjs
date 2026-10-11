const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const textLimits = { title: 120, body: 4000, guest: 80, guestBio: 1500, location: 160 };
const contentKeys = ["kind", ...Object.keys(textLimits), "startsAt", "endsAt", "expiresAt", "status"];
export const isWhiteboardUuid = value => typeof value === "string" && UUID.test(value);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const visible = value => value.replace(/[\s\p{Default_Ignorable_Code_Point}\p{Mark}\u2800]/gu, "").length > 0;

// Accept an explicit UTC or China offset; reject local/ambiguous dates and
// impossible calendar dates instead of letting Date silently normalize them.
export function whiteboardTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|\+08:00)$/u.exec(value);
  if (!match || match[1].startsWith("0000")) return undefined;
  const local = `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}.${(match[5] ?? "").padEnd(3, "0")}Z`;
  const parsed = new Date(local);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== local) return undefined;
  const date = new Date(parsed.getTime() - (match[6] === "+08:00" ? 8 * 3600_000 : 0));
  const result = date.toISOString();
  return result.startsWith("0000") ? undefined : result;
}

function text(value, max, multiline) {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Surrogate}]/u.test(normalized) ||
      (!multiline && /[\n\t\u2028\u2029]/u.test(normalized))) return undefined;
  if (normalized && !visible(normalized)) return undefined;
  return normalized;
}

export function validateWhiteboardContent(value) {
  if (!only(value, contentKeys) || !["note", "event"].includes(value.kind) ||
      !["draft", "published", "withdrawn"].includes(value.status)) return null;
  const result = { kind: value.kind };
  for (const [key, max] of Object.entries(textLimits)) {
    result[key] = text(Object.hasOwn(value, key) ? value[key] : key === "body" ? undefined : "", max, ["body", "guestBio"].includes(key));
    if (result[key] === undefined) return null;
  }
  if (!result.body) return null;
  for (const key of ["startsAt", "endsAt", "expiresAt"]) {
    result[key] = whiteboardTimestamp(value[key] === undefined ? null : value[key]);
    if (result[key] === undefined) return null;
  }
  if (result.kind === "note") {
    if (result.guest || result.guestBio || result.location || result.startsAt || result.endsAt) return null;
  } else if (!result.title || !result.startsAt || !result.endsAt || result.expiresAt || result.endsAt <= result.startsAt) return null;
  result.status = value.status;
  return result;
}

export function validateWhiteboardMutation(value, patch = false) {
  if (!only(value, [...contentKeys, "mutationId", ...(patch ? ["version"] : [])]) ||
      !isWhiteboardUuid(value.mutationId) || !["draft", "published", "withdrawn"].includes(value.status) ||
      (patch && (!Number.isSafeInteger(value.version) || value.version < 1 || value.version >= 2147483647))) return null;
  const fields = {};
  for (const key of contentKeys) {
    if (!Object.hasOwn(value, key)) continue;
    if (Object.hasOwn(textLimits, key)) fields[key] = text(value[key], textLimits[key], ["body", "guestBio"].includes(key));
    else if (["startsAt", "endsAt", "expiresAt"].includes(key)) fields[key] = whiteboardTimestamp(value[key]);
    else if (key === "kind") fields[key] = ["note", "event"].includes(value[key]) ? value[key] : undefined;
    else fields[key] = value[key];
    if (fields[key] === undefined) return null;
  }
  const data = patch ? fields : validateWhiteboardContent(fields);
  return data ? { mutationId: value.mutationId.toLowerCase(), ...(patch ? { version: value.version } : {}), fields: data } : null;
}

function validCursor(cursor, admin, scope) {
  return only(cursor, ["v", "scope", "at", "id"]) && Object.keys(cursor).length === 4 &&
    cursor.v === 1 && cursor.scope === `${admin ? "admin" : "public"}:${scope}` && isWhiteboardUuid(cursor.id) &&
    typeof cursor.at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(cursor.at) &&
    whiteboardTimestamp(cursor.at.replace(/(\.\d{3})\d{3}Z$/u, "$1Z")) === cursor.at.replace(/(\.\d{3})\d{3}Z$/u, "$1Z");
}

export function validWhiteboardPage(page, admin = false) {
  const scope = admin ? page?.status : page?.scope;
  return !!page && (admin ? ["all", "draft", "published", "withdrawn"] : ["active", "archive"]).includes(scope) &&
    Number.isInteger(page.limit) && page.limit >= 1 && page.limit <= 50 &&
    (page.cursor === null || validCursor(page.cursor, admin, scope));
}

export function whiteboardPageQuery(params, admin = false) {
  const key = admin ? "status" : "scope";
  if ([...params.keys()].some(name => ![key, "limit", "cursor"].includes(name) || params.getAll(name).length !== 1)) return null;
  const limit = params.get("limit") ?? (admin ? "50" : "20");
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(limit)) return null;
  let cursor = null;
  if (params.has("cursor")) {
    const encoded = params.get("cursor");
    if (encoded.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
    try { cursor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { return null; }
    if (!cursor) return null;
  }
  const page = { [key]: params.get(key) ?? (admin ? "all" : "active"), limit: Number(limit), cursor };
  return validWhiteboardPage(page, admin) ? page : null;
}

export const encodeWhiteboardCursor = value => Buffer.from(JSON.stringify(value)).toString("base64url");
