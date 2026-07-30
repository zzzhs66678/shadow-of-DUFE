import { contentHash } from "./security.mjs";

function requiredText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`白果云记录缺少 ${field}`);
  return normalized;
}

function optionalText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function withHash(record) {
  return { ...record, contentHash: contentHash(record) };
}

export function normalizeBaiguoSnapshot(snapshot, syncedAt = new Date().toISOString()) {
  const source = "baiguo";
  const courses = Array.isArray(snapshot?.courses) ? snapshot.courses : [];
  const assignments = Array.isArray(snapshot?.assignments) ? snapshot.assignments : [];
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const notifications = Array.isArray(snapshot?.notifications) ? snapshot.notifications : [];

  return {
    source,
    syncedAt,
    courses: courses.map((course) =>
      withHash({
        source,
        externalId: requiredText(course.externalId, "课程 externalId"),
        title: requiredText(course.title, "课程名称"),
        sectionExternalId: optionalText(course.sectionExternalId),
      }),
    ),
    assignments: assignments.map((assignment) =>
      withHash({
        source,
        externalId: requiredText(assignment.externalId, "作业 externalId"),
        courseExternalId: requiredText(assignment.courseExternalId, "作业 courseExternalId"),
        title: requiredText(assignment.title, "作业标题"),
        publishedAt: optionalText(assignment.publishedAt),
        dueAt: optionalText(assignment.dueAt),
        status: optionalText(assignment.status) ?? "unknown",
      }),
    ),
    events: events.map((event) =>
      withHash({
        source,
        externalId: requiredText(event.externalId, "活动 externalId"),
        courseExternalId: optionalText(event.courseExternalId),
        title: requiredText(event.title, "活动标题"),
        startsAt: requiredText(event.startsAt, "活动开始时间"),
        endsAt: optionalText(event.endsAt),
        eventType: optionalText(event.eventType) ?? "course_event",
      }),
    ),
    notifications: notifications.map((notification) =>
      withHash({
        source,
        externalId: requiredText(notification.externalId, "通知 externalId"),
        title: requiredText(notification.title, "通知标题"),
        publishedAt: optionalText(notification.publishedAt),
        read: Boolean(notification.read),
        sourcePath: optionalText(notification.sourcePath),
      }),
    ),
  };
}
