import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import {
  __test as adminSecurityTest,
  createAdminSecurity,
} from "../services/auth-api/src/admin-security.mjs";
import { createAvatarProcessor } from "../services/auth-api/src/avatars.mjs";
import { loadConfig } from "../services/auth-api/src/config.mjs";
import {
  createAuthStore,
  createDatabasePool,
} from "../services/auth-api/src/db.mjs";
import { createPasswordService } from "../services/auth-api/src/passwords.mjs";
import { createWechatProvider } from "../services/auth-api/src/providers/mock-wechat.mjs";
import { createApiRateLimiters } from "../services/auth-api/src/rate-limit.mjs";
import { createAuthServer } from "../services/auth-api/src/server.mjs";
import {
  applyPrivateBundle,
  rollbackImportBatch,
} from "../scripts/academic-import-apply.mjs";
import { createTeacherReviewStore } from "../services/auth-api/src/teacher-review-store.mjs";

const enabled = process.env.POSTGRES_INTEGRATION === "true";
const { Pool } = pg;

function poolFor(user, password) {
  return new Pool({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.POSTGRES_DB,
    user,
    password,
    max: 20,
    connectionTimeoutMillis: 3_000,
    query_timeout: 10_000,
  });
}

async function denied(pool, statement) {
  await assert.rejects(
    pool.query(statement),
    (error) => error?.code === "42501",
  );
}

async function assertTablePrivilege(pool, table, privilege, expected) {
  const result = await pool.query(
    `SELECT has_table_privilege(current_user, $1, $2) AS allowed`,
    [table, privilege],
  );
  assert.equal(result.rows[0].allowed, expected, `${table} ${privilege}`);
}

async function assertFunctionPrivilege(pool, functionName, expected) {
  const result = await pool.query(
    `SELECT has_function_privilege(current_user, $1, 'EXECUTE') AS allowed`,
    [functionName],
  );
  assert.equal(result.rows[0].allowed, expected, functionName);
}

function integrationConfig() {
  const mfaKey = Buffer.alloc(32, 0x44).toString("base64");
  return loadConfig({
    NODE_ENV: "test",
    AUTH_API_PORT: "3100",
    AUTH_TOKEN_PEPPER: "ci-token-pepper-that-is-longer-than-thirty-two-characters",
    AUTH_ALLOWED_ORIGINS: "https://dufesh.cn",
    AUTH_PUBLIC_ORIGIN: "https://dufesh.cn",
    AUTH_DB_USER: process.env.AUTH_DB_USER,
    AUTH_DB_PASSWORD: process.env.AUTH_DB_PASSWORD,
    POSTGRES_DB: process.env.POSTGRES_DB,
    PGHOST: process.env.PGHOST ?? "127.0.0.1",
    PGPORT: process.env.PGPORT ?? "5432",
    AUTH_WECHAT_MODE: "disabled",
    AUTH_PASSWORD_RESET_MODE: "response",
    AUTH_EMAIL_VERIFICATION_MODE: "response",
    AUTH_ADMIN_ENABLED: "true",
    AUTH_ADMIN_MFA_ACTIVE_KEY_ID: "ci-key",
    AUTH_ADMIN_MFA_KEYS: JSON.stringify({ "ci-key": mfaKey }),
    AUTH_ADMIN_RECOVERY_PEPPER:
      "ci-recovery-pepper-that-is-longer-than-thirty-two-characters",
  });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function integrationAcademicBundle(label) {
  const teacherKey = `ci-teacher-${label}`;
  return {
    schemaVersion: 1,
    mappingVersion: `ci-${label}`,
    private: true,
    sources: {
      teacher: {
        filename: `ci-teachers-${label}.xlsx`,
        sha256: sha256(`teacher-source:${label}`),
      },
      textbook: {
        filename: `ci-textbooks-${label}.xlsx`,
        sha256: sha256(`textbook-source:${label}`),
      },
    },
    teachers: [{
      sourceLocator: "教师评价!C2",
      externalTeacherKey: teacherKey,
      displayName: `并发导入教师-${label}`,
      collegeName: `并发测试学院-${label}`,
      sourceDigest: sha256(`teacher-row:${label}`),
    }],
    reviewCandidates: [{
      sourceLocator: "教师评价!D2",
      sourceRow: 2,
      sourceColumn: 4,
      externalTeacherKey: teacherKey,
      sanitizedBody: `这是一条用于真实 PostgreSQL 并发审核的脱敏历史评价-${label}`,
      originalBodySha256: sha256(`review-original:${label}`),
      normalizedBodySha256: sha256(`review-normalized:${label}`),
      riskFlags: [],
    }],
    textbooks: [],
  };
}

function integrationTextbookBundle(label, sourceRevision, materialRevision = sourceRevision) {
  const bundle = integrationAcademicBundle(label);
  bundle.reviewCandidates = [];
  bundle.sources.textbook = {
    filename: `ci-textbooks-${label}-${sourceRevision}.xlsx`,
    sha256: sha256(`textbook-source:${label}:${sourceRevision}`),
  };
  bundle.textbooks = [{
    sourceLocator: "教材!A2:Y2",
    sourceRow: 2,
    termKey: "2026-fall",
    courseId: `CI-COURSE-${label}`,
    courseTitle: `并发教材课程-${label}`,
    sectionNo: "01",
    teacherName: `并发导入教师-${label}`,
    teacherCollege: `并发测试学院-${label}`,
    externalTeacherKey: `ci-teacher-${label}`,
    materialKind: "book",
    selectionStatus: "specified",
    position: 1,
    recordStatus: "current",
    materialSha256: sha256(`material:${materialRevision}`),
    title: `教材-${sourceRevision}`,
    author: "测试作者",
    publisher: "测试出版社",
    publicationDate: null,
    publicationDateRaw: null,
    edition: null,
    printing: null,
    isbn: null,
    isbnStatus: "missing",
  }];
  return bundle;
}

function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function closeServer(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("PostgreSQL 17 migrations and role boundaries hold under runtime traffic", {
  skip: !enabled,
  timeout: 30_000,
}, async () => {
  const owner = poolFor(process.env.POSTGRES_USER, process.env.POSTGRES_PASSWORD);
  const runtime = poolFor(process.env.AUTH_DB_USER, process.env.AUTH_DB_PASSWORD);
  const aclRuntime = poolFor(
    process.env.AUTH_DB_USER,
    process.env.AUTH_DB_PASSWORD,
  );
  const importer = poolFor(process.env.IMPORT_DB_USER, process.env.IMPORT_DB_PASSWORD);
  const backup = poolFor(process.env.BACKUP_DB_USER, process.env.BACKUP_DB_PASSWORD);
  const migrator = poolFor(
    process.env.MIGRATION_DB_USER,
    process.env.MIGRATION_DB_PASSWORD,
  );
  const digestA = Buffer.alloc(32, 0x41);
  const digestB = Buffer.alloc(32, 0x42);

  try {
    const version = await owner.query("SHOW server_version_num");
    assert.equal(Number(version.rows[0].server_version_num) >= 170000, true);

    const migrations = await owner.query(
      "SELECT count(*)::integer AS count FROM schema_migrations",
    );
    assert.equal(migrations.rows[0].count, 18);

    await denied(migrator, "SELECT * FROM app_users LIMIT 1");
    const migrationRole = await migrator.query(
      `SELECT roles.rolinherit, roles.rolsuper, roles.rolcreaterole,
              roles.rolcreatedb, roles.rolreplication, roles.rolbypassrls,
              ARRAY(
                SELECT granted.rolname::text
                FROM pg_auth_members AS membership
                INNER JOIN pg_roles AS granted ON granted.oid = membership.roleid
                WHERE membership.member = roles.oid
                ORDER BY granted.rolname
              ) AS memberships
       FROM pg_roles AS roles
       WHERE roles.rolname = current_user`,
    );
    assert.deepEqual(migrationRole.rows[0], {
      rolinherit: false,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      memberships: [process.env.MIGRATION_DB_ROLE],
    });
    const schemaOwnerRole = await owner.query(
      `SELECT roles.rolcanlogin, roles.rolinherit, roles.rolsuper,
              roles.rolcreaterole, roles.rolcreatedb, roles.rolreplication,
              roles.rolbypassrls,
              (SELECT namespace.nspowner = roles.oid
               FROM pg_namespace AS namespace
               WHERE namespace.nspname = 'public') AS owns_public_schema,
              (SELECT count(*)::integer
               FROM pg_auth_members
               WHERE member = roles.oid) AS membership_count,
              (SELECT count(*)::integer
               FROM pg_class AS relation
               INNER JOIN pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'public'
                 AND relation.relkind IN ('r', 'p', 'S')
                 AND relation.relowner <> roles.oid) AS foreign_relation_count,
              (SELECT count(*)::integer
               FROM pg_proc AS procedure
               INNER JOIN pg_namespace AS namespace
                 ON namespace.oid = procedure.pronamespace
               WHERE namespace.nspname = 'public'
                 AND procedure.prokind = 'f'
                 AND procedure.proowner <> roles.oid) AS foreign_function_count
       FROM pg_roles AS roles
       WHERE roles.rolname = $1`,
      [process.env.MIGRATION_DB_ROLE],
    );
    assert.deepEqual(schemaOwnerRole.rows[0], {
      rolcanlogin: false,
      rolinherit: false,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      owns_public_schema: true,
      membership_count: 0,
      foreign_relation_count: 0,
      foreign_function_count: 0,
    });
    assert.match(process.env.MIGRATION_DB_ROLE, /^[a-z][a-z0-9_]{2,62}$/u);
    const migrationClient = await migrator.connect();
    try {
      await migrationClient.query("BEGIN");
      await migrationClient.query(`SET ROLE "${process.env.MIGRATION_DB_ROLE}"`);
      const effectiveRole = await migrationClient.query(
        `SELECT session_user, current_user,
                has_schema_privilege(current_user, 'public', 'CREATE') AS can_create`,
      );
      assert.deepEqual(effectiveRole.rows[0], {
        session_user: process.env.MIGRATION_DB_USER,
        current_user: process.env.MIGRATION_DB_ROLE,
        can_create: true,
      });
      await migrationClient.query(
        "CREATE TABLE ci_migrator_transaction_probe (id integer PRIMARY KEY)",
      );
      await migrationClient.query("ROLLBACK");
    } finally {
      migrationClient.release();
    }
    const rolledBackProbe = await owner.query(
      "SELECT to_regclass('public.ci_migrator_transaction_probe') AS relation",
    );
    assert.equal(rolledBackProbe.rows[0].relation, null);

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        runtime.query(
          `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
          ["ci-credential", digestA, 5, 1e-9],
        ),
      ),
    );
    assert.equal(
      attempts.filter((result) => result.rows[0].allowed).length,
      5,
    );

    await runtime.end();
    const restartedRuntime = poolFor(
      process.env.AUTH_DB_USER,
      process.env.AUTH_DB_PASSWORD,
    );
    try {
      const persisted = await restartedRuntime.query(
        `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
        ["ci-credential", digestA, 5, 1e-9],
      );
      assert.equal(persisted.rows[0].allowed, false);
      const separateKey = await restartedRuntime.query(
        `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
        ["ci-credential", digestB, 5, 1e-9],
      );
      const separateScope = await restartedRuntime.query(
        `SELECT consume_api_rate_limit($1, $2, $3, $4) AS allowed`,
        ["ci-password-reset", digestA, 5, 1e-9],
      );
      assert.equal(separateKey.rows[0].allowed, true);
      assert.equal(separateScope.rows[0].allowed, true);
      await denied(
        restartedRuntime,
        "SELECT * FROM api_rate_limit_buckets LIMIT 1",
      );
      await denied(
        restartedRuntime,
        "UPDATE admin_audit_events SET action = action",
      );
    } finally {
      await restartedRuntime.end();
    }

    await denied(importer, "SELECT * FROM app_users LIMIT 1");
    await denied(importer, "SELECT * FROM user_sessions LIMIT 1");
    await denied(importer, "SELECT * FROM teacher_review_candidate_decisions LIMIT 1");
    await denied(
      importer,
      `SELECT consume_api_rate_limit(
         'ci-importer-denied',
         decode(repeat('43', 32), 'hex'),
         1,
         1
       )`,
    );

    for (const [table, privilege, expected] of [
      ["teachers", "SELECT", true],
      ["teachers", "INSERT", false],
      ["teacher_source_identities", "UPDATE", false],
      ["teacher_reviews", "SELECT", true],
      ["teacher_reviews", "INSERT", true],
      ["teacher_reviews", "UPDATE", true],
      ["teacher_reviews", "DELETE", false],
      ["teacher_review_candidates", "SELECT", false],
      ["teacher_review_candidate_decisions", "SELECT", false],
      ["data_import_batches", "SELECT", false],
      ["data_import_rows", "SELECT", false],
      ["data_import_mutations", "SELECT", false],
      ["admin_audit_events", "INSERT", true],
      ["admin_audit_events", "UPDATE", false],
      ["admin_audit_events", "DELETE", false],
      ["admin_audit_events", "TRUNCATE", false],
      ["community_content_edits", "INSERT", true],
      ["community_content_edits", "UPDATE", false],
      ["community_content_edits", "DELETE", false],
      ["community_content_edits", "TRUNCATE", false],
      ["community_moderation_actions", "INSERT", true],
      ["community_moderation_actions", "DELETE", false],
      ["community_moderation_actions", "TRUNCATE", false],
      ["community_topics", "UPDATE", true],
      ["community_topics", "DELETE", false],
      ["community_topics", "TRUNCATE", false],
      ["community_comments", "DELETE", false],
      ["community_comments", "TRUNCATE", false],
      ["community_announcements", "SELECT", true],
      ["community_announcements", "INSERT", true],
      ["community_announcements", "UPDATE", false],
      ["community_announcements", "DELETE", false],
      ["community_announcements", "TRUNCATE", false],
    ]) {
      await assertTablePrivilege(aclRuntime, table, privilege, expected);
    }
    for (const [functionName, expected] of [
      [
        "list_teacher_review_candidates_for_admin(uuid,uuid,text,text,timestamptz,uuid,integer)",
        true,
      ],
      [
        "moderate_teacher_review_candidate(uuid,uuid,text,uuid,text,text,uuid,text,text)",
        true,
      ],
      ["require_elevated_teacher_review_admin(uuid,uuid,text)", false],
      ["rollback_teacher_review_candidate_for_import(uuid,uuid)", false],
    ]) {
      await assertFunctionPrivilege(aclRuntime, functionName, expected);
    }

    for (const [table, privilege, expected] of [
      ["data_import_batches", "SELECT", true],
      ["data_import_batches", "INSERT", true],
      ["data_import_batches", "UPDATE", true],
      ["data_import_batches", "DELETE", false],
      ["data_import_rows", "SELECT", true],
      ["data_import_rows", "INSERT", true],
      ["data_import_rows", "UPDATE", false],
      ["data_import_mutations", "INSERT", true],
      ["teacher_review_candidates", "SELECT", true],
      ["teacher_review_candidates", "INSERT", true],
      ["teacher_review_candidates", "UPDATE", false],
      ["teacher_review_candidate_decisions", "SELECT", false],
      ["teacher_reviews", "SELECT", true],
      ["teacher_reviews", "INSERT", false],
      ["app_users", "SELECT", false],
      ["user_sessions", "SELECT", false],
      ["admin_audit_events", "INSERT", false],
    ]) {
      await assertTablePrivilege(importer, table, privilege, expected);
    }
    for (const [functionName, expected] of [
      ["rollback_teacher_review_candidate_for_import(uuid,uuid)", true],
      [
        "list_teacher_review_candidates_for_admin(uuid,uuid,text,text,timestamptz,uuid,integer)",
        false,
      ],
      [
        "moderate_teacher_review_candidate(uuid,uuid,text,uuid,text,text,uuid,text,text)",
        false,
      ],
      [
        "consume_api_rate_limit(text,bytea,double precision,double precision)",
        false,
      ],
    ]) {
      await assertFunctionPrivilege(importer, functionName, expected);
    }
    const importerRole = await importer.query(
      `SELECT rolinherit, rolsuper, rolcreaterole, rolcreatedb, rolreplication,
              rolbypassrls,
              (SELECT count(*)::integer
               FROM pg_auth_members
               WHERE member = current_user::regrole) AS membership_count
       FROM pg_roles
       WHERE rolname = current_user`,
    );
    assert.deepEqual(importerRole.rows[0], {
      rolinherit: false,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      membership_count: 0,
    });

    for (const [table, privilege, expected] of [
      ["schema_migrations", "SELECT", true],
      ["app_users", "SELECT", true],
      ["password_credentials", "SELECT", true],
      ["admin_audit_events", "SELECT", true],
      ["community_topics", "SELECT", true],
      ["teachers", "SELECT", true],
      ["app_users", "INSERT", false],
      ["app_users", "UPDATE", false],
      ["app_users", "DELETE", false],
      ["app_users", "TRUNCATE", false],
      ["admin_audit_events", "INSERT", false],
    ]) {
      await assertTablePrivilege(backup, table, privilege, expected);
    }
    for (const functionName of [
      "consume_api_rate_limit(text,bytea,double precision,double precision)",
      "rollback_teacher_review_candidate_for_import(uuid,uuid)",
      "moderate_teacher_review_candidate(uuid,uuid,text,uuid,text,text,uuid,text,text)",
    ]) {
      await assertFunctionPrivilege(backup, functionName, false);
    }
    const backupRole = await backup.query(
      `SELECT rolinherit, rolsuper, rolcreaterole, rolcreatedb, rolreplication,
              rolbypassrls,
              (SELECT count(*)::integer
               FROM pg_auth_members
               WHERE member = current_user::regrole) AS membership_count
       FROM pg_roles
       WHERE rolname = current_user`,
    );
    assert.deepEqual(backupRole.rows[0], {
      rolinherit: false,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      membership_count: 0,
    });
  } finally {
    await Promise.allSettled([
      owner.end(),
      runtime.end(),
      aclRuntime.end(),
      importer.end(),
      backup.end(),
      migrator.end(),
    ]);
  }
});

test("academic import and review moderation serialize on PostgreSQL", {
  skip: !enabled,
  timeout: 45_000,
}, async () => {
  const owner = poolFor(process.env.POSTGRES_USER, process.env.POSTGRES_PASSWORD);
  const runtime = poolFor(process.env.AUTH_DB_USER, process.env.AUTH_DB_PASSWORD);
  const importer = poolFor(process.env.IMPORT_DB_USER, process.env.IMPORT_DB_PASSWORD);
  const adminId = randomUUID();
  const sessionId = randomUUID();
  const elevationHash = `ci-elevation-${randomUUID()}`;
  const label = randomUUID().slice(0, 8);
  const reviewStore = createTeacherReviewStore(runtime);
  const adminInput = (extra) => ({
    actorUserId: adminId,
    actorSessionId: sessionId,
    actorElevationTokenHash: elevationHash,
    ipHash: sha256(`ip:${label}`),
    userAgentHash: sha256(`user-agent:${label}`),
    ...extra,
  });

  try {
    await owner.query(
      `INSERT INTO app_users (
         id, status, display_name, role, username, normalized_username,
         registered_via
       ) VALUES ($1::uuid, 'active', $2, 'admin', $3, $3, 'credential')`,
      [adminId, `并发审核管理员-${label}`, `ci-review-admin-${label}`],
    );
    await owner.query(
      `INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
       VALUES ($1::uuid, $2::uuid, $3, now() + interval '1 hour')`,
      [sessionId, adminId, `ci-review-session-${label}`],
    );
    await owner.query(
      `INSERT INTO admin_elevated_sessions (
         user_id, base_session_id, token_hash, method, expires_at
       ) VALUES ($1::uuid, $2::uuid, $3, 'totp', now() + interval '10 minutes')`,
      [adminId, sessionId, elevationHash],
    );

    const idempotentBundle = integrationAcademicBundle(`idempotent-${label}`);
    const concurrentImports = await Promise.all([
      applyPrivateBundle(importer, idempotentBundle),
      applyPrivateBundle(importer, idempotentBundle),
    ]);
    assert.deepEqual(
      concurrentImports
        .map((result) => result.teacherBatch.idempotent)
        .sort(),
      [false, true],
    );
    assert.deepEqual(
      concurrentImports
        .map((result) => result.textbookBatch.idempotent)
        .sort(),
      [false, true],
    );
    assert.equal(
      new Set(concurrentImports.map((result) => result.teacherBatch.batchId)).size,
      1,
    );

    const idempotentCandidate = await owner.query(
      `SELECT candidate.id
       FROM teacher_review_candidates AS candidate
       INNER JOIN data_import_rows AS import_row
         ON import_row.id = candidate.import_row_id
       WHERE import_row.batch_id = $1::uuid`,
      [concurrentImports[0].teacherBatch.batchId],
    );
    assert.equal(idempotentCandidate.rowCount, 1);
    const decisionAttempts = await Promise.allSettled([
      reviewStore.moderateAdminTeacherReviewCandidate(adminInput({
        candidateId: idempotentCandidate.rows[0].id,
        decision: "approve",
        reason: "第一条并发审核请求尝试批准同一历史评价候选",
        requestId: randomUUID(),
      })),
      reviewStore.moderateAdminTeacherReviewCandidate(adminInput({
        candidateId: idempotentCandidate.rows[0].id,
        decision: "approve",
        reason: "第二条并发审核请求尝试批准同一历史评价候选",
        requestId: randomUUID(),
      })),
    ]);
    assert.equal(
      decisionAttempts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      decisionAttempts.filter(
        (result) => result.status === "rejected" &&
          result.reason?.code === "TEACHER_REVIEW_CANDIDATE_CONFLICT",
      ).length,
      1,
    );
    const singleDecision = await owner.query(
      `SELECT
         candidate.moderation_status,
         (SELECT count(*)::integer
          FROM teacher_review_candidate_decisions
          WHERE candidate_id = candidate.id) AS decision_count,
         (SELECT count(*)::integer
          FROM teacher_reviews
          WHERE import_candidate_id = candidate.id) AS review_count
       FROM teacher_review_candidates AS candidate
       WHERE candidate.id = $1::uuid`,
      [idempotentCandidate.rows[0].id],
    );
    assert.deepEqual(singleDecision.rows[0], {
      moderation_status: "approved",
      decision_count: 1,
      review_count: 1,
    });

    const raceBundle = integrationAcademicBundle(`rollback-${label}`);
    const raceImport = await applyPrivateBundle(importer, raceBundle);
    const raceCandidate = await owner.query(
      `SELECT candidate.id
       FROM teacher_review_candidates AS candidate
       INNER JOIN data_import_rows AS import_row
         ON import_row.id = candidate.import_row_id
       WHERE import_row.batch_id = $1::uuid`,
      [raceImport.teacherBatch.batchId],
    );
    assert.equal(raceCandidate.rowCount, 1);
    const moderationRollbackRace = await Promise.allSettled([
      reviewStore.moderateAdminTeacherReviewCandidate(adminInput({
        candidateId: raceCandidate.rows[0].id,
        decision: "approve",
        reason: "并发审核与导入回滚只能有一条状态路径成功提交",
        requestId: randomUUID(),
      })),
      rollbackImportBatch(importer, raceImport.teacherBatch.batchId),
    ]);
    assert.equal(
      moderationRollbackRace.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      moderationRollbackRace.filter((result) => result.status === "rejected").length,
      1,
    );

    const raceState = await owner.query(
      `SELECT
         batch.status AS batch_status,
         candidate.moderation_status,
         (SELECT count(*)::integer
          FROM teacher_review_candidate_decisions
          WHERE candidate_id = candidate.id) AS decision_count,
         (SELECT count(*)::integer
          FROM teacher_reviews
          WHERE import_candidate_id = candidate.id) AS review_count
       FROM data_import_batches AS batch
       INNER JOIN data_import_rows AS import_row ON import_row.batch_id = batch.id
       INNER JOIN teacher_review_candidates AS candidate
         ON candidate.import_row_id = import_row.id
       WHERE batch.id = $1::uuid`,
      [raceImport.teacherBatch.batchId],
    );
    assert.equal(raceState.rowCount, 1);
    if (raceState.rows[0].batch_status === "applied") {
      assert.deepEqual(raceState.rows[0], {
        batch_status: "applied",
        moderation_status: "approved",
        decision_count: 1,
        review_count: 1,
      });
    } else {
      assert.deepEqual(raceState.rows[0], {
        batch_status: "rolled_back",
        moderation_status: "rolled_back",
        decision_count: 0,
        review_count: 0,
      });
    }

    const concurrentLabel = `textbook-race-${label}`;
    const concurrentTextbooks = await Promise.all([
      applyPrivateBundle(importer, integrationTextbookBundle(concurrentLabel, "X")),
      applyPrivateBundle(importer, integrationTextbookBundle(concurrentLabel, "Y")),
    ]);
    assert.deepEqual(
      concurrentTextbooks.map((result) => result.textbookBatch.idempotent),
      [false, false],
    );
    const concurrentState = await owner.query(
      `SELECT record_status, material_sha256
       FROM teaching_section_textbooks
       WHERE course_id = $1
       ORDER BY created_at, id`,
      [`CI-COURSE-${concurrentLabel}`],
    );
    assert.equal(concurrentState.rowCount, 2);
    assert.equal(
      concurrentState.rows.filter((row) => row.record_status === "current").length,
      1,
    );
    assert.equal(
      concurrentState.rows.filter((row) => row.record_status === "superseded").length,
      1,
    );

    const cycleLabel = `textbook-cycle-${label}`;
    await applyPrivateBundle(importer, integrationTextbookBundle(cycleLabel, "A"));
    await applyPrivateBundle(importer, integrationTextbookBundle(cycleLabel, "B"));
    await applyPrivateBundle(importer, integrationTextbookBundle(cycleLabel, "A-again", "A"));
    const expectedA = sha256("material:A");
    const cycleState = await owner.query(
      `SELECT material_sha256, record_status
       FROM teaching_section_textbooks
       WHERE course_id = $1
       ORDER BY created_at, id`,
      [`CI-COURSE-${cycleLabel}`],
    );
    assert.equal(cycleState.rowCount, 3);
    assert.equal(
      cycleState.rows.filter((row) => row.record_status === "current").length,
      1,
    );
    assert.equal(
      cycleState.rows.find((row) => row.record_status === "current").material_sha256,
      expectedA,
    );

    const restoreBundle = integrationAcademicBundle(`teacher-restore-${label}`);
    const restoreFirst = await applyPrivateBundle(importer, restoreBundle);
    const originalTeacher = await owner.query(
      `SELECT teacher.id
       FROM teachers AS teacher
       INNER JOIN teacher_source_identities AS source_identity
         ON source_identity.teacher_id = teacher.id
       WHERE source_identity.external_teacher_key = $1`,
      [restoreBundle.teachers[0].externalTeacherKey],
    );
    await rollbackImportBatch(importer, restoreFirst.teacherBatch.batchId);
    const restoreSecond = await applyPrivateBundle(importer, restoreBundle);
    assert.equal(restoreSecond.teacherBatch.idempotent, false);
    const restoredTeacher = await owner.query(
      `SELECT teacher.id, teacher.identity_status, source_identity.mapping_status
       FROM teachers AS teacher
       INNER JOIN teacher_source_identities AS source_identity
         ON source_identity.teacher_id = teacher.id
       WHERE source_identity.external_teacher_key = $1`,
      [restoreBundle.teachers[0].externalTeacherKey],
    );
    assert.deepEqual(restoredTeacher.rows[0], {
      id: originalTeacher.rows[0].id,
      identity_status: "pending",
      mapping_status: "current",
    });
  } finally {
    await Promise.allSettled([owner.end(), runtime.end(), importer.end()]);
  }
});

test("real auth, community, and admin HTTP flows persist on PostgreSQL", {
  skip: !enabled,
  timeout: 45_000,
}, async () => {
  const config = integrationConfig();
  const fixtureOwner = poolFor(
    process.env.POSTGRES_USER,
    process.env.POSTGRES_PASSWORD,
  );
  const store = createAuthStore(createDatabasePool(config));
  const adminSecurity = createAdminSecurity({
    activeKeyId: config.adminMfaActiveKeyId,
    keyring: config.adminMfaKeys,
    recoveryPepper: config.adminRecoveryPepper,
  });
  const server = createAuthServer({
    store,
    config,
    wechatProvider: createWechatProvider(config),
    passwordService: createPasswordService(),
    avatarProcessor: createAvatarProcessor(),
    adminSecurity,
    rateLimiters: createApiRateLimiters({ store }),
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const suffix = randomUUID().slice(0, 8);
  const teacherName = `原生同名教师-${suffix}`;
  const teacherId = randomUUID();
  const sameNameTeacherId = randomUUID();
  const requestHeaders = {
    "Content-Type": "application/json",
    Origin: "https://dufesh.cn",
  };

  async function register(label) {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        username: `ci-${label}-${suffix}`,
        email: `ci-${label}-${suffix}@example.com`,
        password: "Moonlight!2026",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.authenticated, true);
    assert.equal(body.user.username, `ci-${label}-${suffix}`);
    const cookie = cookieHeader(response);
    assert.match(cookie, /__Host-dufesh_session=/u);
    assert.match(cookie, /__Host-dufesh_device=/u);
    return { body, cookie };
  }

  try {
    await fixtureOwner.query(
      `INSERT INTO teachers (
         id, display_name, normalized_name, college_name,
         normalized_college, identity_status
       ) VALUES
         ($1::uuid, $2, $3, $4, $5, 'active'),
         ($6::uuid, $2, $3, $7, $8, 'active')`,
      [
        teacherId,
        teacherName,
        teacherName.toLocaleLowerCase("zh-CN"),
        `测试学院甲-${suffix}`,
        `测试学院甲-${suffix}`.toLocaleLowerCase("zh-CN"),
        sameNameTeacherId,
        `测试学院乙-${suffix}`,
        `测试学院乙-${suffix}`.toLocaleLowerCase("zh-CN"),
      ],
    );

    const owner = await register("owner");
    const replier = await register("replier");
    const administrator = await register("admin");

    const health = await fetch(`${baseUrl}/api/auth/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const sameNameIndex = await fetch(
      `${baseUrl}/api/teachers?${new URLSearchParams({ q: teacherName, limit: "10" })}`,
    );
    const sameNameIndexBody = await sameNameIndex.json();
    assert.equal(sameNameIndex.status, 200);
    assert.equal(sameNameIndexBody.items.length, 2);
    const indexedTeacher = sameNameIndexBody.items.find(
      (teacher) => teacher.id === teacherId,
    );
    const indexedSameNameTeacher = sameNameIndexBody.items.find(
      (teacher) => teacher.id === sameNameTeacherId,
    );
    assert.deepEqual(
      {
        name: indexedTeacher?.displayName,
        college: indexedTeacher?.collegeName,
      },
      { name: teacherName, college: `测试学院甲-${suffix}` },
    );
    assert.deepEqual(
      {
        name: indexedSameNameTeacher?.displayName,
        college: indexedSameNameTeacher?.collegeName,
      },
      { name: teacherName, college: `测试学院乙-${suffix}` },
    );

    const sameNameDetails = await Promise.all(
      [teacherId, sameNameTeacherId].map((id) =>
        fetch(`${baseUrl}/api/teachers/${id}`).then(async (response) => ({
          status: response.status,
          body: await response.json(),
        })),
      ),
    );
    assert.deepEqual(
      sameNameDetails.map(({ status, body }) => ({
        status,
        id: body.teacher.id,
        college: body.teacher.collegeName,
      })),
      [
        { status: 200, id: teacherId, college: `测试学院甲-${suffix}` },
        { status: 200, id: sameNameTeacherId, college: `测试学院乙-${suffix}` },
      ],
    );

    const ownerSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: owner.cookie },
    });
    const ownerSessionBody = await ownerSession.json();
    assert.equal(ownerSession.status, 200);
    assert.equal(ownerSessionBody.authenticated, true);
    assert.equal(ownerSessionBody.user.id, owner.body.user.id);

    const verificationRequest = await fetch(
      `${baseUrl}/api/auth/email/verification/request`,
      {
        method: "POST",
        headers: { Origin: "https://dufesh.cn", Cookie: owner.cookie },
      },
    );
    const verificationRequestBody = await verificationRequest.json();
    assert.equal(verificationRequest.status, 202);
    assert.match(verificationRequestBody.debugToken, /^[A-Za-z0-9_-]{43}$/u);
    const verificationAttempts = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetch(`${baseUrl}/api/auth/email/verification/confirm`, {
          method: "POST",
          headers: { ...requestHeaders, Cookie: owner.cookie },
          body: JSON.stringify({ token: verificationRequestBody.debugToken }),
        })
      ),
    );
    assert.deepEqual(
      verificationAttempts.map((response) => response.status).sort(),
      [200, 400],
    );
    const verifiedSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: owner.cookie },
    });
    assert.equal((await verifiedSession.json()).user.emailVerified, true);

    const forbiddenAdmin = await fetch(`${baseUrl}/api/admin/session`, {
      headers: { Cookie: owner.cookie },
    });
    assert.equal(forbiddenAdmin.status, 403);
    assert.deepEqual(await forbiddenAdmin.json(), { error: "admin_forbidden" });

    const topicResponse = await fetch(`${baseUrl}/api/community/topics`, {
      method: "POST",
      headers: { ...requestHeaders, Cookie: owner.cookie },
      body: JSON.stringify({
        title: "PostgreSQL 集成测试主题",
        body: "这条主题通过真实 HTTP、会话与数据库写入。",
        visibility: "public",
      }),
    });
    const topicBody = await topicResponse.json();
    assert.equal(topicResponse.status, 201);
    assert.equal(topicBody.topic.version, 1);

    const unauthorizedEdit = await fetch(
      `${baseUrl}/api/community/topics/${topicBody.topic.id}`,
      {
        method: "PATCH",
        headers: { ...requestHeaders, Cookie: replier.cookie },
        body: JSON.stringify({
          body: "另一个账号不能改写原作者主题。",
          version: 1,
        }),
      },
    );
    assert.equal(unauthorizedEdit.status, 404);
    assert.deepEqual(await unauthorizedEdit.json(), {
      error: "community_content_not_found",
    });

    const replyResponse = await fetch(
      `${baseUrl}/api/community/topics/${topicBody.topic.id}/comments`,
      {
        method: "POST",
        headers: { ...requestHeaders, Cookie: replier.cookie },
        body: JSON.stringify({ body: "这是第二个真实账号提交的回复。" }),
      },
    );
    const replyBody = await replyResponse.json();
    assert.equal(replyResponse.status, 201);
    assert.equal(replyBody.comment.version, 1);

    const topicAfterEditAttempt = await fetch(
      `${baseUrl}/api/community/topics/${topicBody.topic.id}`,
      { headers: { Cookie: replier.cookie } },
    );
    const topicAfterEditAttemptBody = await topicAfterEditAttempt.json();
    assert.equal(topicAfterEditAttempt.status, 200);
    assert.equal(
      topicAfterEditAttemptBody.topic.author.id,
      owner.body.user.id,
    );
    assert.equal(
      topicAfterEditAttemptBody.topic.body,
      "这条主题通过真实 HTTP、会话与数据库写入。",
    );

    const comments = await fetch(
      `${baseUrl}/api/community/topics/${topicBody.topic.id}/comments`,
      { headers: { Cookie: owner.cookie } },
    );
    const commentsBody = await comments.json();
    assert.equal(comments.status, 200);
    assert.equal(commentsBody.items.length, 1);
    assert.equal(commentsBody.items[0].id, replyBody.comment.id);
    assert.equal(commentsBody.items[0].author.id, replier.body.user.id);

    const unread = await fetch(
      `${baseUrl}/api/community/notifications/unread-count`,
      { headers: { Cookie: owner.cookie } },
    );
    assert.equal(unread.status, 200);
    assert.deepEqual(await unread.json(), { unread: 1 });

    const notifications = await fetch(
      `${baseUrl}/api/community/notifications?limit=10`,
      { headers: { Cookie: owner.cookie } },
    );
    const notificationsBody = await notifications.json();
    assert.equal(notifications.status, 200);
    assert.equal(notificationsBody.items.length, 1);
    assert.equal(notificationsBody.items[0].type, "topic_reply");
    assert.equal(notificationsBody.items[0].actor.id, replier.body.user.id);

    const marked = await fetch(
      `${baseUrl}/api/community/notifications/${notificationsBody.items[0].id}`,
      {
        method: "PUT",
        headers: { Origin: "https://dufesh.cn", Cookie: owner.cookie },
      },
    );
    assert.equal(marked.status, 200);

    const afterRead = await fetch(
      `${baseUrl}/api/community/notifications/unread-count`,
      { headers: { Cookie: owner.cookie } },
    );
    assert.deepEqual(await afterRead.json(), { unread: 0 });

    const syncState = {
      profile: {
        entranceYear: 2026,
        college: "测试学院",
        majorId: "ci-major",
        className: "测试2601",
      },
      skipped: false,
      plans: [{
        id: "default",
        name: "默认课表",
        scheduleIds: ["ci-section-meeting-1", "ci-section-meeting-2"],
      }],
      activePlanId: "default",
      activities: [],
      assignments: [],
      favoriteRooms: ["之远楼401"],
      recentRooms: ["笃行楼302"],
      preferredTerm: "fall",
      theme: "system",
    };
    const syncMutation = {
      mutationId: `ci-sync-${suffix}-0001`,
      baseRevision: 0,
      clientUpdatedAt: new Date().toISOString(),
      state: syncState,
    };
    const syncWrite = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: { ...requestHeaders, Cookie: owner.cookie },
      body: JSON.stringify(syncMutation),
    });
    const syncWriteBody = await syncWrite.json();
    assert.equal(syncWrite.status, 200);
    assert.equal(syncWriteBody.revision, 1);
    assert.equal(syncWriteBody.state.plans[0].scheduleIds.length, 2);

    const syncRetry = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: { ...requestHeaders, Cookie: owner.cookie },
      body: JSON.stringify(syncMutation),
    });
    assert.equal(syncRetry.status, 200);
    assert.equal((await syncRetry.json()).deduplicated, true);

    const isolatedSync = await fetch(`${baseUrl}/api/auth/sync`, {
      headers: { Cookie: replier.cookie },
    });
    const isolatedSyncBody = await isolatedSync.json();
    assert.equal(isolatedSync.status, 200);
    assert.equal(isolatedSyncBody.revision, 0);

    const staleSync = await fetch(`${baseUrl}/api/auth/sync`, {
      method: "PUT",
      headers: { ...requestHeaders, Cookie: owner.cookie },
      body: JSON.stringify({
        ...syncMutation,
        mutationId: `ci-sync-${suffix}-0002`,
      }),
    });
    assert.equal(staleSync.status, 409);
    assert.equal((await staleSync.json()).revision, 1);

    const ratings = {
      courseOrganization: 5,
      contentClarity: 4,
      assessmentExplanation: 4,
      classroomInteraction: 3,
      materialCompleteness: 5,
    };
    const reviewCreated = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/my-review`,
      {
        method: "PUT",
        headers: { ...requestHeaders, Cookie: owner.cookie },
        body: JSON.stringify({
          body: "课程结构清楚，课堂示例能帮助理解概念之间的关系。",
          ratings,
        }),
      },
    );
    const reviewCreatedBody = await reviewCreated.json();
    assert.equal(reviewCreated.status, 201);
    assert.equal(reviewCreatedBody.review.version, 1);

    const otherUsersReview = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/my-review`,
      { headers: { Cookie: replier.cookie } },
    );
    assert.equal(otherUsersReview.status, 200);
    assert.deepEqual(await otherUsersReview.json(), { review: null });

    const competingUpdates = await Promise.all([
      "第一次并发更新补充了作业反馈与课堂节奏。",
      "第二次并发更新补充了例题难度与讲解速度。",
    ].map((body) =>
      fetch(`${baseUrl}/api/teachers/${teacherId}/my-review`, {
        method: "PUT",
        headers: { ...requestHeaders, Cookie: owner.cookie },
        body: JSON.stringify({ body, ratings, expectedVersion: 1 }),
      })
    ));
    assert.deepEqual(
      competingUpdates.map((response) => response.status).sort(),
      [200, 409],
    );

    const publicReviews = await fetch(
      `${baseUrl}/api/teachers/${teacherId}/reviews?limit=20`,
    );
    const publicReviewsBody = await publicReviews.json();
    assert.equal(publicReviews.status, 200);
    assert.equal(publicReviewsBody.items.length, 1);
    assert.equal(publicReviewsBody.items[0].sourceType, "user");

    const isolatedSameNameReviews = await fetch(
      `${baseUrl}/api/teachers/${sameNameTeacherId}/reviews?limit=20`,
    );
    assert.equal(isolatedSameNameReviews.status, 200);
    assert.deepEqual(await isolatedSameNameReviews.json(), {
      items: [],
      nextCursor: null,
    });

    const isolatedSameNameOwnReview = await fetch(
      `${baseUrl}/api/teachers/${sameNameTeacherId}/my-review`,
      { headers: { Cookie: owner.cookie } },
    );
    assert.equal(isolatedSameNameOwnReview.status, 200);
    assert.deepEqual(await isolatedSameNameOwnReview.json(), { review: null });

    const enrollment = adminSecurity.createEnrollment({
      userId: administrator.body.user.id,
      accountLabel: administrator.body.user.email,
    });
    await store.bootstrapAdmin({
      userId: administrator.body.user.id,
      enrollment,
    });

    const revokedBootstrapSession = await fetch(
      `${baseUrl}/api/auth/session`,
      { headers: { Cookie: administrator.cookie } },
    );
    assert.equal(revokedBootstrapSession.status, 200);
    assert.equal((await revokedBootstrapSession.json()).authenticated, false);

    const adminLogins = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({
            identifier: `ci-admin-${suffix}@example.com`,
            password: "Moonlight!2026",
          }),
        })
      ),
    );
    assert.deepEqual(adminLogins.map((response) => response.status), [200, 200]);
    const adminBaseCookies = adminLogins.map(cookieHeader);

    const totp = adminSecurityTest.codeForStep(
      enrollment.secret,
      Math.floor(Date.now() / 1_000 / 30),
    );
    const elevationAttempts = await Promise.all(
      adminBaseCookies.map((cookie) =>
        fetch(`${baseUrl}/api/admin/elevation`, {
          method: "POST",
          headers: { ...requestHeaders, Cookie: cookie },
          body: JSON.stringify({ code: totp }),
        })
      ),
    );
    assert.deepEqual(
      elevationAttempts.map((response) => response.status).sort(),
      [200, 403],
    );
    const elevationIndex = elevationAttempts.findIndex(
      (response) => response.status === 200,
    );
    const elevation = elevationAttempts[elevationIndex];
    const adminBaseCookie = adminBaseCookies[elevationIndex];
    const elevationCookie = cookieHeader(elevation);
    assert.match(elevationCookie, /__Host-dufesh_admin_elevation=/u);
    const totpElevatedAdminCookie = `${adminBaseCookie}; ${elevationCookie}`;

    const recoveryAttempts = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetch(`${baseUrl}/api/admin/elevation`, {
          method: "POST",
          headers: { ...requestHeaders, Cookie: adminBaseCookie },
          body: JSON.stringify({ code: enrollment.recoveryCodes[0] }),
        })
      ),
    );
    assert.deepEqual(
      recoveryAttempts.map((response) => response.status).sort(),
      [200, 403],
    );
    const recoveryIndex = recoveryAttempts.findIndex(
      (response) => response.status === 200,
    );
    const recoveryElevationCookie = cookieHeader(
      recoveryAttempts[recoveryIndex],
    );
    assert.match(
      recoveryElevationCookie,
      /__Host-dufesh_admin_elevation=/u,
    );
    const elevatedAdminCookie =
      `${adminBaseCookie}; ${recoveryElevationCookie}`;

    const revokedTotpElevation = await fetch(
      `${baseUrl}/api/admin/session`,
      { headers: { Cookie: totpElevatedAdminCookie } },
    );
    assert.equal(revokedTotpElevation.status, 200);
    assert.equal((await revokedTotpElevation.json()).elevated, false);

    const adminSession = await fetch(`${baseUrl}/api/admin/session`, {
      headers: { Cookie: elevatedAdminCookie },
    });
    assert.equal(adminSession.status, 200);
    const adminSessionBody = await adminSession.json();
    assert.deepEqual(
      { role: adminSessionBody.role, elevated: adminSessionBody.elevated },
      { role: "admin", elevated: true },
    );

    const reportResponse = await fetch(`${baseUrl}/api/community/reports`, {
      method: "POST",
      headers: { ...requestHeaders, Cookie: replier.cookie },
      body: JSON.stringify({
        targetType: "topic",
        targetId: topicBody.topic.id,
        reasonCode: "spam",
        detail: "原生 PostgreSQL 管理流程使用的测试举报。",
      }),
    });
    const reportBody = await reportResponse.json();
    assert.equal(reportResponse.status, 201);
    await assert.rejects(
      fixtureOwner.query(
        `UPDATE community_reports
         SET evidence_body = 'tampered evidence'
         WHERE id = $1::uuid`,
        [reportBody.report.id],
      ),
      (error) => error?.code === "P0001",
    );

    const reports = await fetch(
      `${baseUrl}/api/admin/community/reports?status=open`,
      { headers: { Cookie: elevatedAdminCookie } },
    );
    const reportsBody = await reports.json();
    assert.equal(reports.status, 200);
    assert.equal(reportsBody.reports.length, 1);
    assert.equal(reportsBody.reports[0].id, reportBody.report.id);
    assert.equal(reportsBody.reports[0].evidenceBody.includes("真实 HTTP"), true);

    const openedCase = await fetch(
      `${baseUrl}/api/admin/community/reports/${reportBody.report.id}/case`,
      {
        method: "POST",
        headers: { ...requestHeaders, Cookie: elevatedAdminCookie },
        body: JSON.stringify({ reason: "测试举报进入管理员人工复核流程" }),
      },
    );
    const openedCaseBody = await openedCase.json();
    assert.equal(openedCase.status, 200);
    assert.equal(openedCaseBody.case.status, "reviewing");

    await fixtureOwner.query(
      "DROP TRIGGER IF EXISTS ci_reject_community_hide_audit ON admin_audit_events",
    );
    await fixtureOwner.query(
      "DROP FUNCTION IF EXISTS ci_reject_community_hide_audit()",
    );
    await fixtureOwner.query(
      `CREATE OR REPLACE FUNCTION ci_reject_community_hide_audit()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF NEW.action = 'admin.community.hide' THEN
           RAISE EXCEPTION 'ci injected admin audit failure';
         END IF;
         RETURN NEW;
       END
       $$`,
    );
    await fixtureOwner.query(
      `CREATE TRIGGER ci_reject_community_hide_audit
       BEFORE INSERT ON admin_audit_events
       FOR EACH ROW
       EXECUTE FUNCTION ci_reject_community_hide_audit()`,
    );
    try {
      const rejectedHide = await fetch(
        `${baseUrl}/api/admin/community/cases/${openedCaseBody.case.id}/actions`,
        {
          method: "POST",
          headers: { ...requestHeaders, Cookie: elevatedAdminCookie },
          body: JSON.stringify({
            action: "hide",
            reason: "故障注入必须回滚内容、案件、举报、通知和双审计",
          }),
        },
      );
      assert.equal(rejectedHide.status, 503);
      assert.deepEqual(await rejectedHide.json(), {
        error: "service_unavailable",
      });

      const rolledBackModeration = await fixtureOwner.query(
        `SELECT
           topics.status AS topic_status,
           topics.version::integer AS topic_version,
           cases.status AS case_status,
           reports.status AS report_status,
           (SELECT count(*)::integer
            FROM community_moderation_actions
            WHERE case_id = $2::uuid AND action = 'hide') AS action_count,
           (SELECT count(*)::integer
            FROM admin_audit_events
            WHERE action = 'admin.community.hide'
              AND target_id = $1::text) AS audit_count,
           (SELECT count(*)::integer
            FROM community_notifications
            WHERE topic_id = $1::uuid AND body IS NOT NULL) AS original_notification_count
         FROM community_topics AS topics
         JOIN community_moderation_cases AS cases ON cases.id = $2::uuid
         JOIN community_reports AS reports ON reports.id = $3::uuid
         WHERE topics.id = $1::uuid`,
        [topicBody.topic.id, openedCaseBody.case.id, reportBody.report.id],
      );
      assert.deepEqual(rolledBackModeration.rows[0], {
        topic_status: "published",
        topic_version: 1,
        case_status: "reviewing",
        report_status: "reviewing",
        action_count: 0,
        audit_count: 0,
        original_notification_count: 1,
      });
    } finally {
      await fixtureOwner.query(
        "DROP TRIGGER IF EXISTS ci_reject_community_hide_audit ON admin_audit_events",
      );
      await fixtureOwner.query(
        "DROP FUNCTION IF EXISTS ci_reject_community_hide_audit()",
      );
    }

    const hidden = await fetch(
      `${baseUrl}/api/admin/community/cases/${openedCaseBody.case.id}/actions`,
      {
        method: "POST",
        headers: { ...requestHeaders, Cookie: elevatedAdminCookie },
        body: JSON.stringify({
          action: "hide",
          reason: "验证隐藏、通知与双审计位于同一事务",
        }),
      },
    );
    const hiddenBody = await hidden.json();
    assert.equal(hidden.status, 200);
    assert.equal(hiddenBody.case.action, "hide");

    const hiddenTopic = await fetch(
      `${baseUrl}/api/community/topics/${topicBody.topic.id}`,
    );
    assert.equal(hiddenTopic.status, 404);
    assert.deepEqual(await hiddenTopic.json(), {
      error: "community_topic_unavailable",
      status: "hidden",
      fallbackPath: "/community",
    });

    const audit = await fetch(`${baseUrl}/api/admin/audit`, {
      headers: { Cookie: elevatedAdminCookie },
    });
    const auditBody = await audit.json();
    assert.equal(audit.status, 200);
    assert.equal(
      auditBody.events.some(
        (event) => event.action === "admin.community.hide",
      ),
      true,
    );

    const deletedAccount = await fetch(
      `${baseUrl}/api/auth/account/delete`,
      {
        method: "POST",
        headers: { ...requestHeaders, Cookie: owner.cookie },
        body: JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT" }),
      },
    );
    assert.equal(deletedAccount.status, 200);

    const retainedEvidence = await fixtureOwner.query(
      `SELECT
         reports.evidence_body,
         reports.evidence_author_label,
         (SELECT count(*)::integer FROM app_users WHERE id = $2::uuid)
           AS remaining_user,
         (SELECT count(*)::integer
          FROM admin_audit_events
          WHERE action = 'admin.community.hide'
            AND target_id = $3::text) AS audit_count
       FROM community_reports AS reports
       WHERE reports.id = $1::uuid`,
      [reportBody.report.id, owner.body.user.id, topicBody.topic.id],
    );
    assert.equal(retainedEvidence.rowCount, 1);
    assert.equal(
      retainedEvidence.rows[0].evidence_body.includes("真实 HTTP"),
      true,
    );
    assert.equal(
      retainedEvidence.rows[0].evidence_author_label.includes("ci-owner"),
      true,
    );
    assert.equal(retainedEvidence.rows[0].remaining_user, 0);
    assert.equal(Number(retainedEvidence.rows[0].audit_count) >= 1, true);
  } finally {
    await closeServer(server);
    await store.close();
    await fixtureOwner.end();
  }
});
