const TEACHER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COURSE_CATALOG_ID = /^course-v1:[0-9a-f]{64}$/u;

type TeacherLookupResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

export type TeacherLookupFetch = (
  input: string,
  init?: RequestInit,
) => Promise<TeacherLookupResponse>;

export function teacherSearchHref(teacherName: string) {
  return `/teachers?q=${encodeURIComponent(teacherName)}`;
}

export function isCourseCatalogId(value: string) {
  return COURSE_CATALOG_ID.test(value);
}

export function teacherReviewLinksFromSchedulePayload(payload: unknown): Array<{ href: string; name: string; count: number }> {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items)) return [];
  const seen = new Set<string>();
  return ((payload as { items: unknown[] }).items).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { id, displayName, reviewCount } = item as Record<string, unknown>;
    if (typeof id !== "string" || !TEACHER_ID.test(id) || seen.has(id) ||
      typeof displayName !== "string" || !displayName.trim() ||
      typeof reviewCount !== "number" || !Number.isSafeInteger(reviewCount) || reviewCount < 1) return [];
    seen.add(id);
    return [{ href: `/teachers/${encodeURIComponent(id)}#teacher-reviews-title`, name: displayName, count: reviewCount }];
  });
}

export function teacherTeachingHref(href: string, courseId?: string) {
  // Never attach a teaching destination to an ambiguous name-search result.
  if (!/^\/teachers\/[0-9a-f-]+$/iu.test(href)) return href;
  const query = new URLSearchParams({ panel: "teaching" });
  if (courseId) query.set("course", courseId);
  return `${href}?${query}#teacher-textbooks-title`;
}

export function teacherHrefFromSchedulePayload(
  teacherName: string,
  payload: unknown,
) {
  const fallback = teacherSearchHref(teacherName);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return fallback;
  }
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length !== 1) return fallback;
  const teacher = items[0];
  if (!teacher || typeof teacher !== "object" || Array.isArray(teacher)) {
    return fallback;
  }
  const id = (teacher as { id?: unknown }).id;
  return typeof id === "string" && TEACHER_ID.test(id)
    ? `/teachers/${encodeURIComponent(id)}`
    : fallback;
}

export async function resolveTeacherScheduleHref({
  catalogId,
  scheduleId,
  teacherName,
  fetcher,
  signal,
}: {
  catalogId: string;
  scheduleId: string;
  teacherName: string;
  fetcher: TeacherLookupFetch;
  signal?: AbortSignal;
}) {
  if (!isCourseCatalogId(catalogId) || !scheduleId) {
    return teacherSearchHref(teacherName);
  }
  const query = new URLSearchParams({ catalogId, scheduleId });
  const response = await fetcher(`/api/teachers/by-schedule?${query}`, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("teacher schedule lookup unavailable");
  return teacherHrefFromSchedulePayload(teacherName, await response.json());
}
