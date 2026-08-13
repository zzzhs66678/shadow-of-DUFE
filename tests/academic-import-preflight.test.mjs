import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeTeacherWorkbook,
  analyzeTextbookWorkbook,
  classifyIsbn,
  classifyReview,
  parsePublicationDate,
} from "../scripts/academic-import-preflight.mjs";

test("teacher preflight never merges same names across colleges", () => {
  const rows = [
    ["来源键", "学院", "教师", "评价1"],
    ["财政税务学院李晶", "财政税务学院", "李晶", "讲课清楚"],
    ["公共管理学院李晶", "公共管理学院", "李晶", "作业安排合理"],
  ];
  const report = analyzeTeacherWorkbook(rows);
  assert.equal(report.facts.teacherRows, 2);
  assert.deepEqual(report.facts.sameNameAcrossColleges, [
    { name: "李晶", colleges: ["公共管理学院", "财政税务学院"] },
  ]);
  const identities = report.results.filter((row) => row.importType === "teacher_identity");
  assert.equal(identities.length, 2);
  assert.ok(identities.every((row) => row.errorCodes.includes("teacher_name_cross_college")));
});

test("legacy review preflight redacts contact data and always requires moderation", () => {
  const review = classifyReview("微信: abcdef，期末闭卷", "张老师", []);
  assert.equal(review.sanitized.includes("abcdef"), false);
  assert.ok(review.riskFlags.includes("possible_personal_contact"));
  assert.ok(review.riskFlags.includes("time_sensitive_assessment_claim"));

  const report = analyzeTeacherWorkbook([
    ["来源键", "学院", "教师", "评价1"],
    ["统计学院张老师", "统计学院", "张老师", "微信: abcdef，期末闭卷"],
  ]);
  const candidate = report.results.find((row) => row.importType === "teacher_review_candidate");
  assert.equal(candidate.disposition, "warning");
  assert.ok(candidate.errorCodes.includes("legacy_review_requires_moderation"));
  assert.equal(report.bundle.reviewCandidates.length, 1);
  assert.equal(report.bundle.reviewCandidates[0].sanitizedBody.includes("abcdef"), false);
});

test("textbook preflight preserves placeholders and section-level variants", () => {
  assert.equal(classifyIsbn("9781112223301"), "placeholder");
  assert.equal(parsePublicationDate("25").status, "invalid");
  assert.equal(parsePublicationDate("20260809").date, "2026-08-09");

  const plan = [
    Array(14).fill(""),
    Array(14).fill(""),
    [1, "学院", "C1", "课程", "甲", "教材甲", "作者", "9781112223301", "出版社", "25"],
  ];
  const joinedHeader = Array(25).fill("");
  const joinedA = Array(25).fill("");
  joinedA[0] = "上学期";
  joinedA[5] = "学院";
  joinedA[6] = "课程";
  joinedA[7] = "C1";
  joinedA[8] = "01";
  joinedA[9] = "甲";
  joinedA[10] = "学院";
  joinedA[18] = "教材甲";
  const joinedB = [...joinedA];
  joinedB[8] = "02";
  joinedB[18] = "教材乙";
  const courseData = {
    courses: [{ id: "C1" }],
    schedules: [
      { term: "fall", courseId: "C1", sectionId: "fall-C1-01-1", teacher: "甲" },
      { term: "fall", courseId: "C1", sectionId: "fall-C1-02-2", teacher: "甲" },
    ],
  };
  const report = analyzeTextbookWorkbook(plan, [joinedHeader, joinedA, joinedB], courseData);
  assert.equal(report.facts.coursesWithMultipleTextbookVariants, 1);
  assert.equal(report.facts.placeholderIsbnRows, 1);
  assert.equal(report.facts.invalidPublicationDateRows, 1);
  const sectionRows = report.results.filter((row) => row.importType === "teaching_section_textbook");
  assert.ok(sectionRows.every((row) => row.errorCodes.includes("course_has_multiple_textbook_variants")));
  assert.equal(report.bundle.textbooks.length, 2);
  assert.equal(report.bundle.textbooks[0].termKey, "fall");
});

test("textbook preflight leaves same-college same-name identities unresolved", () => {
  const plan = [Array(14).fill(""), Array(14).fill("")];
  const header = Array(25).fill("");
  const joined = Array(25).fill("");
  joined[0] = "上学期";
  joined[5] = "课程学院";
  joined[6] = "测试课程";
  joined[7] = "C1";
  joined[8] = "01";
  joined[9] = "同名教师";
  joined[10] = "同一学院";
  joined[18] = "测试教材";
  const courseData = {
    courses: [{ id: "C1" }],
    schedules: [
      {
        term: "fall",
        courseId: "C1",
        sectionId: "fall-C1-01-1",
        teacher: "同名教师",
      },
    ],
  };
  const teacherRecords = [
    {
      collegeName: "同一学院",
      displayName: "同名教师",
      externalTeacherKey: "来源教师甲",
    },
    {
      collegeName: "同一学院",
      displayName: "同名教师",
      externalTeacherKey: "来源教师乙",
    },
  ];

  const report = analyzeTextbookWorkbook(
    plan,
    [header, joined],
    courseData,
    teacherRecords,
  );
  const result = report.results.find(
    (row) => row.importType === "teaching_section_textbook",
  );
  assert.equal(result.disposition, "warning");
  assert.ok(result.errorCodes.includes("teacher_source_identity_ambiguous"));
  assert.equal(report.bundle.textbooks[0].externalTeacherKey, null);
  assert.equal(report.bundle.textbooks[0].recordStatus, "needs_review");
});
