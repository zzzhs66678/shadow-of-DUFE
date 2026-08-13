import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TEACHER_SOURCE_SYSTEM = "dufe_teacher_review_workbook";
const UNSANITIZED_CONTACT = /(?:1[3-9]\d{9}|(?:qq|QQ|微信|vx|手机号|电话)\s*[:：]?\s*[A-Za-z0-9_-]{5,})/;
const STABLE_COURSE_KEY = /^[A-Za-z0-9:_-]+$/u;
const COURSE_SECTION_KEYS = [
  "catalogId",
  "externalTeacherKeys",
  "scheduleId",
  "sourceLocator",
];

function assertDigest(value, label) {
  if (!/^[0-9a-f]{64}$/.test(String(value ?? ""))) {
    throw new Error(`${label} 不是 64 位小写 SHA-256`);
  }
}

function assertPrivateBundle(bundle) {
  if (!bundle || bundle.private !== true || bundle.schemaVersion !== 1) {
    throw new Error("仅接受 schemaVersion=1 的私有导入包");
  }
  if (!bundle.mappingVersion || typeof bundle.mappingVersion !== "string") {
    throw new Error("导入包缺少 mappingVersion");
  }
  assertDigest(bundle.sources?.teacher?.sha256, "教师源文件摘要");
  assertDigest(bundle.sources?.textbook?.sha256, "教材源文件摘要");
  for (const key of ["teachers", "reviewCandidates", "textbooks"]) {
    if (!Array.isArray(bundle[key])) throw new Error(`导入包缺少数组：${key}`);
  }
  if (
    bundle.teachers.length > 10_000 ||
    bundle.reviewCandidates.length > 50_000 ||
    bundle.textbooks.length > 100_000 ||
    (bundle.courseSections?.length ?? 0) > 100_000
  ) {
    throw new Error("导入包记录数超过安全上限");
  }
  for (const candidate of bundle.reviewCandidates) {
    if (
      typeof candidate.sanitizedBody !== "string" ||
      candidate.sanitizedBody.length < 1 ||
      candidate.sanitizedBody.length > 3000 ||
      UNSANITIZED_CONTACT.test(candidate.sanitizedBody)
    ) {
      throw new Error(`历史评价候选未完成脱敏：${candidate.sourceLocator ?? "unknown"}`);
    }
    assertDigest(candidate.originalBodySha256, "评价原文摘要");
    assertDigest(candidate.normalizedBodySha256, "评价规范化摘要");
  }
  if (bundle.courseSections !== undefined && !Array.isArray(bundle.courseSections)) {
    throw new Error("导入包 courseSections 必须是数组");
  }
  if (bundle.courseSections?.length || bundle.sources?.courseSections) {
    assertDigest(bundle.sources?.courseSections?.sha256, "课程教师覆盖源文件摘要");
  }
  const scopes = new Set();
  const locators = new Set();
  for (const [index, section] of (bundle.courseSections ?? []).entries()) {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new Error(`courseSections[${index}] 必须是对象`);
    }
    const keys = Object.keys(section).sort();
    if (keys.join("|") !== COURSE_SECTION_KEYS.join("|")) {
      throw new Error(`courseSections[${index}] 含未授权字段或缺少字段`);
    }
    if (
      typeof section.catalogId !== "string" ||
      section.catalogId.length < 1 ||
      section.catalogId.length > 80 ||
      !STABLE_COURSE_KEY.test(section.catalogId)
    ) {
      throw new Error(`courseSections[${index}].catalogId 无效`);
    }
    if (
      typeof section.scheduleId !== "string" ||
      section.scheduleId.length < 1 ||
      section.scheduleId.length > 160 ||
      !STABLE_COURSE_KEY.test(section.scheduleId)
    ) {
      throw new Error(`courseSections[${index}].scheduleId 无效`);
    }
    if (
      typeof section.sourceLocator !== "string" ||
      section.sourceLocator.length < 3 ||
      section.sourceLocator.length > 180
    ) {
      throw new Error(`courseSections[${index}].sourceLocator 无效`);
    }
    parseLocator(section.sourceLocator, "courseSections");
    if (
      !Array.isArray(section.externalTeacherKeys) ||
      section.externalTeacherKeys.length > 20 ||
      section.externalTeacherKeys.some(
        (key) => typeof key !== "string" || key.length < 1 || key.length > 500 || key !== key.trim(),
      ) ||
      new Set(section.externalTeacherKeys).size !== section.externalTeacherKeys.length
    ) {
      throw new Error(`courseSections[${index}].externalTeacherKeys 无效`);
    }
    const scope = courseScheduleScopeKey(section);
    if (scopes.has(scope)) throw new Error(`courseSections 存在重复日程：${section.scheduleId}`);
    if (locators.has(section.sourceLocator)) {
      throw new Error(`courseSections 存在重复源定位：${section.sourceLocator}`);
    }
    scopes.add(scope);
    locators.add(section.sourceLocator);
  }
}

export function parseCourseCatalog(courseCatalog) {
  if (!courseCatalog || typeof courseCatalog !== "object" || Array.isArray(courseCatalog)) {
    throw new Error("课程目录必须是对象");
  }
  if (
    typeof courseCatalog.catalogId !== "string" ||
    courseCatalog.catalogId.length < 1 ||
    courseCatalog.catalogId.length > 80 ||
    !STABLE_COURSE_KEY.test(courseCatalog.catalogId)
  ) {
    throw new Error("课程目录缺少有效的 catalogId");
  }
  if (!Array.isArray(courseCatalog.schedules) || courseCatalog.schedules.length > 100_000) {
    throw new Error("课程目录 schedules 无效或超过安全上限");
  }

  const scheduleIds = new Set();
  for (const [index, schedule] of courseCatalog.schedules.entries()) {
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
      throw new Error(`课程目录 schedules[${index}] 必须是对象`);
    }
    if (
      typeof schedule.id !== "string" ||
      schedule.id.length < 1 ||
      schedule.id.length > 160 ||
      !STABLE_COURSE_KEY.test(schedule.id)
    ) {
      throw new Error(`课程目录 schedules[${index}].id 无效`);
    }
    if (scheduleIds.has(schedule.id)) {
      throw new Error(`课程目录存在重复 scheduleId：${schedule.id}`);
    }
    scheduleIds.add(schedule.id);
  }
  return { catalogId: courseCatalog.catalogId, scheduleIds };
}

function assertCourseSectionsExist(bundle, courseCatalog) {
  if (!(bundle.courseSections?.length > 0)) return;
  if (!courseCatalog) {
    throw new Error("非空 courseSections 必须提供带 catalogId 的课程目录");
  }
  const parsedCatalog = parseCourseCatalog(courseCatalog);
  for (const section of bundle.courseSections) {
    if (section.catalogId !== parsedCatalog.catalogId) {
      throw new Error(
        `courseSections catalogId 与课程目录不一致：${section.catalogId} != ${parsedCatalog.catalogId}`,
      );
    }
    if (!parsedCatalog.scheduleIds.has(section.scheduleId)) {
      throw new Error(`课程目录中不存在 scheduleId：${section.scheduleId}`);
    }
  }
}

async function withTransaction(database, callback) {
  const client = typeof database.connect === "function" ? await database.connect() : database;
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (client !== database && typeof client.release === "function") client.release();
  }
}

async function lockImport(client, importType, sourceSha256, mappingVersion) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${importType}:${sourceSha256}:${mappingVersion}`],
  );
}

async function lockTextbookScope(client, scopeKey) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`teaching_section_textbook_scope:${scopeKey}`],
  );
}

async function lockCourseScheduleScope(client, scopeKey) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`course_schedule_teacher_scope:${scopeKey}`],
  );
}

async function findAppliedBatch(client, importType, sourceSha256, mappingVersion) {
  const result = await client.query(
    `SELECT id
     FROM data_import_batches
     WHERE import_type = $1 AND source_sha256 = $2 AND mapping_version = $3
       AND status = 'applied'
     LIMIT 1`,
    [importType, sourceSha256, mappingVersion],
  );
  return result.rows[0]?.id ?? null;
}

async function createBatch(client, importType, source, mappingVersion) {
  const result = await client.query(
    `INSERT INTO data_import_batches (
       import_type, source_filename, source_sha256, mapping_version, dry_run
     ) VALUES ($1, $2, $3, $4, false)
     RETURNING id`,
    [importType, source.filename, source.sha256, mappingVersion],
  );
  const batchId = result.rows[0].id;
  await client.query(
    "UPDATE data_import_batches SET status = 'ready' WHERE id = $1",
    [batchId],
  );
  await client.query(
    "UPDATE data_import_batches SET status = 'applying' WHERE id = $1",
    [batchId],
  );
  return batchId;
}

async function finishBatch(client, batchId, counts) {
  await client.query(
    `UPDATE data_import_batches
     SET row_count = $2, accepted_count = $3, warning_count = $4,
         rejected_count = $5, status = 'applied'
     WHERE id = $1`,
    [batchId, counts.rowCount, counts.accepted, counts.warning, counts.rejected],
  );
}

async function insertImportRow(client, row) {
  await client.query(
    `INSERT INTO data_import_rows (
       id, batch_id, source_sheet, source_row, source_column, source_locator,
       source_key, content_sha256, disposition, risk_flags, error_codes,
       sanitized_payload, applied_entity_type, applied_entity_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[],
       $12::jsonb, $13, $14
     )`,
    [
      row.id,
      row.batchId,
      row.sourceSheet,
      row.sourceRow,
      row.sourceColumn,
      row.sourceLocator,
      row.sourceKey,
      row.contentSha256,
      row.disposition,
      row.riskFlags ?? [],
      row.errorCodes ?? [],
      JSON.stringify(row.sanitizedPayload ?? {}),
      row.appliedEntityType ?? null,
      row.appliedEntityId ?? null,
    ],
  );
}

async function insertMutation(client, mutation) {
  await client.query(
    `INSERT INTO data_import_mutations (
       batch_id, import_row_id, entity_type, entity_id, mutation_type, previous_entity_id
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      mutation.batchId,
      mutation.importRowId,
      mutation.entityType,
      mutation.entityId,
      mutation.mutationType,
      mutation.previousEntityId ?? null,
    ],
  );
}

function parseLocator(locator, defaultSheet) {
  const [sheet = defaultSheet, coordinate = "A1"] = String(locator).split("!");
  const match = coordinate.match(/^([A-Z]+)(\d+)/);
  if (!match) throw new Error(`无效源定位：${locator}`);
  let column = 0;
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
  return { sheet, row: Number(match[2]), column };
}

async function applyTeacherBatch(database, bundle) {
  const source = bundle.sources.teacher;
  return withTransaction(database, async (client) => {
    await lockImport(client, "teacher_reviews", source.sha256, bundle.mappingVersion);
    const existingBatchId = await findAppliedBatch(
      client,
      "teacher_reviews",
      source.sha256,
      bundle.mappingVersion,
    );
    if (existingBatchId) return { batchId: existingBatchId, idempotent: true };

    const batchId = await createBatch(
      client,
      "teacher_reviews",
      source,
      bundle.mappingVersion,
    );
    const teacherIds = new Map();
    let accepted = 0;
    let warning = 0;

    for (const teacher of bundle.teachers) {
      assertDigest(teacher.sourceDigest, "教师来源摘要");
      const existing = await client.query(
        `SELECT source_identity.id, source_identity.teacher_id,
                source_identity.mapping_status,
                source_identity.source_name_snapshot,
                source_identity.source_college_snapshot,
                teacher.identity_status
         FROM teacher_source_identities AS source_identity
         INNER JOIN teachers AS teacher ON teacher.id = source_identity.teacher_id
         WHERE source_system = $1 AND external_teacher_key = $2`,
        [TEACHER_SOURCE_SYSTEM, teacher.externalTeacherKey],
      );
      if (existing.rows[0]) {
        const sourceIdentityChanged =
          String(existing.rows[0].source_name_snapshot).normalize("NFKC").trim() !==
            String(teacher.displayName).normalize("NFKC").trim() ||
          String(existing.rows[0].source_college_snapshot).normalize("NFKC").trim() !==
            String(teacher.collegeName).normalize("NFKC").trim();
        if (sourceIdentityChanged) {
          throw new Error(
            `teacher_source_identity_conflict:${teacher.externalTeacherKey}`,
          );
        }
        teacherIds.set(teacher.externalTeacherKey, existing.rows[0].teacher_id);
        const restored = existing.rows[0].mapping_status === "withdrawn";
        const importRowId = crypto.randomUUID();
        if (restored) {
          await client.query(
            `UPDATE teacher_source_identities
             SET mapping_status = 'current', source_name_snapshot = $2,
                 source_college_snapshot = $3, source_digest = $4
             WHERE id = $1`,
            [
              existing.rows[0].id,
              teacher.displayName,
              teacher.collegeName,
              teacher.sourceDigest,
            ],
          );
          await client.query(
            `UPDATE teachers
             SET identity_status = 'pending'
             WHERE id = $1 AND identity_status = 'retired'`,
            [existing.rows[0].teacher_id],
          );
        }
        const locator = parseLocator(teacher.sourceLocator, "做在这个表");
        await insertImportRow(client, {
          id: importRowId,
          batchId,
          sourceSheet: locator.sheet,
          sourceRow: locator.row,
          sourceColumn: locator.column,
          sourceLocator: teacher.sourceLocator,
          sourceKey: teacher.externalTeacherKey,
          contentSha256: teacher.sourceDigest,
          disposition: restored ? "applied" : "accepted",
          errorCodes: [
            restored
              ? "restored_teacher_source_identity"
              : "existing_teacher_source_identity",
          ],
          sanitizedPayload: {
            displayName: teacher.displayName,
            collegeName: teacher.collegeName,
          },
          appliedEntityType: restored ? "teacher_source_identity" : null,
          appliedEntityId: restored ? existing.rows[0].id : null,
        });
        if (restored) {
          await insertMutation(client, {
            batchId,
            importRowId,
            entityType: "teacher_source_identity",
            entityId: existing.rows[0].id,
            mutationType: "restored",
          });
          if (existing.rows[0].identity_status === "retired") {
            await insertMutation(client, {
              batchId,
              importRowId,
              entityType: "teacher",
              entityId: existing.rows[0].teacher_id,
              mutationType: "restored",
            });
          }
        }
        accepted += 1;
        continue;
      }

      const teacherId = crypto.randomUUID();
      const sourceIdentityId = crypto.randomUUID();
      const importRowId = crypto.randomUUID();
      const locator = parseLocator(teacher.sourceLocator, "做在这个表");
      await insertImportRow(client, {
        id: importRowId,
        batchId,
        sourceSheet: locator.sheet,
        sourceRow: locator.row,
        sourceColumn: locator.column,
        sourceLocator: teacher.sourceLocator,
        sourceKey: teacher.externalTeacherKey,
        contentSha256: teacher.sourceDigest,
        disposition: "applied",
        sanitizedPayload: {
          displayName: teacher.displayName,
          collegeName: teacher.collegeName,
        },
        appliedEntityType: "teacher",
        appliedEntityId: teacherId,
      });
      await client.query(
        `INSERT INTO teachers (
           id, display_name, normalized_name, college_name, normalized_college,
           identity_status, created_batch_id
         ) VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [
          teacherId,
          teacher.displayName,
          teacher.displayName.normalize("NFKC").toLocaleLowerCase("zh-CN"),
          teacher.collegeName,
          teacher.collegeName.normalize("NFKC").toLocaleLowerCase("zh-CN"),
          batchId,
        ],
      );
      await client.query(
        `INSERT INTO teacher_source_identities (
           id, teacher_id, source_system, external_teacher_key,
           source_name_snapshot, source_college_snapshot, source_digest, source_batch_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          sourceIdentityId,
          teacherId,
          TEACHER_SOURCE_SYSTEM,
          teacher.externalTeacherKey,
          teacher.displayName,
          teacher.collegeName,
          teacher.sourceDigest,
          batchId,
        ],
      );
      await insertMutation(client, {
        batchId,
        importRowId,
        entityType: "teacher",
        entityId: teacherId,
        mutationType: "created",
      });
      await insertMutation(client, {
        batchId,
        importRowId,
        entityType: "teacher_source_identity",
        entityId: sourceIdentityId,
        mutationType: "created",
      });
      teacherIds.set(teacher.externalTeacherKey, teacherId);
      accepted += 1;
    }

    for (const candidate of bundle.reviewCandidates) {
      assertDigest(candidate.originalBodySha256, "评价原文摘要");
      assertDigest(candidate.normalizedBodySha256, "评价规范化摘要");
      const teacherId = teacherIds.get(candidate.externalTeacherKey);
      if (!teacherId) throw new Error(`评价候选缺教师映射：${candidate.externalTeacherKey}`);
      const duplicate = await client.query(
        `SELECT id FROM teacher_review_candidates
         WHERE teacher_id = $1 AND normalized_body_sha256 = $2
           AND moderation_status <> 'rolled_back'
         LIMIT 1`,
        [teacherId, candidate.normalizedBodySha256],
      );
      if (duplicate.rows[0]) {
        const locator = parseLocator(candidate.sourceLocator, "做在这个表");
        await insertImportRow(client, {
          id: crypto.randomUUID(),
          batchId,
          sourceSheet: locator.sheet,
          sourceRow: locator.row,
          sourceColumn: locator.column,
          sourceLocator: candidate.sourceLocator,
          sourceKey: candidate.externalTeacherKey,
          contentSha256: candidate.originalBodySha256,
          disposition: "warning",
          riskFlags: candidate.riskFlags,
          errorCodes: ["duplicate_legacy_review"],
          sanitizedPayload: {},
        });
        warning += 1;
        continue;
      }

      const candidateId = crypto.randomUUID();
      const importRowId = crypto.randomUUID();
      const locator = parseLocator(candidate.sourceLocator, "做在这个表");
      await insertImportRow(client, {
        id: importRowId,
        batchId,
        sourceSheet: locator.sheet,
        sourceRow: locator.row,
        sourceColumn: locator.column,
        sourceLocator: candidate.sourceLocator,
        sourceKey: candidate.externalTeacherKey,
        contentSha256: candidate.originalBodySha256,
        disposition: "applied",
        riskFlags: candidate.riskFlags,
        errorCodes: ["legacy_review_requires_moderation", ...candidate.riskFlags],
        sanitizedPayload: { sanitizedBody: candidate.sanitizedBody },
        appliedEntityType: "teacher_review_candidate",
        appliedEntityId: candidateId,
      });
      await client.query(
        `INSERT INTO teacher_review_candidates (
           id, teacher_id, import_row_id, sanitized_body, original_body_sha256,
           normalized_body_sha256, risk_flags
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[])`,
        [
          candidateId,
          teacherId,
          importRowId,
          candidate.sanitizedBody,
          candidate.originalBodySha256,
          candidate.normalizedBodySha256,
          candidate.riskFlags,
        ],
      );
      await insertMutation(client, {
        batchId,
        importRowId,
        entityType: "teacher_review_candidate",
        entityId: candidateId,
        mutationType: "created",
      });
      warning += 1;
    }

    await finishBatch(client, batchId, {
      rowCount: accepted + warning,
      accepted,
      warning,
      rejected: 0,
    });
    return { batchId, idempotent: false, accepted, warning };
  });
}

function textbookScopeKey(record, teacherId) {
  return JSON.stringify([
    record.termKey,
    record.courseId,
    record.sectionNo,
    teacherId ?? "",
    record.position,
  ]);
}

function courseScheduleScopeKey(record) {
  return JSON.stringify([record.catalogId, record.scheduleId]);
}

function courseScheduleContentSha256(record) {
  return crypto.createHash("sha256").update(JSON.stringify({
    catalogId: record.catalogId,
    scheduleId: record.scheduleId,
    externalTeacherKeys: [...record.externalTeacherKeys].sort(),
  }), "utf8").digest("hex");
}

async function applyTextbookBatch(database, bundle) {
  const source = bundle.sources.textbook;
  return withTransaction(database, async (client) => {
    await lockImport(client, "teaching_section_textbooks", source.sha256, bundle.mappingVersion);
    const existingBatchId = await findAppliedBatch(
      client,
      "teaching_section_textbooks",
      source.sha256,
      bundle.mappingVersion,
    );
    if (existingBatchId) return { batchId: existingBatchId, idempotent: true };
    const batchId = await createBatch(
      client,
      "teaching_section_textbooks",
      source,
      bundle.mappingVersion,
    );

    const externalKeys = [...new Set(bundle.textbooks.map((record) => record.externalTeacherKey).filter(Boolean))];
    const mappingRows = externalKeys.length
      ? await client.query(
        `SELECT external_teacher_key, teacher_id
         FROM teacher_source_identities
         WHERE source_system = $1 AND mapping_status = 'current'
           AND external_teacher_key = ANY($2::text[])`,
        [TEACHER_SOURCE_SYSTEM, externalKeys],
      )
      : { rows: [] };
    const teacherIds = new Map(
      mappingRows.rows.map((row) => [row.external_teacher_key, row.teacher_id]),
    );
    const resolvedTextbooks = bundle.textbooks.map((record) => {
      const teacherId = record.externalTeacherKey
        ? teacherIds.get(record.externalTeacherKey) ?? null
        : null;
      return {
        record,
        teacherId,
        scopeKey: textbookScopeKey(record, teacherId),
      };
    });
    const scopeKeys = [...new Set(resolvedTextbooks.map((item) => item.scopeKey))].sort();
    for (const scopeKey of scopeKeys) await lockTextbookScope(client, scopeKey);

    const existingRows = await client.query(
      `SELECT id, term_key, course_id, section_no, teacher_id, position,
              material_sha256, record_status
       FROM teaching_section_textbooks
       WHERE record_status IN ('current', 'needs_review')`,
    );
    const scopes = new Map();
    for (const row of existingRows.rows) {
      const record = {
        termKey: row.term_key,
        courseId: row.course_id,
        sectionNo: row.section_no,
        position: row.position,
        materialSha256: row.material_sha256,
      };
      scopes.set(textbookScopeKey(record, row.teacher_id), row);
    }

    let accepted = 0;
    let warning = 0;
    for (const { record, teacherId, scopeKey } of resolvedTextbooks) {
      assertDigest(record.materialSha256, "教材摘要");
      const previous = scopes.get(scopeKey);
      if (previous?.material_sha256 === record.materialSha256) {
        const locator = parseLocator(record.sourceLocator, "Sheet1");
        const needsReview = record.recordStatus === "needs_review";
        await insertImportRow(client, {
          id: crypto.randomUUID(),
          batchId,
          sourceSheet: locator.sheet,
          sourceRow: locator.row,
          sourceColumn: null,
          sourceLocator: record.sourceLocator,
          sourceKey: `${record.termKey}|${record.courseId}|${record.sectionNo}|${record.teacherName}`,
          contentSha256: record.materialSha256,
          disposition: needsReview ? "warning" : "accepted",
          errorCodes: ["existing_teaching_section_textbook"],
          sanitizedPayload: {},
        });
        if (needsReview) warning += 1;
        else accepted += 1;
        continue;
      }

      const importRowId = crypto.randomUUID();
      const textbookId = crypto.randomUUID();
      const locator = parseLocator(record.sourceLocator, "Sheet1");
      await insertImportRow(client, {
        id: importRowId,
        batchId,
        sourceSheet: locator.sheet,
        sourceRow: locator.row,
        sourceColumn: null,
        sourceLocator: record.sourceLocator,
        sourceKey: `${record.termKey}|${record.courseId}|${record.sectionNo}|${record.teacherName}`,
        contentSha256: record.materialSha256,
        disposition: "applied",
        errorCodes: record.recordStatus === "needs_review" ? ["textbook_needs_review"] : [],
        sanitizedPayload: {
          courseId: record.courseId,
          sectionNo: record.sectionNo,
          teacherName: record.teacherName,
          title: record.title,
        },
        appliedEntityType: "teaching_section_textbook",
        appliedEntityId: textbookId,
      });
      if (previous) {
        await client.query(
          "UPDATE teaching_section_textbooks SET record_status = 'superseded', updated_at = now() WHERE id = $1",
          [previous.id],
        );
        await insertMutation(client, {
          batchId,
          importRowId,
          entityType: "teaching_section_textbook",
          entityId: previous.id,
          mutationType: "superseded",
        });
      }
      await client.query(
        `INSERT INTO teaching_section_textbooks (
           id, term_key, course_id, course_title, section_no, teacher_id,
           teacher_name_snapshot, teacher_college_snapshot, material_kind,
           selection_status, title, author, publisher, publication_date,
           publication_date_raw, edition, printing, isbn, isbn_status, position,
           material_sha256, source_batch_id, source_row_id, supersedes_id, record_status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
         )`,
        [
          textbookId,
          record.termKey,
          record.courseId,
          record.courseTitle,
          record.sectionNo,
          teacherId,
          record.teacherName,
          record.teacherCollege,
          record.materialKind,
          record.selectionStatus,
          record.title,
          record.author,
          record.publisher,
          record.publicationDate,
          record.publicationDateRaw,
          record.edition,
          record.printing,
          record.isbn,
          record.isbnStatus,
          record.position,
          record.materialSha256,
          batchId,
          importRowId,
          previous?.id ?? null,
          record.recordStatus,
        ],
      );
      await insertMutation(client, {
        batchId,
        importRowId,
        entityType: "teaching_section_textbook",
        entityId: textbookId,
        mutationType: "created",
        previousEntityId: previous?.id,
      });
      const row = {
        id: textbookId,
        teacher_id: teacherId,
        material_sha256: record.materialSha256,
        record_status: record.recordStatus,
      };
      scopes.set(scopeKey, row);
      if (record.recordStatus === "needs_review") warning += 1;
      else accepted += 1;
    }
    await finishBatch(client, batchId, {
      rowCount: accepted + warning,
      accepted,
      warning,
      rejected: 0,
    });
    return { batchId, idempotent: false, accepted, warning };
  });
}

async function applyCourseSectionBatch(database, bundle) {
  const source = bundle.sources.courseSections;
  return withTransaction(database, async (client) => {
    await lockImport(client, "course_schedule_teachers", source.sha256, bundle.mappingVersion);
    const existingBatchId = await findAppliedBatch(
      client,
      "course_schedule_teachers",
      source.sha256,
      bundle.mappingVersion,
    );
    if (existingBatchId) return { batchId: existingBatchId, idempotent: true };

    const records = bundle.courseSections ?? [];
    const externalKeys = [...new Set(records.flatMap((record) => record.externalTeacherKeys))];
    const mappingRows = externalKeys.length
      ? await client.query(
        `SELECT external_teacher_key, teacher_id
         FROM teacher_source_identities
         WHERE source_system = $1 AND mapping_status = 'current'
           AND external_teacher_key = ANY($2::text[])`,
        [TEACHER_SOURCE_SYSTEM, externalKeys],
      )
      : { rows: [] };
    const teacherIds = new Map(
      mappingRows.rows.map((row) => [row.external_teacher_key, row.teacher_id]),
    );
    const missingKeys = externalKeys.filter((key) => !teacherIds.has(key));
    if (missingKeys.length) {
      throw new Error(`课程日程缺少显式教师映射：${missingKeys.join(",")}`);
    }

    const resolved = records.map((record) => {
      const desiredTeacherIds = record.externalTeacherKeys.map((key) => teacherIds.get(key));
      if (new Set(desiredTeacherIds).size !== desiredTeacherIds.length) {
        throw new Error(`课程日程多个外部键指向同一教师：${record.scheduleId}`);
      }
      return {
        record,
        desiredTeacherIds,
        scopeKey: courseScheduleScopeKey(record),
      };
    });
    const scopeKeys = [...new Set(resolved.map((item) => item.scopeKey))].sort();
    for (const scopeKey of scopeKeys) await lockCourseScheduleScope(client, scopeKey);

    const currentRows = records.length
      ? await client.query(
        `SELECT link.id, link.catalog_id, link.schedule_id, link.teacher_id
         FROM course_schedule_teachers AS link
         INNER JOIN unnest($1::text[], $2::text[])
           AS requested(catalog_id, schedule_id)
           ON requested.catalog_id = link.catalog_id
          AND requested.schedule_id = link.schedule_id
         WHERE link.record_status = 'current'`,
        [
          records.map((record) => record.catalogId),
          records.map((record) => record.scheduleId),
        ],
      )
      : { rows: [] };
    const currentByScope = new Map();
    for (const row of currentRows.rows) {
      const scopeKey = courseScheduleScopeKey({
        catalogId: row.catalog_id,
        scheduleId: row.schedule_id,
      });
      const links = currentByScope.get(scopeKey) ?? [];
      links.push(row);
      currentByScope.set(scopeKey, links);
    }

    const batchId = await createBatch(
      client,
      "course_schedule_teachers",
      source,
      bundle.mappingVersion,
    );
    let accepted = 0;
    for (const { record, desiredTeacherIds, scopeKey } of resolved) {
      const current = currentByScope.get(scopeKey) ?? [];
      const desired = new Set(desiredTeacherIds);
      const currentIds = new Set(current.map((row) => row.teacher_id));
      const removed = current.filter((row) => !desired.has(row.teacher_id));
      const created = desiredTeacherIds
        .filter((teacherId) => !currentIds.has(teacherId))
        .map((teacherId) => ({ id: crypto.randomUUID(), teacherId }));
      const changed = removed.length > 0 || created.length > 0;
      const importRowId = crypto.randomUUID();
      const locator = parseLocator(record.sourceLocator, "courseSections");
      const firstEntityId = removed[0]?.id ?? created[0]?.id ?? null;
      await insertImportRow(client, {
        id: importRowId,
        batchId,
        sourceSheet: locator.sheet,
        sourceRow: locator.row,
        sourceColumn: locator.column,
        sourceLocator: record.sourceLocator,
        sourceKey: `${record.catalogId}|${record.scheduleId}`,
        contentSha256: courseScheduleContentSha256(record),
        disposition: changed ? "applied" : "accepted",
        sanitizedPayload: {
          catalogId: record.catalogId,
          scheduleId: record.scheduleId,
          teacherCount: desiredTeacherIds.length,
        },
        appliedEntityType: changed ? "course_schedule_teacher" : null,
        appliedEntityId: firstEntityId,
      });

      for (const link of removed) {
        await client.query(
          `UPDATE course_schedule_teachers
           SET record_status = 'withdrawn'
           WHERE id = $1 AND record_status = 'current'`,
          [link.id],
        );
        await insertMutation(client, {
          batchId,
          importRowId,
          entityType: "course_schedule_teacher",
          entityId: link.id,
          mutationType: "withdrawn",
        });
      }
      for (const link of created) {
        await client.query(
          `INSERT INTO course_schedule_teachers (
             id, catalog_id, schedule_id, teacher_id,
             source_batch_id, source_row_id
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            link.id,
            record.catalogId,
            record.scheduleId,
            link.teacherId,
            batchId,
            importRowId,
          ],
        );
        await insertMutation(client, {
          batchId,
          importRowId,
          entityType: "course_schedule_teacher",
          entityId: link.id,
          mutationType: "created",
        });
      }
      accepted += 1;
    }

    await finishBatch(client, batchId, {
      rowCount: accepted,
      accepted,
      warning: 0,
      rejected: 0,
    });
    return { batchId, idempotent: false, accepted, warning: 0 };
  });
}

export async function applyPrivateBundle(database, bundle, courseCatalog = null) {
  assertPrivateBundle(bundle);
  assertCourseSectionsExist(bundle, courseCatalog);
  const teacherBatch = await applyTeacherBatch(database, bundle);
  const textbookBatch = await applyTextbookBatch(database, bundle);
  const courseSectionBatch = bundle.sources?.courseSections
    ? await applyCourseSectionBatch(database, bundle)
    : null;
  return { teacherBatch, textbookBatch, courseSectionBatch };
}

export async function rollbackImportBatch(database, batchId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(batchId))) throw new Error("无效批次 UUID");
  return withTransaction(database, async (client) => {
    const batch = await client.query(
      "SELECT id, import_type, status, created_at FROM data_import_batches WHERE id = $1 FOR UPDATE",
      [batchId],
    );
    if (!batch.rows[0]) throw new Error("导入批次不存在");
    if (batch.rows[0].status === "rolled_back") return { batchId, idempotent: true };
    if (batch.rows[0].status !== "applied") throw new Error("只有 applied 批次可以回滚");
    const mutations = await client.query(
      `SELECT import_row_id, entity_type, entity_id, mutation_type, previous_entity_id
       FROM data_import_mutations WHERE batch_id = $1 ORDER BY id DESC`,
      [batchId],
    );

    const candidateIds = mutations.rows
      .filter((row) => row.entity_type === "teacher_review_candidate" && row.mutation_type === "created")
      .map((row) => row.entity_id);
    if (candidateIds.length) {
      const published = await client.query(
        "SELECT 1 FROM teacher_reviews WHERE import_candidate_id = ANY($1::uuid[]) LIMIT 1",
        [candidateIds],
      );
      if (published.rows[0]) throw new Error("已有历史候选获批公开，必须先走管理员隐藏审计流程");
    }

    const teacherIds = mutations.rows
      .filter((row) => row.entity_type === "teacher" && row.mutation_type === "created")
      .map((row) => row.entity_id);
    if (teacherIds.length) {
      const dependent = await client.query(
        `SELECT 1
         FROM (
           SELECT teacher_id, source_batch_id
           FROM teaching_section_textbooks
           WHERE record_status <> 'withdrawn'
           UNION ALL
           SELECT teacher_id, source_batch_id
           FROM course_schedule_teachers
           WHERE record_status = 'current'
         ) AS dependency
         WHERE teacher_id = ANY($1::uuid[]) AND source_batch_id <> $2
         LIMIT 1`,
        [teacherIds, batchId],
      );
      if (dependent.rows[0]) throw new Error("后续教材批次依赖本批教师，或课程教师覆盖批次仍引用本批教师；必须先回滚后续批次");
    }

    const courseLinkIds = mutations.rows
      .filter((row) => row.entity_type === "course_schedule_teacher")
      .map((row) => row.entity_id);
    if (courseLinkIds.length) {
      const laterCourseBatch = await client.query(
        `SELECT 1
         FROM course_schedule_teachers AS target
         INNER JOIN course_schedule_teachers AS active
           ON active.catalog_id = target.catalog_id
          AND active.schedule_id = target.schedule_id
          AND active.record_status = 'current'
         INNER JOIN data_import_batches AS active_batch
           ON active_batch.id = active.source_batch_id
         WHERE target.id = ANY($1::uuid[])
           AND active.source_batch_id <> $2
           AND active_batch.created_at > $3
         LIMIT 1`,
        [courseLinkIds, batchId, batch.rows[0].created_at],
      );
      if (laterCourseBatch.rows[0]) {
        throw new Error("课程教师覆盖存在后续批次，必须按逆序回滚");
      }
    }

    for (const mutation of mutations.rows) {
      if (mutation.entity_type === "teacher_review_candidate" && mutation.mutation_type === "created") {
        const rolledBack = await client.query(
          "SELECT rollback_teacher_review_candidate_for_import($1, $2) AS rolled_back",
          [mutation.entity_id, batchId],
        );
        if (!rolledBack.rows[0]?.rolled_back) {
          throw new Error("历史评价候选不属于当前导入批次");
        }
        await insertMutation(client, {
          batchId,
          importRowId: mutation.import_row_id,
          entityType: mutation.entity_type,
          entityId: mutation.entity_id,
          mutationType: "withdrawn",
        });
      } else if (mutation.entity_type === "course_schedule_teacher" && mutation.mutation_type === "created") {
        await client.query(
          `UPDATE course_schedule_teachers
           SET record_status = 'withdrawn'
           WHERE id = $1 AND record_status = 'current'`,
          [mutation.entity_id],
        );
        await insertMutation(client, {
          batchId,
          importRowId: mutation.import_row_id,
          entityType: mutation.entity_type,
          entityId: mutation.entity_id,
          mutationType: "withdrawn",
        });
      } else if (mutation.entity_type === "course_schedule_teacher" && mutation.mutation_type === "withdrawn") {
        await client.query(
          `UPDATE course_schedule_teachers
           SET record_status = 'current'
           WHERE id = $1 AND record_status = 'withdrawn'`,
          [mutation.entity_id],
        );
        await insertMutation(client, {
          batchId,
          importRowId: mutation.import_row_id,
          entityType: mutation.entity_type,
          entityId: mutation.entity_id,
          mutationType: "restored",
        });
      } else if (mutation.entity_type === "teaching_section_textbook" && mutation.mutation_type === "created") {
        await client.query(
          "UPDATE teaching_section_textbooks SET record_status = 'withdrawn', updated_at = now() WHERE id = $1",
          [mutation.entity_id],
        );
        await insertMutation(client, {
          batchId,
          importRowId: mutation.import_row_id,
          entityType: mutation.entity_type,
          entityId: mutation.entity_id,
          mutationType: "withdrawn",
          previousEntityId: mutation.previous_entity_id,
        });
        if (mutation.previous_entity_id) {
          await client.query(
            "UPDATE teaching_section_textbooks SET record_status = 'current', updated_at = now() WHERE id = $1",
            [mutation.previous_entity_id],
          );
          await insertMutation(client, {
            batchId,
            importRowId: mutation.import_row_id,
            entityType: mutation.entity_type,
            entityId: mutation.previous_entity_id,
            mutationType: "restored",
          });
        }
      } else if (mutation.entity_type === "teacher_source_identity" && mutation.mutation_type === "created") {
        await client.query(
          "UPDATE teacher_source_identities SET mapping_status = 'withdrawn' WHERE id = $1",
          [mutation.entity_id],
        );
        await insertMutation(client, {
          batchId,
          importRowId: mutation.import_row_id,
          entityType: mutation.entity_type,
          entityId: mutation.entity_id,
          mutationType: "withdrawn",
        });
      } else if (mutation.entity_type === "teacher_source_identity" && mutation.mutation_type === "restored") {
        await client.query(
          "UPDATE teacher_source_identities SET mapping_status = 'withdrawn' WHERE id = $1",
          [mutation.entity_id],
        );
        await insertMutation(client, {
          batchId,
          importRowId: mutation.import_row_id,
          entityType: mutation.entity_type,
          entityId: mutation.entity_id,
          mutationType: "withdrawn",
        });
      } else if (mutation.entity_type === "teacher" && mutation.mutation_type === "created") {
        await client.query(
          "UPDATE teachers SET identity_status = 'retired' WHERE id = $1",
          [mutation.entity_id],
        );
        await insertMutation(client, {
          batchId,
          importRowId: mutation.import_row_id,
          entityType: mutation.entity_type,
          entityId: mutation.entity_id,
          mutationType: "withdrawn",
        });
      } else if (mutation.entity_type === "teacher" && mutation.mutation_type === "restored") {
        await client.query(
          "UPDATE teachers SET identity_status = 'retired' WHERE id = $1",
          [mutation.entity_id],
        );
        await insertMutation(client, {
          batchId,
          importRowId: mutation.import_row_id,
          entityType: mutation.entity_type,
          entityId: mutation.entity_id,
          mutationType: "withdrawn",
        });
      }
    }
    await client.query(
      "UPDATE data_import_batches SET status = 'rolled_back' WHERE id = $1",
      [batchId],
    );
    return { batchId, idempotent: false };
  });
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || !rest[index + 1]) {
      throw new Error(`参数格式错误：${rest[index] ?? "<empty>"}`);
    }
    values[rest[index].slice(2)] = rest[index + 1];
  }
  return values;
}

async function runCli() {
  const args = parseArguments(process.argv.slice(2));
  let bundle = null;
  let courseCatalog = null;
  if (args.command === "apply") {
    if (!args.bundle) throw new Error("apply 缺少 --bundle");
    bundle = JSON.parse(await fs.readFile(path.resolve(args.bundle), "utf8"));
    if (bundle.courseSections?.length && !args["course-data"]) {
      throw new Error("非空 courseSections 必须提供 --course-data <published-json>");
    }
    if (args["course-data"]) {
      courseCatalog = JSON.parse(
        await fs.readFile(path.resolve(args["course-data"]), "utf8"),
      );
    }
    assertPrivateBundle(bundle);
    assertCourseSectionsExist(bundle, courseCatalog);
  } else if (args.command === "rollback") {
    if (!args.batch) throw new Error("rollback 缺少 --batch");
  } else {
    throw new Error("命令必须是 apply 或 rollback");
  }

  if (process.env.IMPORT_ALLOW_APPLY !== "true") {
    throw new Error("必须显式设置 IMPORT_ALLOW_APPLY=true 才能执行数据库写入");
  }
  if (!process.env.IMPORT_DATABASE_URL && !process.env.IMPORT_DB_PASSWORD) {
    throw new Error("缺少 IMPORT_DATABASE_URL 或 IMPORT_DB_PASSWORD");
  }
  const { Pool } = await import("pg");
  const database = new Pool({
    ...(process.env.IMPORT_DATABASE_URL
      ? { connectionString: process.env.IMPORT_DATABASE_URL }
      : {
          host: process.env.PGHOST ?? "localhost",
          port: Number(process.env.PGPORT ?? 5432),
          database: process.env.POSTGRES_DB ?? "dufesh",
          user: process.env.IMPORT_DB_USER ?? "dufesh_importer",
          password: process.env.IMPORT_DB_PASSWORD,
        }),
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  try {
    if (args.command === "apply") {
      return await applyPrivateBundle(database, bundle, courseCatalog);
    }
    return await rollbackImportBatch(database, args.batch);
  } finally {
    await database.end();
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  runCli()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`academic import write failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
