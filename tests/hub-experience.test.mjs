import assert from "node:assert/strict";
import test from "node:test";
import { calendarDraftChanged } from "../app/calendar-draft.ts";
import { scheduleConflictDetails, compactNumberSet, exactMeetingPeriods } from "../app/schedule-conflicts.ts";
import { summarizeAcademicChanges, academicMeetingLabel } from "../app/academic-change-summary.ts";
import { baseline, snapshot, section, meeting, exam, trainingPlan, planCourse } from "./fixtures/hub-experience.mjs";

const schedule = (patch = {}) => ({ ...meeting(), id: "catalog-1", term: "fall", courseId: "C01", title: "同名课程", teacher: "甲", ...patch });
const compare = (next, previous = baseline()) => summarizeAcademicChanges(previous, baseline(next));
const deepFreeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

test("draft pristine / erased / whitespace-only content does not interrupt closing", () => {
  const start = { title: "", notes: "", date: "2026-10-09", color: "red" };
  assert.equal(calendarDraftChanged(start, { ...start }), false);
  assert.equal(calendarDraftChanged(start, { ...start, title: "  ", notes: "\n" }), false);
  assert.equal(calendarDraftChanged(start, { ...start, notes: "备注" }), true);
  assert.equal(calendarDraftChanged(start, { ...start, date: "2026-10-10" }), true);
  assert.equal(calendarDraftChanged({ title: "已保存" }, { title: "" }), true);
});
for (const field of ["title", "notes", "startTime", "endTime", "eventDate", "repeat", "location", "color", "courseId", "dueDate"]) {
  test(`draft detects and reverses changes to ${field}`, () => {
    const initial = { [field]: "original" };
    assert.equal(calendarDraftChanged(initial, { [field]: "changed" }), true);
    assert.equal(calendarDraftChanged(initial, { ...initial }), false);
  });
}
test("conflict intersection of 1-9 and 9-18 is only week 9; exact periods override blocks", () => {
  const conflicts = scheduleConflictDetails([schedule({ periods: [1, 2, 3, 4] })], [schedule({ id: "active", courseId: "C02", periods: [3, 4], block: 2, weeks: Array.from({ length: 10 }, (_, i) => i + 9) })]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].weeks, [9]);
  assert.deepEqual(conflicts[0].periods, [3, 4]);
});
test("conflicts retain every pair in multi-meeting teaching sections and source objects", () => {
  const candidate = [schedule(), schedule({ id: "second", weekday: 3 })];
  const active = [schedule({ id: "a", courseId: "C02", origin: "academic" }), schedule({ id: "b", weekday: 3, courseId: "C03" }), schedule({ id: "c", weekday: 3, courseId: "C04" })];
  const before = JSON.stringify({ candidate, active });
  const conflicts = scheduleConflictDetails(deepFreeze(candidate), deepFreeze(active));
  assert.equal(conflicts.length, 3);
  assert.equal(conflicts[0].active, active[0]);
  assert.equal(conflicts[2].meeting, candidate[1]);
  assert.equal(JSON.stringify({ candidate, active }), before);
});
test("unknown weeks/periods remain null and conservative, never an invented block envelope", () => {
  const conflicts = scheduleConflictDetails([schedule({ periods: [], timeText: "待定", weeks: [] })], [schedule({ id: "other", courseId: "C02" })]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].weeks, null);
  assert.equal(conflicts[0].periods, null);
  assert.equal(scheduleConflictDetails([schedule({ weeks: [0] })], [schedule({ id: "other", courseId: "C02" })])[0].weeks, null);
});
test("exact legacy period recovery shares the existing predicate; malformed inputs never invent precision", () => {
  assert.deepEqual(exactMeetingPeriods(schedule({ periods: [], timeText: "1-9周 / 星期一 / 第1-2节" })), [1, 2]);
  for (const text of ["第一大节", "第1、2节", "第1-2节,第3-4节", ""]) assert.equal(exactMeetingPeriods(schedule({ periods: [], timeText: text })), null);
  assert.equal(exactMeetingPeriods(schedule({ periods: [0], timeText: "第1-2节" })), null);
});
test("different weeks/periods/days/terms and proven same meeting do not report conflict", () => {
  for (const patch of [{ weeks: [10, 11] }, { periods: [3, 4] }, { weekday: 2 }, { term: "spring" }]) {
    assert.deepEqual(scheduleConflictDetails([schedule()], [schedule({ id: "other", courseId: "C02", ...patch })]), []);
  }
  assert.deepEqual(scheduleConflictDetails([schedule()], [schedule()]), []);
  assert.deepEqual(scheduleConflictDetails([schedule()], [schedule({ id: "different-id" })]), []);
  assert.equal(compactNumberSet([9, 1, 2, 5, 5, 7]), "1-2、5、7、9");
});
test("first import and different owners/school accounts/snapshot scopes never compare", () => {
  assert.equal(summarizeAcademicChanges(null, baseline()), null);
  for (const patch of [{ owner: "other" }, { schoolAccount: "other" }, { schoolAccount: "" }, { schoolAccount: "  " }, { snapshot: snapshot({ id: "other" }) }, { snapshot: snapshot({ term: "spring" }) }, { snapshot: snapshot({ academicYear: "2027-2028" }) }]) {
    assert.equal(compare(patch), null);
  }
});
test("timestamps, volatile IDs, order, duplicated set elements and structured display labels are not changes", () => {
  const result = compare({ snapshot: snapshot({ importedAt: "later", sections: [section({ id: "new", meetings: [meeting({ id: "new", periods: [2, 1, 2], weeks: [9, 8, 7, 6, 5, 4, 3, 2, 1], timeText: "new label", weekText: "new label" })] })], exams: [exam({ id: "new-exam" })] }), trainingPlan: trainingPlan({ importedAt: "later" }) });
  assert.deepEqual(result.changes, []);
});
test("unique stable section detects time / room / effective week changes retaining all meetings", () => {
  const old = baseline({ snapshot: snapshot({ sections: [section({ meetings: [meeting(), meeting({ id: "m2", weekday: 3 })] })] }) });
  const result = compare({ snapshot: snapshot({ sections: [section({ meetings: [meeting({ id: "m-new", weekday: 2, room: "202", weeks: [9, 10] }), meeting({ id: "m2", weekday: 3 })] })] }) }, old);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, "变化");
  assert.match(result.changes[0].before.join("\n"), /第1-9周/);
  assert.match(result.changes[0].before.join("\n"), /周三/);
  assert.match(result.changes[0].after.join("\n"), /周二.*第9-10周.*202/);
});
test("multiple changed meetings are shown as complete before/after sets without guessed pairs", () => {
  const old = baseline({ snapshot: snapshot({ sections: [section({ meetings: [meeting(), meeting({ weekday: 3 })] })] }) });
  const result = compare({ snapshot: snapshot({ sections: [section({ meetings: [meeting({ weekday: 2 }), meeting({ weekday: 4 })] })] }) }, old);
  assert.equal(result.changes.length, 1);
  assert.match(result.changes[0].before.join("\n"), /周一[\s\S]*周三/);
  assert.match(result.changes[0].after.join("\n"), /周二[\s\S]*周四/);
});
test("same name is not identity and leading-zero course/section codes stay distinct", () => {
  for (const patch of [{ courseCode: "OTHER" }, { sectionCode: "1" }, { courseCode: "0C01" }]) {
    const changes = compare({ snapshot: snapshot({ sections: [section(patch)] }) }).changes;
    assert.deepEqual(changes.map((change) => change.kind), ["移除", "新增"]);
  }
});
test("missing section identity or ambiguous duplicate sections are explicitly unmatched", () => {
  const old = baseline({ snapshot: snapshot({ sections: [section({ sectionCode: "" })] }) });
  const changed = compare({ snapshot: snapshot({ sections: [section({ sectionCode: "", meetings: [meeting({ room: "202" })] })] }) }, old).changes;
  assert.equal(changed.length, 2);
  assert.ok(changed.every((change) => change.uncertain));
  const duplicated = baseline({ snapshot: snapshot({ sections: [section(), section({ meetings: [meeting({ weekday: 3 })] })] }) });
  const result = compare({ snapshot: snapshot({ sections: [section(), section({ meetings: [meeting({ weekday: 4 })] })] }) }, duplicated);
  assert.deepEqual(result.changes.map((change) => change.kind), ["移除", "新增"]);
  assert.ok(result.changes.every((change) => change.uncertain));
});
test("exam ID containing date and venue does not turn a unique exam move into cancellation", () => {
  const changes = compare({ snapshot: snapshot({ exams: [exam({ id: "new-time-new-place", date: "2027-01-09", room: "302", location: "校本部 / 梅园 / 302" })] }) }).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "变化");
  assert.deepEqual(changes[0].fields, ["时间", "地点"]);
});
test("cosmetic exam location label and duplicate teacher names do not invent an update", () => {
  assert.deepEqual(compare({ snapshot: snapshot({ exams: [exam({ location: "校本部·梅园201" })], sections: [section({ teachers: ["测试教师", "测试教师"] })] }) }).changes, []);
});
test("multiple same-type exams do not become uniquely matchable after an unchanged exam is removed", () => {
  const old = baseline({ snapshot: snapshot({ exams: [exam(), exam({ date: "2027-01-10" })] }) });
  const changes = compare({ snapshot: snapshot({ exams: [exam(), exam({ date: "2027-01-11" })] }) }, old).changes;
  assert.deepEqual(changes.map((change) => change.kind), ["移除", "新增"]);
  assert.ok(changes.every((change) => change.uncertain));
});
test("missing exam type/code never uses title or volatile id as a rename key", () => {
  for (const patch of [{ courseCode: "" }, { sectionCode: "" }, { examType: "" }]) {
    const old = baseline({ snapshot: snapshot({ exams: [exam(patch)] }) });
    const changes = compare({ snapshot: snapshot({ exams: [exam({ ...patch, date: "2027-01-09" })] }) }, old).changes;
    assert.deepEqual(changes.map((change) => change.kind), ["移除", "新增"]);
    assert.ok(changes.every((change) => change.uncertain));
  }
});
test("empty successful reads report removals; unavailable/stale/warned exam reads never do", () => {
  assert.equal(compare({ snapshot: snapshot({ exams: [] }) }).changes[0].kind, "移除");
  for (const patch of [{ snapshot: snapshot({ exams: [], examStatus: "unavailable" }) }, { snapshot: snapshot({ exams: [], examStatus: "stale" }) }, { snapshot: snapshot({ exams: [] }), warnings: ["academic_exam_format_changed"] }]) {
    const result = compare(patch);
    assert.deepEqual(result.changes, []);
    assert.match(result.notices.join("\n"), /不代表考试取消/);
  }
  const priorFailed = baseline({ snapshot: snapshot({ exams: [], examStatus: "unavailable" }) });
  assert.deepEqual(compare({}, priorFailed).changes, []);
});
test("failed/missing/different-scope training plans are never cancellations", () => {
  for (const patch of [{ trainingPlan: null }, { trainingPlan: trainingPlan({ courses: [] }), warnings: ["academic_plan_unavailable"] }, { trainingPlan: trainingPlan({ planNumber: "other", courses: [] }) }]) {
    assert.deepEqual(compare(patch).changes, []);
  }
  assert.equal(compare({ trainingPlan: trainingPlan({ courses: [] }) }).changes[0].kind, "移除");
  assert.equal(compare({ trainingPlan: trainingPlan({ courses: [planCourse({ credits: 3 })] }) }).changes[0].kind, "变化");
});
test("unchanged duplicate records cancel without guessing and functions are immutable", () => {
  const prior = deepFreeze(baseline({ snapshot: snapshot({ sections: [section(), section()] }) }));
  const next = deepFreeze(baseline({ snapshot: snapshot({ sections: [section(), section()] }) }));
  const source = JSON.stringify([prior, next]);
  assert.deepEqual(summarizeAcademicChanges(prior, next).changes, []);
  assert.equal(JSON.stringify([prior, next]), source);
});
test("unknown week/period labels remain explicitly unknown in academic diff display", () => {
  const label = academicMeetingLabel(meeting({ periods: [], weeks: [], timeText: "待定", weekText: "另行通知" }));
  assert.match(label, /节次未明确.*有效周未明确/);
  assert.doesNotMatch(label, /第1-18周/);
});
