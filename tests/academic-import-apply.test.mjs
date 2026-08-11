import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  applyPrivateBundle,
  rollbackImportBatch,
} from "../scripts/academic-import-apply.mjs";

const digest = (character) => character.repeat(64);

async function createDatabase() {
  const database = new PGlite();
  await database.waitReady;
  const directory = path.resolve("ops/postgres/migrations");
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    await database.exec(await fs.readFile(path.join(directory, file), "utf8"));
  }
  return database;
}

function fixtureBundle() {
  return {
    schemaVersion: 1,
    mappingVersion: "fixture-v1",
    private: true,
    sources: {
      teacher: { filename: "teachers.xlsx", sha256: digest("a") },
      textbook: { filename: "textbooks.xlsx", sha256: digest("b") },
    },
    teachers: [
      {
        sourceLocator: "做在这个表!C2",
        externalTeacherKey: "同一学院同名教师甲",
        displayName: "同名教师",
        collegeName: "同一学院",
        sourceDigest: digest("c"),
      },
      {
        sourceLocator: "做在这个表!C3",
        externalTeacherKey: "同一学院同名教师乙",
        displayName: "同名教师",
        collegeName: "同一学院",
        sourceDigest: digest("d"),
      },
    ],
    reviewCandidates: [
      {
        sourceLocator: "做在这个表!D2",
        sourceRow: 2,
        sourceColumn: 4,
        externalTeacherKey: "同一学院同名教师甲",
        sanitizedBody: "这是一条已经脱敏的历史评价",
        originalBodySha256: digest("e"),
        normalizedBodySha256: digest("f"),
        riskFlags: ["time_sensitive_assessment_claim"],
      },
    ],
    textbooks: [
      {
        sourceLocator: "Sheet1!A2:Y2",
        sourceRow: 2,
        termKey: "fall",
        courseId: "C1",
        courseTitle: "测试课程",
        sectionNo: "01",
        teacherName: "同名教师",
        teacherCollege: "同一学院",
        externalTeacherKey: "同一学院同名教师甲",
        materialKind: "book",
        selectionStatus: "specified",
        position: 1,
        recordStatus: "current",
        materialSha256: digest("1"),
        title: "测试教材一",
        author: "作者",
        publisher: "出版社",
        publicationDate: "2026-08-09",
        publicationDateRaw: "20260809",
        edition: "1",
        printing: "1",
        isbn: "9781234567890",
        isbnStatus: "valid",
      },
      {
        sourceLocator: "Sheet1!A3:Y3",
        sourceRow: 3,
        termKey: "fall",
        courseId: "C1",
        courseTitle: "测试课程",
        sectionNo: "01",
        teacherName: "同名教师",
        teacherCollege: "同一学院",
        externalTeacherKey: "同一学院同名教师甲",
        materialKind: "book",
        selectionStatus: "specified",
        position: 2,
        recordStatus: "current",
        materialSha256: digest("2"),
        title: "测试教材二",
        author: "作者",
        publisher: "出版社",
        publicationDate: null,
        publicationDateRaw: null,
        edition: null,
        printing: null,
        isbn: null,
        isbnStatus: "missing",
      },
    ],
  };
}

function textbookRevision(bundle, { sourceDigest, materialDigest, title }) {
  const revision = structuredClone(bundle);
  revision.sources.textbook = {
    filename: `textbooks-${sourceDigest[0]}.xlsx`,
    sha256: sourceDigest,
  };
  revision.textbooks = [{
    ...revision.textbooks[0],
    materialSha256: materialDigest,
    title,
  }];
  return revision;
}

test("private bundle refuses unsanitized contact data before database access", async () => {
  const bundle = fixtureBundle();
  bundle.reviewCandidates[0].sanitizedBody = "微信: abcdef";
  await assert.rejects(
    applyPrivateBundle({}, bundle),
    /历史评价候选未完成脱敏/,
  );
});

test("private academic bundle applies idempotently and rolls back in dependency order", async () => {
  const database = await createDatabase();
  try {
    const bundle = fixtureBundle();
    const first = await applyPrivateBundle(database, bundle);
    assert.equal(first.teacherBatch.idempotent, false);
    assert.equal(first.textbookBatch.idempotent, false);

    const teachers = await database.query(
      "SELECT id FROM teachers WHERE normalized_name = '同名教师' ORDER BY id",
    );
    assert.equal(teachers.rows.length, 2);
    assert.notEqual(teachers.rows[0].id, teachers.rows[1].id);
    const candidates = await database.query(
      "SELECT moderation_status FROM teacher_review_candidates",
    );
    assert.deepEqual(candidates.rows.map((row) => row.moderation_status), ["pending"]);
    const textbooks = await database.query(
      "SELECT position, record_status FROM teaching_section_textbooks ORDER BY position",
    );
    assert.deepEqual(textbooks.rows, [
      { position: 1, record_status: "current" },
      { position: 2, record_status: "current" },
    ]);

    const repeated = await applyPrivateBundle(database, bundle);
    assert.equal(repeated.teacherBatch.idempotent, true);
    assert.equal(repeated.textbookBatch.idempotent, true);

    await assert.rejects(
      rollbackImportBatch(database, first.teacherBatch.batchId),
      /后续教材批次依赖本批教师/,
    );
    await rollbackImportBatch(database, first.textbookBatch.batchId);
    await rollbackImportBatch(database, first.teacherBatch.batchId);
    const states = await database.query(
      `SELECT
         (SELECT COUNT(*)::int FROM teaching_section_textbooks WHERE record_status = 'withdrawn') AS withdrawn_textbooks,
         (SELECT COUNT(*)::int FROM teachers WHERE identity_status = 'retired') AS retired_teachers,
         (SELECT COUNT(*)::int FROM teacher_review_candidates WHERE moderation_status = 'rolled_back') AS rolled_back_candidates,
         (SELECT COUNT(*)::int FROM data_import_mutations) AS mutation_events`,
    );
    assert.deepEqual(states.rows[0], {
      withdrawn_textbooks: 2,
      retired_teachers: 2,
      rolled_back_candidates: 1,
      mutation_events: 14,
    });

    const reapplied = await applyPrivateBundle(database, bundle);
    assert.equal(reapplied.teacherBatch.idempotent, false);
    assert.equal(reapplied.textbookBatch.idempotent, false);
    const restored = await database.query(
      `SELECT
         (SELECT COUNT(*)::int FROM teachers WHERE identity_status <> 'retired') AS visible_teachers,
         (SELECT COUNT(*)::int FROM teacher_source_identities WHERE mapping_status = 'current') AS current_mappings,
         (SELECT COUNT(*)::int FROM teaching_section_textbooks WHERE record_status = 'current') AS current_textbooks,
         (SELECT COUNT(*)::int FROM teacher_review_candidates WHERE moderation_status = 'pending') AS pending_candidates`,
    );
    assert.deepEqual(restored.rows[0], {
      visible_teachers: 2,
      current_mappings: 2,
      current_textbooks: 2,
      pending_candidates: 1,
    });
    const restoredTeacherIds = await database.query(
      "SELECT id FROM teachers WHERE normalized_name = '同名教师' ORDER BY id",
    );
    assert.deepEqual(restoredTeacherIds.rows, teachers.rows);

    await rollbackImportBatch(database, reapplied.textbookBatch.batchId);
    await rollbackImportBatch(database, reapplied.teacherBatch.batchId);
    const rerolledBack = await database.query(
      `SELECT
         (SELECT COUNT(*)::int FROM teachers WHERE identity_status <> 'retired') AS visible_teachers,
         (SELECT COUNT(*)::int FROM teacher_source_identities WHERE mapping_status = 'current') AS current_mappings,
         (SELECT COUNT(*)::int FROM teaching_section_textbooks WHERE record_status <> 'withdrawn') AS active_textbooks,
         (SELECT COUNT(*)::int FROM teacher_review_candidates WHERE moderation_status <> 'rolled_back') AS active_candidates`,
    );
    assert.deepEqual(rerolledBack.rows[0], {
      visible_teachers: 0,
      current_mappings: 0,
      active_textbooks: 0,
      active_candidates: 0,
    });
  } finally {
    await database.close();
  }
});

test("textbook slot keeps one active revision and permits A to B to A", async () => {
  const database = await createDatabase();
  try {
    const initial = textbookRevision(fixtureBundle(), {
      sourceDigest: digest("b"),
      materialDigest: digest("1"),
      title: "教材 A",
    });
    const revisionB = textbookRevision(initial, {
      sourceDigest: digest("3"),
      materialDigest: digest("3"),
      title: "教材 B",
    });
    const revisionA = textbookRevision(initial, {
      sourceDigest: digest("4"),
      materialDigest: digest("1"),
      title: "教材 A 再次采用",
    });

    await applyPrivateBundle(database, initial);
    await applyPrivateBundle(database, revisionB);
    await applyPrivateBundle(database, revisionA);

    const versions = await database.query(
      `SELECT material_sha256, record_status
       FROM teaching_section_textbooks
       WHERE term_key = 'fall' AND course_id = 'C1' AND section_no = '01'
         AND position = 1
       ORDER BY created_at, id`,
    );
    assert.equal(versions.rows.length, 3);
    assert.equal(
      versions.rows.filter((row) => ["current", "needs_review"].includes(row.record_status)).length,
      1,
    );
    assert.deepEqual(
      versions.rows.find((row) => row.record_status === "current"),
      { material_sha256: digest("1"), record_status: "current" },
    );
    assert.equal(
      versions.rows.filter((row) => row.record_status === "superseded").length,
      2,
    );

    const superseded = versions.rows.find((row) => row.record_status === "superseded");
    await assert.rejects(
      database.query(
        `UPDATE teaching_section_textbooks
         SET record_status = 'current'
         WHERE material_sha256 = $1 AND record_status = 'superseded'`,
        [superseded.material_sha256],
      ),
      /duplicate key|unique constraint/u,
    );
  } finally {
    await database.close();
  }
});

test("an existing source key cannot silently change teacher identity", async () => {
  const database = await createDatabase();
  try {
    const bundle = fixtureBundle();
    await applyPrivateBundle(database, bundle);

    const changed = structuredClone(bundle);
    changed.sources.teacher = {
      filename: "teachers-corrected.xlsx",
      sha256: digest("9"),
    };
    changed.teachers[0] = {
      ...changed.teachers[0],
      displayName: "被静默改名的教师",
      sourceDigest: digest("8"),
    };
    await assert.rejects(
      applyPrivateBundle(database, changed),
      /teacher_source_identity_conflict:同一学院同名教师甲/u,
    );

    const identity = await database.query(
      `SELECT teacher.display_name, source_identity.source_name_snapshot
       FROM teachers AS teacher
       INNER JOIN teacher_source_identities AS source_identity
         ON source_identity.teacher_id = teacher.id
       WHERE source_identity.external_teacher_key = $1`,
      [bundle.teachers[0].externalTeacherKey],
    );
    assert.deepEqual(identity.rows[0], {
      display_name: "同名教师",
      source_name_snapshot: "同名教师",
    });
  } finally {
    await database.close();
  }
});
