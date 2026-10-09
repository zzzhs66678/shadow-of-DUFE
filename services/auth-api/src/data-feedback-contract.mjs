// Browser-safe contract: no account, storage, location or Node dependencies.
export const DATA_FEEDBACK_TYPES = ["course", "room", "material"];
const coursePattern = /^(?:[0-9]{6,12}[A-Za-z]{0,3}|[A-Z]{2,6}[0-9]{3,8})$/u;
const meetingPattern = /^(fall|spring)-([0-9]{6,12}[A-Za-z]{0,3}|[A-Z]{2,6}[0-9]{3,8})-[A-Za-z0-9]{1,12}-[0-9]{1,8}(?:-venue)?(?:-m[0-9]{1,3})?$/u;
const materialPattern = /^[a-f0-9]{20}$/u;
const roomPattern = /^(之远楼|笃行楼|书音楼|播慧楼|砺金楼)\|[A-Za-z0-9-]{1,20}$/u;
export const isFeedbackUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

// Deliberately reconstruct the path. Never copy location.search, referrer or returnTo.
export function buildDataFeedbackContext(input) {
  if (!input || !DATA_FEEDBACK_TYPES.includes(input.type)) return null;
  const { type } = input;
  const courseId = input.courseId ?? null;
  const meetingId = input.meetingId ?? null;
  const materialId = input.materialId ?? null;
  const room = input.room ?? null;
  if (courseId !== null && (typeof courseId !== "string" || !coursePattern.test(courseId))) return null;
  if (meetingId !== null && (typeof meetingId !== "string" || !meetingPattern.test(meetingId) || meetingId.match(meetingPattern)[2] !== courseId)) return null;
  if (materialId !== null && (typeof materialId !== "string" || !materialPattern.test(materialId))) return null;
  if (room !== null && (typeof room !== "string" || !roomPattern.test(room))) return null;
  if (type === "course" && (!courseId || materialId || room)) return null;
  if (type === "room" && (!room || courseId || meetingId || materialId)) return null;
  if (type === "material" && (!materialId || courseId || meetingId || room)) return null;
  const query = new URLSearchParams();
  let path;
  if (type === "material") path = `/materials/${materialId}`;
  else {
    query.set("view", type === "room" ? "rooms" : "courses");
    if (courseId) query.set("course", courseId);
    if (meetingId) query.set("meeting", meetingId);
    if (room) query.set("room", room);
    path = `/?${query}`;
  }
  return { type, courseId, meetingId, materialId, room, path };
}

export function feedbackText(value, min = 2, max = 500) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= min && text.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ? text : null;
}

export function validateDataFeedback(input) {
  if (!exact(input, ["type", "courseId", "meetingId", "materialId", "room", "path", "message", "requestKey"])) return null;
  const context = buildDataFeedbackContext(input);
  const message = feedbackText(input.message);
  if (!context || input.path !== context.path || !message || !isFeedbackUuid(input.requestKey)) return null;
  return { ...context, message, requestKey: input.requestKey.toLowerCase() };
}

export function validateFeedbackResolution(input) {
  if (!exact(input, ["status", "version", "note"]) || !["open", "resolved"].includes(input.status) || !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 2147483646) return null;
  const note = feedbackText(input.note);
  return note ? { status: input.status, version: input.version, note } : null;
}

export function feedbackPageQuery(params, admin = false) {
  const keys = [...params.keys()];
  if (keys.some(key => !["limit", "cursor", ...(admin ? ["status"] : [])].includes(key)) || new Set(keys).size !== keys.length) return null;
  const rawLimit = params.get("limit") ?? "20";
  if (!/^[0-9]{1,2}$/u.test(rawLimit) || +rawLimit < 1 || +rawLimit > 50) return null;
  const status = admin ? params.get("status") ?? "open" : null;
  if (admin && !["open", "resolved"].includes(status)) return null;
  const cursor = params.get("cursor");
  if (cursor !== null && !isFeedbackUuid(cursor)) return null;
  return { limit: +rawLimit, status, cursor };
}
