/** Structural subset of Schedule; legacy core records may omit precise periods. */
export type ScheduledMeeting = {
  courseId: string;
  term: string;
  weekday: number;
  id?: string;
  sectionId?: string;
  sourceRow?: string;
  courseCode?: string;
  sectionCode?: string;
  teacher?: string;
  periods?: readonly number[];
  weeks?: readonly number[];
  timeText?: string;
  block?: number;
};

type Identity = { course: string; section?: string };
type MeetingEvidence = Identity & { slot: string; teachers: string | null };

function text(value: string | undefined): string {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

function code(value: string | undefined): string | undefined {
  const normalized = text(value).toUpperCase();
  // Preserve leading zeroes: no evidence says course/section 01 equals 1.
  return /^[A-Z0-9][A-Z0-9._-]*$/u.test(normalized) ? normalized : undefined;
}

function identityOf(meeting: ScheduledMeeting): Identity | null {
  const courses = new Set<string>();
  const sections = new Set<string>();
  for (const [value, target] of [
    [meeting.courseCode, courses],
    [meeting.sectionCode, sections],
  ] as const) {
    if (!text(value)) continue;
    const parsed = code(value);
    if (!parsed) return null;
    target.add(parsed);
  }

  const courseId = text(meeting.courseId);
  const academic = courseId.match(/^academic:([^:]+):([^:]+)$/u);
  const source = text(meeting.sourceRow).match(/^([^:]+):([^:]+)$/u);
  if (!academic) {
    if (courseId.startsWith("academic:")) return null;
    const parsed = code(courseId);
    if (parsed) courses.add(parsed);
  }
  for (const pair of [academic, source]) {
    if (!pair) continue;
    const course = code(pair[1]);
    const section = code(pair[2]);
    if (!course || !section) return null;
    courses.add(course);
    sections.add(section);
  }

  // The final number is a source row/legacy counter, NOT the actual section.
  // Core only retains id; off-map venue IDs and -m2/-m3 meetings use the same grammar.
  for (const value of [meeting.sectionId, meeting.id]) {
    const catalog = text(value).match(
      /^(fall|spring)-([A-Za-z0-9]+)-([A-Za-z0-9]+)-\d+(?:-venue)?(?:-m[1-9]\d*)?$/u,
    );
    if (!catalog) continue;
    if (catalog[1] !== text(meeting.term)) return null;
    courses.add(catalog[2].toUpperCase());
    sections.add(catalog[3].toUpperCase());
  }
  if (courses.size !== 1 || sections.size > 1) return null;
  return { course: [...courses][0], section: [...sections][0] };
}

function numberSet(values: readonly number[] | undefined, maximum: number): string | null {
  if (!Array.isArray(values) || !values.length) return null;
  const copy = [...values];
  if (copy.some((value) => !Number.isInteger(value) || value < 1 || value > maximum)) {
    return null;
  }
  return [...new Set(copy)].sort((left, right) => left - right).join(",");
}

function periodsOf(meeting: ScheduledMeeting): string | null {
  if (meeting.periods !== undefined && meeting.periods?.length !== 0) {
    // Nonempty structured periods describe the CURRENT slot, even if timeText is stale.
    // Invalid structured data must not fall back to a possibly outdated label.
    return numberSet(meeting.periods, 14);
  }
  const value = text(meeting.timeText).replace(/[–—~至]/gu, "-");
  // Accept one exact range, optionally preceded by the catalog's week/day text.
  // Never extract just the last range out of a compound/ambiguous expression.
  const match = value.match(
    /^(?:第?[\d,、-]+周(?:单周|双周)?\s*\/?\s*)?(?:(?:星期|周)[一二三四五六日天]\s*\/?\s*)?第?\s*(\d{1,2})\s*(?:-\s*(\d{1,2}))?\s*节$/u,
  );
  // Bare block is deliberately insufficient: all four catalog blocks contain
  // multiple actual period sets (including single periods and cross-block spans).
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (start < 1 || end < start || end > 14) return null;
  const expectedBlock = start <= 2 ? 1 : start <= 4 ? 2 : start <= 7 ? 3 : 4;
  // A moved block plus an old label is not sufficient evidence for legacy periods.
  if (meeting.block !== undefined && meeting.block !== expectedBlock) return null;
  return numberSet(Array.from({ length: end - start + 1 }, (_, index) => start + index), 14);
}

function teachersOf(value: string | undefined): string | null {
  const normalized = text(value).toLowerCase();
  if (!normalized) return null;
  // Whitespace is NOT a delimiter: the catalog includes multi-word foreign names.
  // A Latin comma (e.g. "Cheng, I-Wei") is ambiguous; do not guess a teacher set.
  if (/[a-z]/iu.test(normalized) && normalized.includes(",")) return null;
  const teachers = normalized.split(/[、,;/|]+/u).map((name) =>
    name.trim().replace(/\*+$/u, "").trim().replace(/\s+/gu, " "),
  );
  if (teachers.some((name) => !name || /^(?:[-?]+|待定|未知|未安排|暂无|无|unknown|tba)$/u.test(name))) {
    return null;
  }
  return JSON.stringify([...new Set(teachers)].sort());
}

function evidenceOf(meeting: ScheduledMeeting): MeetingEvidence | null {
  const identity = identityOf(meeting);
  const term = text(meeting.term);
  const weeks = numberSet(meeting.weeks, 30);
  const periods = periodsOf(meeting);
  if (
    !identity || !term || weeks === null || periods === null ||
    !Number.isInteger(meeting.weekday) || meeting.weekday < 1 || meeting.weekday > 7
  ) return null;
  return {
    ...identity,
    slot: JSON.stringify([identity.course, term, meeting.weekday, periods, weeks]),
    teachers: teachersOf(meeting.teacher),
  };
}

function sameEvidence(left: MeetingEvidence, right: MeetingEvidence): boolean {
  if (left.slot !== right.slot) return false;
  if (left.section !== undefined && right.section !== undefined) {
    // Teacher fallback may fill missing identity, never override a known conflict.
    return left.section === right.section;
  }
  return left.teachers !== null && left.teachers === right.teachers;
}

/**
 * Strict meeting equality for both display reconciliation and add-course checks.
 * Names/locations/IDs alone never prove equality. Empty/unknown weeks never match.
 * term is compared exactly (no year/semester inference); pass the relevant term's data.
 */
export function isSameScheduledMeeting(left: ScheduledMeeting, right: ScheduledMeeting): boolean {
  const first = evidenceOf(left);
  const second = evidenceOf(right);
  return first !== null && second !== null && sameEvidence(first, second);
}

/**
 * Official records win only over proven manual duplicates, meeting by meeting.
 * Returns a fresh array retaining object references and order within each input.
 * Does not deduplicate either input internally or modify records/persistent storage.
 */
export function mergePersonalSchedules<T extends ScheduledMeeting>(official: T[], manual: T[]): T[] {
  const officialBySlot = new Map<string, MeetingEvidence[]>();
  for (const meeting of official) {
    const evidence = evidenceOf(meeting);
    if (!evidence) continue;
    const bucket = officialBySlot.get(evidence.slot) ?? [];
    bucket.push(evidence);
    officialBySlot.set(evidence.slot, bucket);
  }
  return [
    ...official,
    ...manual.filter((meeting) => {
      const evidence = evidenceOf(meeting);
      return !evidence || !officialBySlot.get(evidence.slot)?.some((item) => sameEvidence(item, evidence));
    }),
  ];
}
