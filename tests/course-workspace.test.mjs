import assert from "node:assert/strict";
import test from "node:test";
import { readCourseWorkspace, courseWorkspaceHref } from "../app/course-workspace.ts";

test("workspace defaults safely and rejects unknown tabs", () => {
  assert.equal(readCourseWorkspace("", "mine").tab, "mine");
  assert.equal(readCourseWorkspace("?tab=unknown", "catalog").tab, "catalog");
});

test("all four tabs round trip without leaking one search into another", () => {
  for (const tab of ["mine", "catalog", "teachers", "materials"]) {
    const state = readCourseWorkspace("", "catalog");
    Object.assign(state, {
      tab, query: "会计", teachers: { q: "李", college: "会计学院" },
      materials: { q: "教材", course: "001", teacher: "同名教师", type: "pdf", tag: "复习", term: "fall", year: "2026" },
    });
    const href = courseWorkspaceHref("https://staging.dufesh.cn/?v=release&view=home#course", state);
    const url = new URL(href, "https://staging.dufesh.cn");
    assert.equal(url.pathname, "/");
    assert.equal(url.searchParams.get("v"), "release");
    assert.equal(url.searchParams.get("view"), "catalog");
    assert.equal(url.hash, "#course");
    assert.deepEqual(readCourseWorkspace(url.search, "mine"), state);
  }
});

test("clearing filters removes only owned query parameters", () => {
  const href = courseWorkspaceHref("https://staging.dufesh.cn/?view=catalog&tab=materials&mq=old&tq=old&keep=1", readCourseWorkspace("", "teachers"));
  const url = new URL(href, "https://staging.dufesh.cn");
  assert.equal(url.searchParams.has("mq"), false);
  assert.equal(url.searchParams.has("tq"), false);
  assert.equal(url.searchParams.get("keep"), "1");
  assert.equal(url.searchParams.get("tab"), "teachers");
});
