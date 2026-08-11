"use client";

import { useState, type MouseEvent } from "react";
import {
  isCourseCatalogId,
  resolveTeacherScheduleHref,
  teacherSearchHref,
} from "./teacher-record-link";

export function TeacherRecordLink({
  catalogId,
  scheduleId,
  teacherName,
  className,
}: {
  catalogId: string;
  scheduleId: string;
  teacherName: string;
  className?: string;
}) {
  const [resolving, setResolving] = useState(false);
  const fallbackHref = teacherSearchHref(teacherName);

  async function openTeacher(event: MouseEvent<HTMLAnchorElement>) {
    event.stopPropagation();
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !isCourseCatalogId(catalogId) ||
      !scheduleId
    ) {
      return;
    }
    event.preventDefault();
    if (resolving) return;
    setResolving(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4_000);
    try {
      const href = await resolveTeacherScheduleHref({
        catalogId,
        scheduleId,
        teacherName,
        fetcher: window.fetch.bind(window),
        signal: controller.signal,
      });
      window.location.assign(href);
    } catch {
      window.location.assign(fallbackHref);
    } finally {
      window.clearTimeout(timeout);
      setResolving(false);
    }
  }

  return (
    <a
      className={className}
      href={fallbackHref}
      onClick={(event) => void openTeacher(event)}
      aria-busy={resolving || undefined}
      data-resolving={resolving || undefined}
    >
      {teacherName}
    </a>
  );
}
