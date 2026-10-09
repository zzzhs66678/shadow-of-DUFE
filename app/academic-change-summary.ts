import type { AcademicSnapshot, AcademicTrainingPlan, AcademicSection, AcademicExam, AcademicMeeting, AcademicTrainingPlanCourse } from "./personal-sync.ts";
import { compactNumberSet, knownNumberSet } from "./schedule-conflicts.ts";

/** Ephemeral UI evidence only. Never serialized into personal-sync or browser storage. */
export type AcademicImportBaseline = {
  owner: string;
  schoolAccount: string;
  snapshot: AcademicSnapshot;
  trainingPlan: AcademicTrainingPlan | null;
  warnings?: readonly string[];
};
export type AcademicChange = {
  area: "课程" | "考试" | "培养方案";
  kind: "新增" | "移除" | "变化";
  title: string;
  identity: string;
  fields: string[];
  before: string[];
  after: string[];
  uncertain?: boolean;
};
export type AcademicChangeSummary = { changes: AcademicChange[]; notices: string[]; scopeLabel: string };

const clean = (value: string | undefined) => (value ?? "").normalize("NFKC").trim();
const code = (value: string | undefined) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(clean(value)) ? clean(value).toUpperCase() : "";
const encode = (value: unknown) => JSON.stringify(value);
const numbers = (values: readonly number[], max: number) => knownNumberSet(values, max);
const sorted = (values: readonly string[]) => [...values].sort();
const days = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function meetingFacts(meeting: AcademicMeeting) {
  const periods = numbers(meeting.periods, 14);
  const weeks = numbers(meeting.weeks, 30);
  return {
    weekday: meeting.weekday, periods, weeks,
    // Unknown structure is not replaced by a guessed set. Preserve its raw label.
    unknownTime: periods ? "" : clean(meeting.timeText),
    unknownWeeks: weeks ? "" : clean(meeting.weekText),
    campus: clean(meeting.campus), building: clean(meeting.building), room: clean(meeting.room),
  };
}

export function academicMeetingLabel(meeting: AcademicMeeting): string {
  const periods = numbers(meeting.periods, 14);
  const weeks = numbers(meeting.weeks, 30);
  return [days[meeting.weekday] || "星期未明确",
    periods ? `第${compactNumberSet(periods)}节` : `节次未明确${meeting.timeText ? `（原文：${meeting.timeText}）` : ""}`,
    weeks ? `第${compactNumberSet(weeks)}周` : `有效周未明确${meeting.weekText ? `（原文：${meeting.weekText}）` : ""}`,
    [meeting.campus, meeting.building, meeting.room].filter(Boolean).join(" / ") || "地点未明确",
  ].join(" · ");
}

type Fields = Record<string, unknown>;
function sectionFields(section: AcademicSection): Fields {
  return {
    "名称": clean(section.courseName), "教师": sorted([...new Set(section.teachers.map(clean))]),
    "课程信息": [section.credits, section.property, section.category, section.assessmentType, section.studyMode, section.selectionStatus].map(clean),
    "时间 / 地点 / 有效周": sorted(section.meetings.map((meeting) => encode(meetingFacts(meeting)))),
  };
}
function examFields(exam: AcademicExam): Fields {
  return {
    "名称": clean(exam.courseName), "时间": [exam.date, exam.startTime, exam.endTime].map(clean),
    "地点": [exam.campus, exam.building, exam.room, exam.building && exam.room ? "" : exam.location].map(clean),
    "考试信息": [exam.examType, exam.seat, exam.examNumber, exam.status].map(clean),
  };
}
function planCourseFields(course: AcademicTrainingPlanCourse): Fields {
  return {
    "名称": clean(course.courseName), "类别 / 学分": [course.categoryCode, course.categoryName, course.attribute, course.credits],
    "修读状态": [course.completionStatus ?? "unknown", course.completedTerm ?? "", sorted(course.replacementCourseCodes.map(code))],
  };
}
const sectionKey = (item: { courseCode: string; sectionCode: string }) =>
  code(item.courseCode) && code(item.sectionCode) ? encode([code(item.courseCode), code(item.sectionCode)]) : "";
const identity = (item: { courseCode: string; sectionCode?: string }) =>
  `课程号 ${item.courseCode || "未明确"}${item.sectionCode ? ` · 课序号 ${item.sectionCode}` : ""}`;

/** Match only globally unique stable identities. Exact facts may cancel unchanged
 * duplicates, but eliminating one duplicate never makes another a safe rename match.
 */
function diffItems<T>(before: readonly T[], after: readonly T[], options: {
  area: AcademicChange["area"]; key: (item: T) => string; facts: (item: T) => Fields;
  title: (item: T) => string; identity: (item: T) => string; describe: (item: T) => string[];
}): AcademicChange[] {
  const output: AcademicChange[] = [];
  const usedBefore = new Set<number>();
  const usedAfter = new Set<number>();
  const beforeKeys = before.map(options.key);
  const afterKeys = after.map(options.key);
  const fingerprint = (item: T) => encode([options.key(item), options.identity(item), options.facts(item)]);
  const add = (kind: AcademicChange["kind"], old: T | undefined, next: T | undefined, uncertain = false) => {
    const item = next ?? old!;
    const fields = old !== undefined && next !== undefined
      ? Object.keys(options.facts(next)).filter((key) => encode(options.facts(old)[key]) !== encode(options.facts(next)[key])) : [];
    if (kind === "变化" && !fields.length) return;
    output.push({ area: options.area, kind, title: options.title(item), identity: options.identity(item), fields,
      before: old === undefined ? [] : options.describe(old), after: next === undefined ? [] : options.describe(next), uncertain });
  };
  before.forEach((item, index) => {
    const key = beforeKeys[index];
    const nextIndex = afterKeys.indexOf(key);
    if (!key || beforeKeys.filter((value) => value === key).length !== 1 || afterKeys.filter((value) => value === key).length !== 1) return;
    usedBefore.add(index);
    usedAfter.add(nextIndex);
    add("变化", item, after[nextIndex]);
  });
  before.forEach((item, index) => {
    if (usedBefore.has(index)) return;
    const nextIndex = after.findIndex((next, i) => !usedAfter.has(i) && fingerprint(item) === fingerprint(next));
    if (nextIndex >= 0) { usedBefore.add(index); usedAfter.add(nextIndex); }
  });
  before.forEach((item, index) => {
    if (!usedBefore.has(index)) add("移除", item, undefined, !beforeKeys[index] || afterKeys.includes(beforeKeys[index]) || beforeKeys.filter((key) => key === beforeKeys[index]).length > 1);
  });
  after.forEach((item, index) => {
    if (!usedAfter.has(index)) add("新增", undefined, item, !afterKeys[index] || beforeKeys.includes(afterKeys[index]) || afterKeys.filter((key) => key === afterKeys[index]).length > 1);
  });
  return output;
}

const examDescription = (exam: AcademicExam) => [
  exam.courseName,
  `${exam.examType || "考试类型未明确"} · ${exam.date || "日期未明确"} ${exam.startTime || "时间未明确"}${exam.endTime ? `–${exam.endTime}` : ""}`,
  [exam.campus, exam.building, exam.room].filter(Boolean).join(" / ") || exam.location || "地点未明确",
  `座位 ${exam.seat || "未明确"} · 考号 ${exam.examNumber || "未明确"} · ${exam.status || "状态未明确"}`,
];
const sectionDescription = (section: AcademicSection) => [
  section.courseName,
  `教师：${section.teachers.join("、") || "未明确"} · ${section.credits || "未明确"} 学分`,
  [section.property, section.category, section.assessmentType, section.studyMode, section.selectionStatus].filter(Boolean).join(" · "),
  ...(section.meetings.length ? section.meetings.map(academicMeetingLabel) : ["上课安排未明确"]),
].filter(Boolean);
const planDescription = (course: AcademicTrainingPlanCourse) => [
  course.courseName,
  `${course.categoryName || course.categoryCode || "类别未明确"} · ${course.credits ?? "未明确"} 学分 · ${{ required: "必修", limited: "限选", elective: "选修", unknown: "属性未明确" }[course.attribute]}`,
  `${({ passed: "已通过", in_progress: "修读中", failed: "未通过", not_taken: "未修读", unknown: "状态未明确" } as const)[course.completionStatus ?? "unknown"]} ${course.completedTerm ?? ""}`,
  ...(course.replacementCourseCodes.length ? [`替代课程号：${course.replacementCourseCodes.join("、")}`] : []),
];

export function sameAcademicImportScope(previous: AcademicImportBaseline | null, next: AcademicImportBaseline): boolean {
  return Boolean(previous && next.owner.trim() && next.schoolAccount.trim() && previous.owner === next.owner &&
    previous.schoolAccount === next.schoolAccount && previous.snapshot.id === next.snapshot.id &&
    previous.snapshot.academicYear === next.snapshot.academicYear && previous.snapshot.term === next.snapshot.term);
}

export function summarizeAcademicChanges(previous: AcademicImportBaseline | null, next: AcademicImportBaseline): AcademicChangeSummary | null {
  if (!previous || !sameAcademicImportScope(previous, next)) return null;
  const changes = diffItems(previous.snapshot.sections, next.snapshot.sections, {
    area: "课程", key: sectionKey, facts: sectionFields,
    title: (item) => item.courseName, identity, describe: sectionDescription,
  });
  const notices: string[] = [];
  const examsReadable = (baseline: AcademicImportBaseline) => !baseline.snapshot.examStatus && !baseline.warnings?.some((warning) => warning.startsWith("academic_exam_"));
  if (examsReadable(previous) && examsReadable(next)) {
    changes.push(...diffItems(previous.snapshot.exams, next.snapshot.exams, {
      area: "考试",
      // Exam IDs contain timing/venue. A course/section/type must instead be unique
      // in BOTH full snapshots; multiple same-type exams are explicitly unmatched.
      key: (item) => sectionKey(item) && clean(item.examType) ? encode([sectionKey(item), clean(item.examType)]) : "",
      facts: examFields, title: (item) => item.courseName, identity, describe: examDescription,
    }));
  } else notices.push("考试读取不完整，未比较考试变化；不代表考试取消。");
  const oldPlan = previous.trainingPlan;
  const plan = next.trainingPlan;
  if (!oldPlan || !plan || next.warnings?.some((warning) => warning.startsWith("academic_plan_")) || previous.warnings?.some((warning) => warning.startsWith("academic_plan_"))) {
    notices.push("培养方案读取不完整，未比较方案变化；不代表课程移除。");
  } else if (!plan.planNumber || oldPlan.planNumber !== plan.planNumber || oldPlan.majorCode !== plan.majorCode || oldPlan.cohortYear !== plan.cohortYear) {
    notices.push("培养方案范围不同，未将两份方案互相比较。");
  } else {
    changes.push(...diffItems(oldPlan.courses, plan.courses, {
      area: "培养方案", key: (item) => code(item.courseCode), facts: planCourseFields,
      title: (item) => item.courseName, identity, describe: planDescription,
    }));
  }
  return { changes, notices, scopeLabel: `${next.snapshot.academicYear} ${next.snapshot.termLabel}` };
}
