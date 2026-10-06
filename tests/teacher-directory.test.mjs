import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createTeacherStore } from "../services/auth-api/src/teacher-store.mjs";

test("college directory covers the whole visible catalog; exact filters and tied identities paginate stably", async () => {
  const db = new PGlite();
  try {
    const migrations = new URL("../ops/postgres/migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()) {
      await db.exec(await readFile(new URL(file, migrations), "utf8"));
    }
    const rows = [];
    async function add(name, college, status = "active") {
      const id = `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`;
      await db.query(`INSERT INTO teachers (id, display_name, normalized_name, college_name, normalized_college, identity_status)
        VALUES ($1, $2, $2, $3, $3, $4)`, [id, name, college, status]);
      rows.push({ id, name, college, status });
    }
    for (let index = 0; index < 65; index += 1) await add(index < 2 ? "同名教师" : `教师${String(index).padStart(2, "0")}`, "会计学院", index === 0 ? "pending" : "active");
    await add("同名教师", "会计学院分院");
    for (let index = 0; index < 35; index += 1) await add("同名教师", `索引学院${String(index).padStart(2, "0")}`);
    await add("不可见教师", "仅撤回学院", "retired");
    await add("不可见教师", "仅待消歧学院", "ambiguous");
    const store = createTeacherStore(db);
    const colleges = await store.listPublicTeacherColleges();
    assert.equal(colleges.length, 37, "college options are not truncated to the teacher page size");
    assert.equal(colleges.find((item) => item.key === "会计学院").teacherCount, 65);
    assert.equal(colleges.reduce((sum, item) => sum + item.teacherCount, 0), 101);
    assert.ok(!colleges.some((item) => item.name.startsWith("仅")), "nonpublic identities cannot create college options");
    assert.deepEqual(colleges.map((item) => item.key), colleges.map((item) => item.key).sort());
    const firstPage = await store.listPublicTeachers({ query: "", college: "", after: null, limit: 30 });
    assert.equal(new Set(firstPage.map((item) => item.collegeName)).size, 1);
    assert.ok(colleges.some((item) => item.name === "索引学院34"), "options include colleges absent from the first teacher page");

    async function allPages(query, college, limit) {
      let after = null;
      const result = [];
      for (let pageIndex = 0; pageIndex < 200; pageIndex += 1) {
        const page = await store.listPublicTeachers({ query, college, after, limit });
        result.push(...page);
        if (page.length < limit) return result;
        after = page.at(-1).cursor;
      }
      assert.fail("cursor did not advance");
    }
    const accounting = await allPages("", "会计学院", 7);
    assert.equal(accounting.length, 65);
    assert.equal(new Set(accounting.map((item) => item.id)).size, 65);
    assert.ok(accounting.every((item) => item.collegeName === "会计学院"));
    assert.deepEqual(await allPages("", "会计", 7), [], "college matching is exact, not prefix/substring");
    assert.deepEqual(await allPages("%", "", 7), [], "name search treats wildcard input literally");
    assert.equal((await allPages("同名教师", "", 1)).length, 38, "schoolwide search keeps identities from every college");
    const tied = await allPages("同名教师", "会计学院", 1);
    assert.deepEqual(tied.map((item) => item.id), rows.slice(0, 2).map((item) => item.id), "same-college same-name teachers remain separate UUIDs");
    const all = await allPages("", "", 13);
    const expected = rows.filter((row) => ["pending", "active"].includes(row.status)).sort((a, b) => {
      for (const key of ["college", "name", "id"]) {
        if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
      }
      return 0;
    });
    assert.deepEqual(all.map((item) => item.id), expected.map((item) => item.id));
  } finally {
    await db.close();
  }
});
