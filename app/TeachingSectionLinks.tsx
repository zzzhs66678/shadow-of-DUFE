"use client";

import { useEffect, useRef, useState } from "react";
import { isCourseCatalogId, teacherReviewLinksFromSchedulePayload } from "./teacher-record-link";
import { withCourseReturn } from "./discovery-navigation";

// Look up only sections the reader reaches, not every teaching class in a drawer.
export function TeachingSectionLinks({ catalogId, scheduleId, courseId, materialCount, hasTextbook, returnTo }: {
  catalogId: string;
  scheduleId: string;
  courseId: string;
  materialCount: number;
  hasTextbook: boolean;
  returnTo?: string;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const [result, setResult] = useState<{ key: string; links: ReturnType<typeof teacherReviewLinksFromSchedulePayload> } | null>(null);
  const key = `${catalogId}:${scheduleId}`;
  useEffect(() => {
    if (!isCourseCatalogId(catalogId) || !scheduleId || !container.current) return;
    const controller = new AbortController();
    let started = false;
    async function load() {
      if (started) return;
      started = true;
      const timeout = window.setTimeout(() => controller.abort(), 8000);
      try {
        const query = new URLSearchParams({ catalogId, scheduleId });
        const response = await fetch(`/api/teachers/by-schedule?${query}`, {
          signal: controller.signal, headers: { Accept: "application/json" },
        });
        if (!response.ok) return;
        const links = teacherReviewLinksFromSchedulePayload(await response.json());
        if (!controller.signal.aborted) setResult({ key, links });
      } catch { /* Missing or unavailable records must not become guessed links. */ }
      finally { window.clearTimeout(timeout); }
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load();
      }
    }, { rootMargin: "120px" });
    observer.observe(container.current);
    return () => { observer.disconnect(); controller.abort(); };
  }, [catalogId, scheduleId, key]);
  const reviews = result?.key === key ? result.links : [];
  return (
    <span className="teaching-section-links" ref={container}>
      {reviews.map((review) => <a key={review.href} href={withCourseReturn(review.href, returnTo)} className="teacher-record-link">
        {reviews.length > 1 ? `${review.name}的评价` : "学生评价"} · {review.count}
      </a>)}
      {materialCount > 0 ? <a className="teacher-record-link" href={withCourseReturn(`/materials?${new URLSearchParams({ course: courseId })}`, returnTo)}>学习资料 · {materialCount}</a>
        : hasTextbook ? <a className="teacher-record-link" href="#course-drawer-resources">教材</a> : null}
    </span>
  );
}
