import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { applyPrivateBundle } from "../scripts/academic-import-apply.mjs";
import { createTeacherReviewStore } from "../services/auth-api/src/teacher-review-store.mjs";
import { createTeacherStore } from "../services/auth-api/src/teacher-store.mjs";

const ids = {
  admin: "00000000-0000-4000-8000-000000000101",
  session: "00000000-0000-4000-8000-000000000102",
};
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

function bundle() {
  return {
    schemaVersion: 1,
    mappingVersion: "moderation-fixture-v1",
    private: true,
    sources: {
      teacher: { filename: "teachers.xlsx", sha256: digest("a") },
      textbook: { filename: "textbooks.xlsx", sha256: digest("b") },
    },
    teachers: [{
      sourceLocator: "做在这个表!C2",
      externalTeacherKey: "teacher-1",
      displayName: "审核测试教师",
      collegeName: "审核测试学院",
      sourceDigest: digest("c"),
    }],
    reviewCandidates: ["第一条脱敏历史评价", "第二条脱敏历史评价", "第三条脱敏历史评价"].map(
      (sanitizedBody, index) => ({
        sourceLocator: `做在这个表!${String.fromCharCode(68 + index)}2`,
        sourceRow: 2,
        sourceColumn: 4 + index,
        externalTeacherKey: "teacher-1",
        sanitizedBody,
        originalBodySha256: digest(String(index + 1)),
        normalizedBodySha256: digest(String(index + 4)),
        riskFlags: index === 0 ? ["time_sensitive_assessment_claim"] : [],
      }),
    ),
    textbooks: [],
  };
}

async function seedAdmin(database) {
  await database.query(
    `INSERT INTO app_users (
       id, status, display_name, role, username, normalized_username, registered_via
     ) VALUES ($1, 'active', '审核管理员', 'admin', 'review-admin', 'review-admin', 'credential')`,
    [ids.admin],
  );
  await database.query(
    `INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, 'session-hash', now() + interval '1 hour')`,
    [ids.session, ids.admin],
  );
  await database.query(
    `INSERT INTO admin_elevated_sessions (
       user_id, base_session_id, token_hash, method, expires_at
     ) VALUES ($1, $2, 'elevation-hash', 'totp', now() + interval '10 minutes')`,
    [ids.admin, ids.session],
  );
}

function adminInput(extra = {}) {
  return {
    actorUserId: ids.admin,
    actorSessionId: ids.session,
    actorElevationTokenHash: "elevation-hash",
    ...extra,
  };
}

test("teacher review decisions publish once, reject privately, and audit atomically", async () => {
  const database = await createDatabase();
  try {
    await applyPrivateBundle(database, bundle());
    await seedAdmin(database);
    const store = createTeacherReviewStore(database);
    const candidates = await store.listAdminTeacherReviewCandidates(adminInput({
      status: "pending",
      afterCreatedAt: null,
      afterId: null,
      limit: 50,
    }));
    assert.equal(candidates.length, 3);
    const firstCandidate = candidates.find((candidate) => candidate.body === "第一条脱敏历史评价");
    const secondCandidate = candidates.find((candidate) => candidate.body === "第二条脱敏历史评价");
    const thirdCandidate = candidates.find((candidate) => candidate.body === "第三条脱敏历史评价");
    assert.ok(firstCandidate && secondCandidate && thirdCandidate);
    assert.equal(firstCandidate.teacher.displayName, "审核测试教师");

    await assert.rejects(
      store.listAdminTeacherReviewCandidates({
        ...adminInput({ status: "pending", afterCreatedAt: null, afterId: null, limit: 50 }),
        actorElevationTokenHash: "wrong-elevation",
      }),
      (error) => error.code === "AUTH_ADMIN_FORBIDDEN",
    );

    const firstRequestId = "00000000-0000-4000-8000-000000000103";
    const approved = await store.moderateAdminTeacherReviewCandidate(adminInput({
      candidateId: firstCandidate.id,
      decision: "approve",
      reason: "人工核对后确认可以作为历史整理内容公开",
      requestId: firstRequestId,
      ipHash: digest("d"),
      userAgentHash: digest("e"),
    }));
    assert.equal(approved.status, "approved");
    assert.ok(approved.publicReviewId);
    const publicStore = createTeacherStore(database);
    const publicTeachers = await publicStore.listPublicTeachers({
      query: "审核测试教师",
      college: "",
      after: null,
      limit: 30,
    });
    assert.equal(publicTeachers.length, 1);
    assert.equal(publicTeachers[0].reviewCount, 1);
    const publicDetail = await publicStore.getPublicTeacherDetail(publicTeachers[0].id);
    assert.equal(publicDetail.reviewCount, 1);
    assert.deepEqual(Object.values(publicDetail.ratings), [null, null, null, null, null]);
    const publicReviews = await publicStore.listPublicTeacherReviews({
      teacherId: publicTeachers[0].id,
      after: null,
      limit: 20,
    });
    assert.equal(publicReviews[0].body, "第一条脱敏历史评价");
    assert.equal(publicReviews[0].authorLabel, "历史整理内容");
    await assert.rejects(
      store.moderateAdminTeacherReviewCandidate(adminInput({
        candidateId: firstCandidate.id,
        decision: "reject",
        reason: "不能覆盖已经完成的第一次人工审核决定",
        requestId: "00000000-0000-4000-8000-000000000104",
        ipHash: digest("d"),
        userAgentHash: digest("e"),
      })),
      (error) => error.code === "TEACHER_REVIEW_CANDIDATE_CONFLICT",
    );

    const rejected = await store.moderateAdminTeacherReviewCandidate(adminInput({
      candidateId: secondCandidate.id,
      decision: "reject",
      reason: "内容缺少可核验上下文，因此不适合进入公开页面",
      requestId: "00000000-0000-4000-8000-000000000105",
      ipHash: digest("d"),
      userAgentHash: digest("e"),
    }));
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.publicReviewId, null);

    await assert.rejects(
      store.moderateAdminTeacherReviewCandidate(adminInput({
        candidateId: thirdCandidate.id,
        decision: "approve",
        reason: "故意复用审计请求号以验证整个审核语句原子回滚",
        requestId: firstRequestId,
        ipHash: digest("d"),
        userAgentHash: digest("e"),
      })),
    );
    const rolledBackDecision = await database.query(
      `SELECT moderation_status,
              EXISTS (SELECT 1 FROM teacher_review_candidate_decisions WHERE candidate_id = $1) AS has_decision,
              EXISTS (SELECT 1 FROM teacher_reviews WHERE import_candidate_id = $1) AS has_review
       FROM teacher_review_candidates WHERE id = $1`,
      [thirdCandidate.id],
    );
    assert.deepEqual(rolledBackDecision.rows[0], {
      moderation_status: "pending",
      has_decision: false,
      has_review: false,
    });

    const totals = await database.query(
      `SELECT
         (SELECT count(*)::int FROM teacher_review_candidate_decisions) AS decisions,
         (SELECT count(*)::int FROM teacher_reviews) AS public_reviews,
         (SELECT count(*)::int FROM admin_audit_events WHERE action LIKE 'admin.teacher_review.%') AS audits`,
    );
    assert.deepEqual(totals.rows[0], { decisions: 2, public_reviews: 1, audits: 2 });
    await assert.rejects(
      database.query("DELETE FROM teacher_review_candidate_decisions"),
      /append-only/,
    );
  } finally {
    await database.close();
  }
});
