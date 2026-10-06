export type AcademicCourseOption = { id: string; title: string };

/** Only identity and display fields are needed; no timetable or storage mutation. */
export type AcademicCourseOptionSchedule = {
  courseId: string;
  courseCode?: string;
  title: string;
};

function academicCourseCode(id: string): string | undefined {
  return id.match(/^academic:([^:\s]+):([^:\s]+)$/u)?.[1];
}

function displayTitle(...values: string[]): string {
  return values.find((value) => value.trim().length > 0) ?? "";
}

/**
 * Build assignment options in first-seen schedule order, once per course code.
 * The catalog is keyed by course code (ordinary catalog courseId); names never
 * establish identity. Missing catalog entries keep the real schedule title.
 *
 * An existing assignment ID is preserved verbatim. If its identity is known,
 * it replaces that course's default option ID, not the assignment itself. An
 * unrelated/inactive ID is appended, even when its title matches another course.
 * The empty ID belongs to the caller's "不关联课程" option and is not emitted.
 */
export function academicCourseOptions(
  activeSchedules: readonly AcademicCourseOptionSchedule[],
  courses: ReadonlyMap<string, Readonly<AcademicCourseOption>>,
  existingCourseId?: string,
): AcademicCourseOption[] {
  const resolved = activeSchedules.map((schedule) => {
    const explicit = schedule.courseCode?.trim();
    const encoded = academicCourseCode(schedule.courseId);
    // Conflicting codes cannot justify a catalog mapping; retain the raw ID.
    const conflicting = Boolean(explicit && encoded && explicit !== encoded);
    const code = conflicting
      ? undefined
      : explicit || encoded || (
        schedule.courseId.startsWith("academic:") ? undefined : schedule.courseId
      );
    const catalog = code ? courses.get(code) : undefined;
    const id = catalog?.id || code || schedule.courseId;
    return {
      key: code ? `code:${code}` : `id:${schedule.courseId}`,
      code,
      sourceId: schedule.courseId,
      id,
      title: displayTitle(catalog?.title ?? "", schedule.title, id),
    };
  });

  const existingCode = existingCourseId
    ? academicCourseCode(existingCourseId)
    : undefined;
  // Prefer an exact source reference before any explicit code-based match.
  const existingMatch = existingCourseId ? (
    resolved.find((course) => course.sourceId === existingCourseId) ??
    resolved.find((course) =>
      course.id === existingCourseId || course.code === existingCourseId ||
      (existingCode !== undefined && course.code === existingCode),
    )
  ) : undefined;

  const seenCourses = new Set<string>();
  const options = new Map<string, AcademicCourseOption>();
  for (const course of resolved) {
    if (seenCourses.has(course.key)) continue;
    seenCourses.add(course.key);
    const id = existingCourseId && course.key === existingMatch?.key
      ? existingCourseId
      : course.id;
    if (id && !options.has(id)) options.set(id, { id, title: course.title });
  }

  if (existingCourseId && !options.has(existingCourseId)) {
    const catalog = courses.get(existingCourseId) ?? (
      existingCode ? courses.get(existingCode) : undefined
    );
    options.set(existingCourseId, {
      id: existingCourseId,
      title: displayTitle(catalog?.title ?? "", existingCourseId),
    });
  }
  return [...options.values()];
}
