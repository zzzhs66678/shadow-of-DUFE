import { createHash } from "node:crypto";

const text = (value) => String(value ?? "").trim();

function canonicalSchedule(schedule) {
  return {
    scheduleId: text(schedule.id),
    sectionId: text(schedule.sectionId),
    term: text(schedule.term),
    courseId: text(schedule.courseId),
    title: text(schedule.title),
    teacher: text(schedule.teacher),
    weekday: Number(schedule.weekday),
    block: Number(schedule.block),
    periods: [...(schedule.periods ?? [])].map(Number),
    weeks: [...(schedule.weeks ?? [])].map(Number),
    building: text(schedule.building),
    room: text(schedule.room),
    classNames: text(schedule.classNames),
    linked: schedule.linked === true,
  };
}

export function createCourseCatalogId(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) {
    throw new Error("course catalog identity requires at least one schedule");
  }
  const canonical = schedules
    .map(canonicalSchedule)
    .sort((left, right) =>
      left.scheduleId < right.scheduleId
        ? -1
        : left.scheduleId > right.scheduleId
          ? 1
          : 0,
    );
  if (
    canonical.some(
      (schedule) =>
        !schedule.scheduleId ||
        !schedule.sectionId ||
        !schedule.courseId ||
        !Number.isInteger(schedule.weekday) ||
        !Number.isInteger(schedule.block) ||
        schedule.periods.some((period) => !Number.isInteger(period)) ||
        schedule.weeks.some((week) => !Number.isInteger(week)),
    )
  ) {
    throw new Error("course catalog identity contains an incomplete schedule");
  }
  const scheduleIds = canonical.map((schedule) => schedule.scheduleId);
  if (new Set(scheduleIds).size !== scheduleIds.length) {
    throw new Error("course catalog identity contains duplicate schedule IDs");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
  return `course-v1:${digest}`;
}
