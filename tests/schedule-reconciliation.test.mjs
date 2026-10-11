import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isSameScheduledMeeting,
  mergePersonalSchedules,
  authoritativeSchedules,
  scheduledMeetingsOverlap,
} from "../app/schedule-reconciliation.ts";

test("official timetable never silently includes planned courses; empty snapshots remain authoritative", () => {
  const enrolled = official();
  const preselected = catalog({ courseId: "UNSELECTED", id: "draft" });
  const manual = [preselected];
  assert.deepEqual(authoritativeSchedules([enrolled], manual), [enrolled]);
  assert.deepEqual(authoritativeSchedules([], manual), []);
  assert.deepEqual(authoritativeSchedules(undefined, manual), manual);
  assert.notEqual(authoritativeSchedules(undefined, manual), manual);
  assert.deepEqual(mergePersonalSchedules([enrolled], manual), [enrolled, preselected]);
  assert.deepEqual(manual, [preselected]);
});

test("conflicts use real period intersections and weeks, not only the display block", () => {
  assert.equal(scheduledMeetingsOverlap(catalog({ periods: [1, 2, 3, 4] }), catalog({ periods: [3, 4], block: 2 })), true);
  assert.equal(scheduledMeetingsOverlap(catalog({ periods: [1] }), catalog({ periods: [2] })), false);
  assert.equal(scheduledMeetingsOverlap(catalog({ weeks: [1, 2, 3] }), catalog({ weeks: [10, 11] })), false);
  assert.equal(scheduledMeetingsOverlap(catalog(), catalog({ weekday: 2 })), false);
  assert.equal(scheduledMeetingsOverlap(catalog(), catalog({ term: "spring" })), false);
});

function catalog(overrides = {}) {
  return {
    id: "fall-31040424-01-15",
    sectionId: "fall-31040424-01-16",
    meetingIndex: 1,
    sourceRow: "16",
    term: "fall",
    courseId: "31040424",
    title: "税收制度",
    teacher: "蔡楠",
    weekday: 1,
    block: 1,
    periods: [1, 2],
    weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    timeText: "1-9周 星期一 第1-2节",
    building: "之远楼",
    room: "103",
    classNames: "财政2401、财政2402、财政2403",
    ...overrides,
  };
}

// Mirrors schedulesFromAcademicSnapshot: no new optional metadata is required.
function official(overrides = {}) {
  return catalog({
    id: "academic-meeting:opaque-id",
    sectionId: "academic-section:opaque-id",
    meetingIndex: 0,
    sourceRow: "31040424:01",
    courseId: "academic:31040424:01",
    building: "校本部 · 之远楼(5#)",
    classNames: "01",
    origin: "academic",
    ...overrides,
  });
}

function legacy(overrides = {}) {
  return catalog({
    id: "old-record-without-section",
    sectionId: undefined,
    sourceRow: undefined,
    ...overrides,
  });
}

function assertSame(left, right, expected, message) {
  assert.equal(isSameScheduledMeeting(left, right), expected, message);
  assert.equal(isSameScheduledMeeting(right, left), expected, `symmetric: ${message}`);
  const result = mergePersonalSchedules([left], [right]);
  assert.equal(result.length, expected ? 1 : 2, message);
  assert.equal(result[0], left);
  if (!expected) assert.equal(result[1], right);
}

function freezeDeep(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test("official identity wins despite location spelling, title, and teacher display differences", () => {
  const imported = official({ title: "税收制度（教务）", teacher: "蔡楠 / 新教师", room: "(5＃)103" });
  const selected = catalog();
  assertSame(imported, selected, true, "location is not identity");
  assertSame(official({ teacher: "", building: "", room: "" }), selected, true, "known section needs no teacher fallback");
});

test("equal course titles never replace course identity", () => {
  assertSame(official(), legacy({ courseId: "99999999" }), false, "different course code");
  assertSame(legacy({ courseId: "" }), legacy({ courseId: "" }), false, "missing course code on both sides");
  assertSame(legacy({ courseId: "031040424" }), legacy(), false, "leading zeroes are significant");
});

test("different known teaching sections never use the teacher fallback", () => {
  assertSame(official(), catalog({
    id: "fall-31040424-02-15",
    sectionId: "fall-31040424-02-16",
  }), false, "same teacher, course and slot but different class");
  assertSame(legacy({ sectionCode: "01" }), legacy({ sectionCode: "1" }), false, "section code is not a numeric row index");
});

test("sourceRow recovers official course/section without treating catalog row numbers as sections", () => {
  assertSame(official({ courseId: "31040424" }), catalog(), true, "sourceRow code:section");
  assertSame(official({ courseId: "", teacher: "" }), catalog(), true, "sourceRow alone supplies identity");
  assertSame(legacy({ sourceRow: "01", teacher: "" }), official(), false, "plain source row proves nothing");
  assertSame(catalog({ sourceRow: "999" }), official(), true, "catalog source row is not a section code");
});

test("catalog IDs recover actual sections including legacy counters, venues and later meetings", () => {
  for (const id of [
    "fall-31040424-01-999",
    "fall-31040424-01-999-m2",
    "fall-31040424-01-999-venue",
    "fall-31040424-01-999-venue-m3",
  ]) {
    assertSame(official({ teacher: "" }), legacy({ id, teacher: "" }), true, id);
  }
  assertSame(official({ teacher: "" }), legacy({
    id: "unrecognized-id",
    sectionId: "fall-31040424-01-999",
    teacher: "",
  }), true, "sectionId has a different final counter from id");
  assertSame(official({ teacher: "" }), legacy({ id: "fall-31040424-01", teacher: "" }), false, "unproven ID grammar");
});

test("optional explicit codes work without encoded identities and normalize width/case only", () => {
  const left = legacy({ courseId: "", courseCode: " ｃ１ ", sectionCode: " ａ０１ ", teacher: "" });
  const right = legacy({ courseId: "C1", courseCode: "C1", sectionCode: "A01", teacher: "" });
  assertSame(left, right, true, "new typed metadata");
  assertSame(official({ courseCode: "31040424", sectionCode: "01" }), catalog(), true, "metadata on the official projection");
});

test("conflicting identity evidence fails closed rather than silently choosing a field", () => {
  for (const patch of [
    { courseCode: "99999999" },
    { sectionCode: "02" },
    { sourceRow: "31040424:02" },
    { sourceRow: "99999999:01" },
    { id: "fall-31040424-02-15" },
    { sectionId: "spring-31040424-01-16" },
    { courseId: "academic:31040424" },
  ]) {
    assertSame(official(patch), catalog(), false, JSON.stringify(patch));
  }
});

test("semester comparison is exact and never erases academic-year differences", () => {
  assertSame(official(), legacy({ term: "spring" }), false, "fall versus spring");
  assertSame(legacy({ term: "2026-2027-fall" }), legacy({ term: "2027-2028-fall" }), false, "different academic year");
  assertSame(legacy({ term: "2026-2027-fall" }), legacy({ term: "fall" }), false, "no inferred academic year");
  assertSame(legacy({ term: "" }), legacy({ term: "" }), false, "unknown semester");
});

test("weekday, exact periods and complete week sets all participate in current meeting equality", () => {
  for (const patch of [
    { weekday: 3 },
    { periods: [1] },
    { periods: [2] },
    { periods: [1, 2, 3, 4] },
    { weeks: Array.from({ length: 10 }, (_, i) => i + 9) },
    { weeks: Array.from({ length: 18 }, (_, i) => i + 1) },
    { weeks: [1, 3, 5, 7, 9] },
  ]) {
    // IDs and display text deliberately remain unchanged, as with a moved slot.
    assertSame(official(), catalog(patch), false, JSON.stringify(patch));
  }
  assertSame(official({ block: 3, periods: [5, 6, 7] }), catalog({ block: 3, periods: [5, 6] }), false, "same afternoon block is not equal periods");
  assertSame(official({ block: 4, periods: [8, 9, 10] }), catalog({ block: 4, periods: [8, 9] }), false, "same evening block is not equal periods");
});

test("set ordering and repetitions are irrelevant without mutating the source arrays", () => {
  const selected = freezeDeep(catalog({ periods: [2, 1, 2], weeks: [9, 8, 7, 6, 5, 4, 3, 2, 1, 1] }));
  assertSame(freezeDeep(official()), selected, true, "same mathematical sets");
  assert.deepEqual(selected.periods, [2, 1, 2]);
  assert.deepEqual(selected.weeks, [9, 8, 7, 6, 5, 4, 3, 2, 1, 1]);
});

test("unknown or malformed weeks never match, even when both records or IDs agree", () => {
  for (const weeks of [undefined, null, [], [0], [-1], [1.5], [31], [NaN], ["1"], [, 1]]) {
    assertSame(official(), catalog({ weeks }), false, String(weeks));
    const unknown = catalog({ weeks });
    assertSame(unknown, unknown, false, "identity and timeText cannot invent missing weeks");
  }
});

test("invalid structured periods and weekdays cannot be rescued by stale display text", () => {
  for (const periods of [null, [0], [-1], [1.5], [15], [NaN], ["1", "2"], [, 1]]) {
    assertSame(official(), catalog({ periods }), false, String(periods));
  }
  for (const weekday of [0, 8, 1.5, NaN, "1"]) {
    assertSame(catalog({ weekday }), catalog({ weekday }), false, String(weekday));
  }
});

test("missing section identity allows only the full normalized nonempty teacher set", () => {
  const imported = official({ teacher: "张三 / 李四" });
  for (const teacher of ["李四、张三", " 张三＊ ； 李四 ", "李四,张三,李四", "李四／张三"]) {
    assertSame(imported, legacy({ teacher }), true, teacher);
  }
  assertSame(legacy({ teacher: "李四 / 张三" }), legacy({ teacher: "张三、李四" }), true, "both sections unknown");
  for (const teacher of ["张三", "张三 / 王五", "张三 / 李四 / 王五", "张三李四"]) {
    assertSame(imported, legacy({ teacher }), false, teacher);
  }
});

test("missing teachers or placeholders are not evidence for the fallback", () => {
  for (const teacher of [undefined, "", "  ", "*", "待定", "未知", "--", "unknown", "张三 / 待定"]) {
    assertSame(legacy({ teacher }), legacy({ teacher }), false, String(teacher));
  }
  assertSame(official({ teacher: "蔡楠" }), legacy({ teacher: "" }), false, "one side unknown");
});

test("teacher normalization preserves foreign-name word boundaries and ambiguous punctuation", () => {
  assertSame(legacy({ teacher: "Charles  Harkness" }), legacy({ teacher: "charles Harkness" }), true, "cosmetic spacing and case");
  assertSame(legacy({ teacher: "John O Leary" }), legacy({ teacher: "John / O / Leary" }), false, "words are not separate teachers");
  assertSame(legacy({ teacher: "John O Leary" }), legacy({ teacher: "JohnOLeary" }), false, "do not concatenate names");
  assertSame(legacy({ teacher: "Cheng, I-Wei" }), legacy({ teacher: "I-Wei, Cheng" }), false, "comma may be part of a name");
});

test("teacher fallback does not relax course, semester, weekday, period or week equality", () => {
  for (const patch of [
    { courseId: "99999999" }, { term: "spring" }, { weekday: 2 },
    { periods: [1] }, { weeks: [1, 2] }, { weeks: [] },
  ]) assertSame(official(), legacy(patch), false, JSON.stringify(patch));
});

test("legacy core empty/missing periods recover only an exact single textual range", () => {
  for (const periods of [undefined, []]) {
    for (const timeText of [
      "1-9周 星期一 第1-2节", "第1–2节", "第１－２节", "第 1 - 2 节",
      "1-2节", "1-9周 / 星期一 / 1-2节",
    ]) {
      assertSame(official(), catalog({ periods, timeText }), true, timeText);
    }
  }
  assertSame(official({ periods: [3], block: 2 }), catalog({ periods: [], block: 2, timeText: "第3节" }), true, "single period");
  assertSame(official({ periods: [5, 6, 7] }), catalog({ periods: [], block: 3, timeText: "第5-6节" }), false, "range beats block envelope");
  assertSame(official(), catalog({ periods: [3, 4], timeText: "第1-2节" }), false, "structured current slot beats old label");
  assertSame(official(), catalog({ periods: [], block: 2 }), false, "changed block makes legacy timeText insufficient");
});

test("bare block, clock time, compound ranges and malformed text never guess periods", () => {
  for (const timeText of [
    "", "待定", "第一大节", "08:00–09:35", "第1、2节", "第1-2节,第3-4节",
    "第1,2节", "第1、 2节", "第2-1节", "第0-2节", "第1-15节", "第1-2节或第3节",
  ]) assertSame(official(), catalog({ periods: [], timeText }), false, timeText);
  for (const block of [1, 2, 3, 4, 99]) {
    const unknown = catalog({ block, periods: [], timeText: "" });
    assertSame(unknown, unknown, false, `block ${block} is not enough evidence`);
  }
});

test("merge filters per meeting and preserves unmatched meetings in a multi-meeting section", () => {
  const first = catalog();
  const second = catalog({ id: "fall-31040424-01-15-m2", weekday: 3, periods: [5, 6] });
  const imported = official();
  assert.deepEqual(mergePersonalSchedules([imported], [first, second]), [imported, second]);
  const secondImported = official({ id: "academic-second", weekday: 3, periods: [5, 6] });
  assert.deepEqual(mergePersonalSchedules([imported, secondImported], [first, second]), [imported, secondImported]);
});

test("merge is a pure stable projection, preserving metadata, references and duplicates within each source", () => {
  const imported = official({ customMetadata: { keep: true } });
  const selected = catalog();
  const unmatched = legacy({ courseId: "C2", customMetadata: { keep: "manual" } });
  const officialInput = freezeDeep([imported, imported]);
  const manualInput = freezeDeep([selected, unmatched, unmatched]);
  const before = JSON.stringify({ officialInput, manualInput });
  const result = mergePersonalSchedules(officialInput, manualInput);
  assert.deepEqual(result, [imported, imported, unmatched, unmatched]);
  assert.equal(result[0], imported);
  assert.equal(result[2], unmatched);
  assert.equal(JSON.stringify({ officialInput, manualInput }), before);
  assert.notEqual(result, officialInput);
  assert.notEqual(result, manualInput);
  assert.deepEqual(mergePersonalSchedules([], manualInput), manualInput);
  assert.notEqual(mergePersonalSchedules([], manualInput), manualInput);
  assert.deepEqual(mergePersonalSchedules(officialInput, []), officialInput);
  assert.deepEqual(mergePersonalSchedules([], []), []);
  // Removing the official snapshot reveals the unchanged old selections again.
  assert.equal(mergePersonalSchedules([], manualInput)[0], selected);
});

test("merge never propagates teacher fallback transitively between conflicting sections", () => {
  const section02 = catalog({ id: "fall-31040424-02-1", sectionId: "fall-31040424-02-2" });
  const unknown = legacy();
  const imported = official();
  assert.deepEqual(mergePersonalSchedules([imported], [unknown, section02]), [imported, section02]);
});

const full = JSON.parse(await readFile(new URL("../public/data/course-data.json", import.meta.url), "utf8"));
const core = JSON.parse(await readFile(new URL("../public/data/course-core.json", import.meta.url), "utf8"));

function projectOfficial(schedule) {
  const match = schedule.sectionId.match(/^(fall|spring)-([A-Za-z0-9]+)-([A-Za-z0-9]+)-\d+$/u);
  assert.ok(match, schedule.sectionId);
  return {
    ...schedule,
    id: `academic-meeting:${schedule.id}`,
    sectionId: `academic-section:${schedule.sectionId}`,
    courseId: `academic:${match[2]}:${match[3]}`,
    sourceRow: `${match[2]}:${match[3]}`,
    building: `校本部 · ${schedule.building}(5#)`,
    origin: "academic",
  };
}

test("every real catalog meeting reconciles with the existing official Schedule projection", () => {
  assert.ok(full.schedules.length > 5000);
  const projected = full.schedules.map(projectOfficial);
  for (const [index, schedule] of full.schedules.entries()) {
    assert.equal(isSameScheduledMeeting(projected[index], schedule), true, schedule.id);
  }
  const merged = mergePersonalSchedules(projected, full.schedules);
  assert.equal(merged.length, projected.length);
  assert.ok(merged.every((meeting, index) => meeting === projected[index]));
});

test("every real core meeting recovers its section and exact periods without full-index metadata", () => {
  const fullById = new Map(full.schedules.map((schedule) => [schedule.id, schedule]));
  assert.equal(core.schedules.length, full.schedules.length);
  for (const [id, term, courseIndex, teacherIndex, weekday, block, weeks, timeIndex] of core.schedules) {
    const inflated = {
      id,
      term: term === 0 ? "fall" : "spring",
      courseId: core.courseTitles[courseIndex][0],
      teacher: core.dictionaries.teachers[teacherIndex],
      weekday, block, weeks: weeks ?? [], periods: [],
      timeText: core.dictionaries.timeTexts[timeIndex],
    };
    assert.equal(isSameScheduledMeeting(projectOfficial(fullById.get(id)), inflated), true, id);
  }
});

test("real multi-meeting teaching section and off-map venues remain independent meetings", () => {
  const section = full.schedules.filter((schedule) => schedule.courseId === "31040424" && schedule.sectionId === "fall-31040424-01-16");
  assert.equal(section.length, 2);
  const imported = projectOfficial(section[0]);
  assert.deepEqual(mergePersonalSchedules([imported], section), [imported, section[1]]);
  const venue = full.schedules.find((schedule) => schedule.id.includes("-venue"));
  assert.ok(venue);
  assert.equal(isSameScheduledMeeting(projectOfficial(venue), { ...venue, sectionId: undefined }), true);
});
