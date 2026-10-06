import assert from "node:assert/strict";
import test from "node:test";
import { academicCourseOptions } from "../app/academic-course-options.ts";

function catalog(...entries) {
  return new Map(entries.map(([id, title]) => [id, { id, title }]));
}

function schedule(courseId, title, courseCode) {
  return { courseId, title, ...(courseCode === undefined ? {} : { courseCode }) };
}

test("explicit course codes and academic IDs resolve catalog titles once per course", () => {
  const courses = catalog(["C1", "目录课程一"], ["C2", "目录课程二"]);
  const active = [
    schedule("academic:C2:01", "导入课程二", "C2"),
    schedule("academic:C1:01", "导入课程一"),
    schedule("academic:C2:02", "导入课程二的另一个班"),
    schedule("C1", "目录时段"),
    schedule("legacy-C2", "旧时段", "C2"),
  ];
  assert.deepEqual(academicCourseOptions(active, courses), [
    { id: "C2", title: "目录课程二" },
    { id: "C1", title: "目录课程一" },
  ]);
});

test("an explicit code works without an academic prefix and preserves leading zeroes", () => {
  const courses = catalog(["001", "零开头"], ["1", "另一个课程号"]);
  assert.deepEqual(academicCourseOptions([
    schedule("opaque-a", "导入名称", " 001 "),
    schedule("academic:1:01", "导入名称"),
  ], courses), [
    { id: "001", title: "零开头" },
    { id: "1", title: "另一个课程号" },
  ]);
});

test("missing catalog courses retain real titles and stable course-level IDs", () => {
  const active = [
    schedule("academic:NEW:01", "学校新增课程"),
    schedule("academic:NEW:02", "同课另班"),
    schedule("legacy-other", "另一门学校课程", "OTHER"),
  ];
  assert.deepEqual(academicCourseOptions(active, new Map()), [
    { id: "NEW", title: "学校新增课程" },
    { id: "OTHER", title: "另一门学校课程" },
  ]);
});

test("equal titles never map to a different code or merge unrelated courses", () => {
  const courses = catalog(["CATALOG", "同名课程"]);
  assert.deepEqual(academicCourseOptions([
    schedule("academic:A:01", "同名课程"),
    schedule("academic:B:01", "同名课程"),
  ], courses), [
    { id: "A", title: "同名课程" },
    { id: "B", title: "同名课程" },
  ]);
});

test("ordinary catalog schedules continue to work and unknown IDs stay usable", () => {
  assert.deepEqual(academicCourseOptions([
    schedule("C1", "旧名称"),
    schedule("legacy:unknown", "真实旧课程名称"),
    schedule("legacy:unknown", "重复时段"),
  ], catalog(["C1", "目录课程"])), [
    { id: "C1", title: "目录课程" },
    { id: "legacy:unknown", title: "真实旧课程名称" },
  ]);
});

test("an existing academic ID replaces the canonical option without being rewritten", () => {
  const active = [
    schedule("academic:C1:01", "课程一"),
    schedule("academic:C1:02", "课程一"),
    schedule("academic:C2:01", "课程二"),
  ];
  const courses = catalog(["C1", "目录课程一"]);
  for (const existing of ["academic:C1:01", "academic:C1:02", "academic:C1:previous"]) {
    assert.deepEqual(academicCourseOptions(active, courses, existing), [
      { id: existing, title: "目录课程一" },
      { id: "C2", title: "课程二" },
    ]);
  }
});

test("an existing raw source ID with explicit identity is preserved once per course", () => {
  const existing = "legacy-custom-id";
  assert.deepEqual(academicCourseOptions([
    schedule("academic:C1:01", "课程一"),
    schedule(existing, "旧课程一", "C1"),
  ], catalog(["C1", "目录课程一"]), existing), [
    { id: existing, title: "目录课程一" },
  ]);
});

test("existing plain codes are not duplicated and need not occur in active schedules", () => {
  const courses = catalog(["C1", "课程一"], ["C2", "课程二"]);
  const active = [schedule("academic:C1:01", "导入课程一")];
  assert.deepEqual(academicCourseOptions(active, courses, "C1"), [
    { id: "C1", title: "课程一" },
  ]);
  assert.deepEqual(academicCourseOptions(active, courses, "C2"), [
    { id: "C1", title: "课程一" },
    { id: "C2", title: "课程二" },
  ]);
  assert.deepEqual(academicCourseOptions([], courses, "academic:C2:old"), [
    { id: "academic:C2:old", title: "课程二" },
  ]);
});

test("arbitrary existing IDs survive verbatim even without a catalog or active course", () => {
  for (const id of ["retired-course", "academic:missing:old", "academic:broken", " ID with spaces ", "0", "__proto__"]) {
    assert.deepEqual(academicCourseOptions([], new Map(), id), [{ id, title: id }]);
  }
  assert.deepEqual(academicCourseOptions([
    schedule("academic:NEW:01", "同名课程"),
  ], catalog(["OLD", "同名课程"]), "OLD"), [
    { id: "NEW", title: "同名课程" },
    { id: "OLD", title: "同名课程" },
  ]);
});

test("missing catalog entries preserve an existing section ID and its real title", () => {
  assert.deepEqual(academicCourseOptions([
    schedule("academic:NEW:01", "学校真实课程"),
    schedule("academic:NEW:02", "学校真实课程"),
  ], new Map(), "academic:NEW:99"), [
    { id: "academic:NEW:99", title: "学校真实课程" },
  ]);
});

test("malformed academic IDs do not guess a code but keep their source title", () => {
  const courses = catalog(["C1", "不可猜测的目录课程"]);
  for (const id of ["academic:C1", "academic:C1:", "academic::01", "academic:C1:01:extra"]) {
    assert.deepEqual(academicCourseOptions([schedule(id, "真实来源标题")], courses), [
      { id, title: "真实来源标题" },
    ]);
  }
});

test("conflicting explicit and encoded codes cannot assign either catalog identity", () => {
  const courses = catalog(["C1", "目录课程一"], ["C2", "目录课程二"]);
  const active = [schedule("academic:C1:01", "原始来源标题", "C2")];
  const expected = [{ id: "academic:C1:01", title: "原始来源标题" }];
  assert.deepEqual(academicCourseOptions(active, courses), expected);
  assert.deepEqual(academicCourseOptions(active, courses, "academic:C1:01"), expected);
});

test("empty input and unassociated assignments do not manufacture an option", () => {
  assert.deepEqual(academicCourseOptions([], new Map()), []);
  assert.deepEqual(academicCourseOptions([], new Map(), ""), []);
  assert.deepEqual(academicCourseOptions([schedule("", "没有身份")], new Map()), []);
  assert.deepEqual(academicCourseOptions([
    schedule("academic:C1:01", "真实课程"),
  ], catalog(["C1", "   "]), ""), [{ id: "C1", title: "真实课程" }]);
});

test("options are deterministic fresh objects and never mutate schedules or catalog", () => {
  const active = Object.freeze([
    Object.freeze(schedule("academic:C2:01", "导入二")),
    Object.freeze(schedule("C1", "导入一")),
    Object.freeze(schedule("academic:C2:02", "导入二")),
  ]);
  const courses = new Map([
    ["C1", Object.freeze({ id: "C1", title: "目录一" })],
    ["C2", Object.freeze({ id: "C2", title: "目录二" })],
  ]);
  const before = JSON.stringify([active, [...courses]]);
  const first = academicCourseOptions(active, courses, "past");
  const second = academicCourseOptions(active, courses, "past");
  assert.deepEqual(first, [
    { id: "C2", title: "目录二" },
    { id: "C1", title: "目录一" },
    { id: "past", title: "past" },
  ]);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  assert.notEqual(first[0], courses.get("C2"));
  first[0].title = "修改调用者拿到的选项";
  assert.equal(JSON.stringify([active, [...courses]]), before);
  assert.equal(second[0].title, "目录二");
});
