import assert from "node:assert/strict";
import test from "node:test";
import { scoreMaterialSearch, matchesMaterialFilters } from "../app/materials/materials-search.ts";
import { getMaterialById, searchMaterials } from "../app/materials/materials-catalog.mjs";
import { POST } from "../app/api/materials/resolve/route.ts";

const material = (courseTitle, overrides = {}) => ({
  id: "11111111111111111111", name: "复习讲义.pdf", courseTitle,
  courseIds: ["61130173"], teachers: ["张老师"], colleges: ["会计学院"],
  tags: ["复习"], category: "课件", kind: "PDF", extension: ".pdf",
  description: "独立说明", terms: ["fall"], years: [1], ...overrides,
});

test("materials: 近代史 and full title find the same three stable material IDs", () => {
  const shortened = searchMaterials({ query: "近代史" });
  const full = searchMaterials({ query: "中国近现代史纲要" });
  assert.equal(shortened.total, 3);
  assert.deepEqual(shortened.items.map((item) => item.id).sort(), full.items.map((item) => item.id).sort());
  for (const item of shortened.items) {
    assert.deepEqual(item, getMaterialById(item.id));
    assert.equal(matchesMaterialFilters(item, { query: "近代史" }), true);
  }
});

test("materials reuse omitted-word/alias rules, multiword matching and literal priority", () => {
  for (const [title, query] of [["高级财务会计", "高财"], ["中国近现代史纲要", "近代史"], ["高等数学", "高数"], ["线性代数（Ａ）", "线代"]]) {
    assert.ok(scoreMaterialSearch(material(title), query) >= 0);
  }
  const item = material("高级财务会计");
  for (const query of ["高财 张老师", "财务 PDF", "张老师 高财 复习", "６１１３０１７３", "独立说明 fall"]) {
    assert.ok(scoreMaterialSearch(item, query) >= 0, query);
  }
  for (const query of ["高张", "财高", "61373", "高财 不存在"]) assert.equal(scoreMaterialSearch(item, query), -1, query);
  const exact = scoreMaterialSearch(material("财务"), "财务");
  const contiguous = scoreMaterialSearch(material("高级财务会计"), "财务");
  const omitted = scoreMaterialSearch(material("财税业务"), "财务");
  assert.ok(exact > contiguous && contiguous > omitted);
  assert.ok(scoreMaterialSearch(material("高财"), "高财") > scoreMaterialSearch(item, "高财"));
});

test("server and personal filtering agree, while exact course filters never use fuzzy identity", () => {
  const query = "近代史 刘笑丹";
  const result = searchMaterials({ query, teacher: "刘笑丹", type: "文档" });
  assert.equal(result.total, 2);
  assert.ok(result.items.every((item) => matchesMaterialFilters(item, { query, teacher: "刘笑丹", type: "文档" })));
  const item = material("高级财务会计");
  assert.equal(matchesMaterialFilters(item, { course: "高财" }), false);
  assert.equal(matchesMaterialFilters(item, { course: "61130173", term: "fall", year: "1", tag: "复习" }), true);
  assert.equal(matchesMaterialFilters(item, { course: "61130174" }), false);
  assert.equal(matchesMaterialFilters(item, { query: "高财", year: "2" }), false);
  const duplicate = material("高级财务会计", { id: "22222222222222222222", courseIds: ["ANOTHER"] });
  assert.equal(scoreMaterialSearch(item, "高财"), scoreMaterialSearch(duplicate, "高财"));
  assert.notEqual(item.id, duplicate.id);
});

test("saved material resolver reads current public catalog only and preserves missing IDs", async () => {
  const item = searchMaterials({ query: "近代史" }).items[0];
  const request = (body) => new Request("http://local.test/api/materials/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const response = await POST(request({ ids: [item.id, "00000000000000000000", item.id] }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.deepEqual((await response.json()).items, [
    { materialId: item.id, material: item }, { materialId: "00000000000000000000", material: null },
  ]);
  for (const body of [{ ids: ["../private"] }, { ids: [item.id], userId: "forged" }, { ids: [null] }, null]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal((await POST(request({ ids: Array(1100).fill(item.id) }))).status, 413);
});
