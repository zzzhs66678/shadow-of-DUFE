import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TEACHER_SOURCE_SYSTEM = "dufe_teacher_review_workbook";
const UNSANITIZED_CONTACT = /(?:1[3-9]\d{9}|(?:qq|QQ|微信|vx|手机号|电话)\s*[:：]?\s*[A-Za-z0-9_-]{5,})/;

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
    bundle.textbooks.length > 100_000
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
        `SELECT id, teacher_id, mapping_status
         FROM teacher_source_identities
         WHERE source_system = $1 AND external_teacher_key = $2`,
        [TEACHER_SOURCE_SYSTEM, teacher.externalTeacherKey],
      );
      if (existing.rows[0]) {
        teacherIds.set(teacher.externalTeacherKey, existing.rows[0].teacher_id);
        if (existing.rows[0].mapping_status === "withdrawn") {
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
        }
        const locator = parseLocator(teacher.sourceLocator, "做在这个表");
        await insertImportRow(client, {
          id: crypto.randomUUID(),
          batchId,
          sourceSheet: locator.sheet,
          sourceRow: locator.row,
          sourceColumn: locator.column,
          sourceLocator: teacher.sourceLocator,
          sourceKey: teacher.externalTeacherKey,
          contentSha256: teacher.sourceDigest,
          disposition: "accepted",
          errorCodes: ["existing_teacher_source_identity"],
          sanitizedPayload: {
            displayName: teacher.displayName,
            collegeName: teacher.collegeName,
          },
        });
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

function textbookIdentityKey(record, teacherId) {
  return [
    record.termKey,
    record.courseId,
    record.sectionNo,
    teacherId ?? "",
    record.position,
    record.materialSha256,
  ].join("\u0000");
}

function textbookScopeKey(record, teacherId) {
  return [record.termKey, record.courseId, record.sectionNo, teacherId ?? "", record.position].join("\u0000");
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
    const existingRows = await client.query(
      `SELECT id, term_key, course_id, section_no, teacher_id, position,
              material_sha256, record_status
       FROM teaching_section_textbooks
       WHERE record_status <> 'withdrawn'`,
    );
    const exact = new Map();
    const scopes = new Map();
    for (const row of existingRows.rows) {
      const record = {
        termKey: row.term_key,
        courseId: row.course_id,
        sectionNo: row.section_no,
        position: row.position,
        materialSha256: row.material_sha256,
      };
      exact.set(textbookIdentityKey(record, row.teacher_id), row);
      scopes.set(textbookScopeKey(record, row.teacher_id), row);
    }

    let accepted = 0;
    let warning = 0;
    for (const record of bundle.textbooks) {
      assertDigest(record.materialSha256, "教材摘要");
      const teacherId = record.externalTeacherKey
        ? teacherIds.get(record.externalTeacherKey) ?? null
        : null;
      const exactKey = textbookIdentityKey(record, teacherId);
      if (exact.has(exactKey)) {
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
      const previous = scopes.get(textbookScopeKey(record, teacherId));
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
      const row = { id: textbookId, teacher_id: teacherId, ...record };
      exact.set(exactKey, row);
      scopes.set(textbookScopeKey(record, teacherId), row);
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

export async function applyPrivateBundle(database, bundle) {
  assertPrivateBundle(bundle);
  const teacherBatch = await applyTeacherBatch(database, bundle);
  const textbookBatch = await applyTextbookBatch(database, bundle);
  return { teacherBatch, textbookBatch };
}

export async function rollbackImportBatch(database, batchId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(batchId))) throw new Error("无效批次 UUID");
  return withTransaction(database, async (client) => {
    const batch = await client.query(
      "SELECT id, import_type, status FROM data_import_batches WHERE id = $1 FOR UPDATE",
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
        `SELECT 1 FROM teaching_section_textbooks
         WHERE teacher_id = ANY($1::uuid[]) AND record_status <> 'withdrawn'
           AND source_batch_id <> $2
         LIMIT 1`,
        [teacherIds, batchId],
      );
      if (dependent.rows[0]) throw new Error("后续教材批次依赖本批教师，必须先回滚后续批次");
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
    const args = parseArguments(process.argv.slice(2));
    if (args.command === "apply") {
      if (!args.bundle) throw new Error("apply 缺少 --bundle");
      const bundle = JSON.parse(await fs.readFile(path.resolve(args.bundle), "utf8"));
      return await applyPrivateBundle(database, bundle);
    }
    if (args.command === "rollback") {
      if (!args.batch) throw new Error("rollback 缺少 --batch");
      return await rollbackImportBatch(database, args.batch);
    }
    throw new Error("命令必须是 apply 或 rollback");
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
