import assert from "node:assert/strict";
import test from "node:test";

import {
  getMaterialById,
  getMaterialFilters,
  materialCatalogMeta,
  searchMaterials,
} from "../app/materials/materials-catalog.mjs";

test("material catalog exposes every published manifest item as a material entity", () => {
  assert.equal(materialCatalogMeta.schemaVersion, 2);
  assert.equal(materialCatalogMeta.total, 457);
  const page = searchMaterials({ limit: 60 });
  assert.equal(page.items.length, 60);
  assert.equal(page.total, 457);
  assert.equal(page.hasMore, true);
  assert.ok(page.items.every((item) => item.id && item.downloadUrl));
  assert.ok(page.items.every((item) => !("searchText" in item)));
});

test("course, teacher, title, tag, type, term and year queries only return materials", () => {
  const byCourse = searchMaterials({ query: "Python网络数据抓取" });
  assert.ok(byCourse.total > 0);
  assert.ok(byCourse.items.every((item) => item.courseTitle === "Python网络数据抓取"));

  const teacher = getMaterialFilters().teachers[0];
  const byTeacher = searchMaterials({ teacher });
  assert.ok(byTeacher.total > 0);
  assert.ok(byTeacher.items.every((item) => item.teachers.includes(teacher)));

  const sample = byCourse.items[0];
  const byTitle = searchMaterials({ query: sample.name });
  assert.equal(byTitle.items[0].id, sample.id);
  assert.ok(searchMaterials({ tag: sample.tags[0] }).total > 0);
  assert.ok(searchMaterials({ type: sample.kind }).total > 0);
  assert.ok(searchMaterials({ term: sample.terms[0] }).total > 0);
  assert.ok(searchMaterials({ year: sample.years[0] }).total > 0);
});

test("material ids resolve independently and unknown ids do not fall through to courses", () => {
  const sample = searchMaterials({ query: "Python网络数据抓取", limit: 1 }).items[0];
  assert.deepEqual(getMaterialById(sample.id), sample);
  assert.equal(getMaterialById("missing-material"), null);
});

test("material search bounds pagination and ignores oversized input safely", () => {
  assert.equal(searchMaterials({ limit: 999 }).items.length, 60);
  assert.equal(searchMaterials({ limit: 0 }).items.length, 1);
  assert.equal(searchMaterials({ offset: -20 }).offset, 0);
  assert.equal(searchMaterials({ query: "x".repeat(1000) }).items.length, 0);
});
