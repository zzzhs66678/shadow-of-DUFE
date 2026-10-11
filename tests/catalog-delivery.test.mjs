import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { reconcileCatalogTeacherOrigins } from "../services/auth-api/src/catalog/teacher-origins.mjs";

test("API packaged baselines exactly match the public sources", async () => {
  for (const [kind, filename] of [["courses", "course-data.json"], ["materials", "resource-manifest.json"]]) {
    const compressed = await readFile(new URL(`../services/auth-api/catalog-baseline/${kind}.json.gz`, import.meta.url));
    const source = (await readFile(new URL(`../public/data/${filename}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    assert.equal(gunzipSync(compressed).toString("utf8"), source);
  }
});

test("only stable teaching identities carry proven teacher origins across publication", async () => {
  const meetings = ["room", "teacher", "section", "course", "classes", "sequence", "removed"].map(id => ({
    id, sectionId: "section-a", courseId: "course-a", teacher: "同名教师", classNames: "班一", courseSequence: "01",
  }));
  const before = { catalogId: "old", schedules: meetings };
  const after = { catalogId: "new", schedules: meetings.filter(m => m.id !== "removed").map(m => ({ ...m })) };
  Object.assign(after.schedules[0], { room: "102", weekday: 2, weeks: [9, 10] });
  after.schedules[1].teacher = "另一教师";
  after.schedules[2].sectionId = "other-section";
  after.schedules[3].courseId = "other-course";
  after.schedules[4].classNames = "班二";
  after.schedules[5].courseSequence = "02";
  let queried = false;
  const client = { async query(sql, params) {
    queried = true;
    assert.deepEqual(params, ["old", "new", ["room"]]);
    assert.match(sql, /record_status = 'current'/);
    assert.match(sql, /ON CONFLICT DO NOTHING/);
    return { rowCount: 1 };
  } };
  assert.equal(await reconcileCatalogTeacherOrigins(client, { before, after }), 1);
  assert.equal(queried, true);
  assert.equal(await reconcileCatalogTeacherOrigins({ query() { throw Error("must not query"); } }, { before, after: before }), 0);
});
