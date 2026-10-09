import assert from "node:assert/strict";
import test from "node:test";
import { scoreCourseSearch } from "../app/course-search.ts";

const score = (title, query) => scoreCourseSearch({ id: "61130173", title }, query);
test("abbreviations work without a list of every course nickname", () => {
  for (const [title, query] of [
    ["中国近现代史纲要", "近代史"], ["高级财务会计(n)", "高财"],
    ["财政学原理", "财原"], ["国际金融理论与实务", "国金实务"],
    ["数据库系统设计", "数据设计"], ["中级财务会计（A）", "中财"],
    ["毛泽东思想和中国特色社会主义理论体系概论", "毛概"],
  ]) assert.ok(score(title, query) >= 0, `${query} → ${title}`);
});
test("literal matches outrank omitted-word matches and codes are not fuzzy", () => {
  assert.ok(score("高级财务会计", "高财") < score("高财", "高财"));
  assert.ok(score("高级财务会计", "财务") > score("高级财务会计", "高财"));
  assert.equal(score("高级财务会计", "财高"), -1);
  assert.equal(score("高级财务会计", "61373"), -1);
  assert.equal(score("高级财务会计", "xyz"), -1);
  assert.ok(score("线性代数（Ａ）", "线代") >= 0);
});
test("tokens can narrow by teacher but abbreviation characters cannot cross fields", () => {
  const course = { id: "001", title: "高级财务会计", teachers: ["张老师"] };
  assert.ok(scoreCourseSearch(course, "财务 张老师") >= 0);
  assert.equal(scoreCourseSearch(course, "高张"), -1);
  assert.equal(scoreCourseSearch(course, ""), 0);
});
