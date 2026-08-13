import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { createTeacherStore } from "../services/auth-api/src/teacher-store.mjs";

const teacherId = "00000000-0000-4000-8000-000000000301";
const userA = "00000000-0000-4000-8000-000000000302";
const userB = "00000000-0000-4000-8000-000000000303";

async function createDatabase() {
  const database = new PGlite();
  await database.waitReady;
  const directory = path.resolve("ops/postgres/migrations");
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    await database.exec(await fs.readFile(path.join(directory, file), "utf8"));
  }
  await database.query(
    `INSERT INTO app_users (
       id, status, display_name, role, username, normalized_username, registered_via
     ) VALUES
       ($1, 'active', '用户甲', 'user', 'teacher-user-a', 'teacher-user-a', 'credential'),
       ($2, 'active', '用户乙', 'user', 'teacher-user-b', 'teacher-user-b', 'credential')`,
    [userA, userB],
  );
  await database.query(
    `INSERT INTO teachers (
       id, display_name, normalized_name, college_name, normalized_college, identity_status
     ) VALUES ($1, '评价测试教师', '评价测试教师', '测试学院', '测试学院', 'active')`,
    [teacherId],
  );
  return database;
}

const ratings = {
  courseOrganization: 5,
  contentClarity: 4,
  assessmentExplanation: 4,
  classroomInteraction: 3,
  materialCompleteness: 5,
};

test("user teacher reviews are one-per-teacher, versioned, and soft-deleted", async () => {
  const database = await createDatabase();
  try {
    const store = createTeacherStore(database);
    const created = await store.saveUserTeacherReview({
      teacherId,
      userId: userA,
      body: "课程组织很清楚，案例能帮助理解概念，作业反馈也比较及时。",
      ratings,
      expectedVersion: null,
    });
    assert.equal(created.version, 1);
    assert.equal(created.authorLabel, "已注册用户");
    assert.deepEqual(created.ratings, ratings);

    await assert.rejects(
      store.saveUserTeacherReview({
        teacherId,
        userId: userA,
        body: "同一用户不能绕过版本号再创建第二条仍然有效的教师评价。",
        ratings,
        expectedVersion: null,
      }),
      (error) => error.code === "TEACHER_REVIEW_VERSION_CONFLICT" && error.currentVersion === 1,
    );

    const updated = await store.saveUserTeacherReview({
      teacherId,
      userId: userA,
      body: "更新后补充：课程结构清楚，案例与作业反馈都能对应课堂进度。",
      ratings: { ...ratings, classroomInteraction: 4 },
      expectedVersion: 1,
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.ratings.classroomInteraction, 4);

    await assert.rejects(
      store.saveUserTeacherReview({
        teacherId,
        userId: userA,
        body: "使用旧版本号的覆盖不会成功，也不会改写已经保存的新正文。",
        ratings,
        expectedVersion: 1,
      }),
      (error) => error.code === "TEACHER_REVIEW_VERSION_CONFLICT" && error.currentVersion === 2,
    );
    assert.equal((await store.getUserTeacherReview({ teacherId, userId: userA })).body, updated.body);

    const other = await store.saveUserTeacherReview({
      teacherId,
      userId: userB,
      body: "另一位登录用户可以独立评价同一位教师，不会覆盖前一位用户。",
      ratings: { ...ratings, courseOrganization: 3 },
      expectedVersion: null,
    });
    assert.equal(other.version, 1);

    await database.query(
      `INSERT INTO teacher_review_comments (review_id, author_user_id, body)
       VALUES ($1::uuid, $2::uuid, '第一条公开回复'),
              ($1::uuid, $2::uuid, '第二条公开回复')`,
      [updated.id, userB],
    );
    const discussedFirstPage = await store.listPublicTeacherReviews({
      teacherId,
      sort: "discussed",
      after: null,
      limit: 1,
    });
    assert.equal(discussedFirstPage[0].id, updated.id);
    assert.equal(discussedFirstPage[0].discussionCount, 2);
    const discussedSecondPage = await store.listPublicTeacherReviews({
      teacherId,
      sort: "discussed",
      after: discussedFirstPage[0].cursor,
      limit: 1,
    });
    assert.equal(discussedSecondPage[0].id, other.id);

    const searched = await store.listPublicTeacherReviews({
      teacherId,
      query: "课程结构",
      sort: "relevant",
      after: null,
      limit: 20,
    });
    assert.deepEqual(searched.map((review) => review.id), [updated.id]);

    const removed = await store.deleteUserTeacherReview({
      teacherId,
      userId: userA,
      expectedVersion: 2,
    });
    assert.equal(removed.status, "deleted");
    assert.equal(removed.version, 3);
    assert.equal(await store.getUserTeacherReview({ teacherId, userId: userA }), null);

    const recreated = await store.saveUserTeacherReview({
      teacherId,
      userId: userA,
      body: "删除旧评价后可以重新提交，但旧记录仍以软删除方式保留审计边界。",
      ratings,
      expectedVersion: null,
    });
    assert.equal(recreated.version, 1);
    assert.notEqual(recreated.id, created.id);

    const publicReviews = await store.listPublicTeacherReviews({
      teacherId,
      after: null,
      limit: 20,
    });
    assert.equal(publicReviews.length, 2);
    assert.ok(publicReviews.every((review) => review.sourceType === "user"));

    await database.query("DELETE FROM app_users WHERE id = $1", [userA]);
    const redacted = await database.query(
      `SELECT author_user_id, status, deleted_at
       FROM teacher_reviews
       WHERE teacher_id = $1 AND id = $2`,
      [teacherId, recreated.id],
    );
    assert.equal(redacted.rows[0].author_user_id, null);
    assert.equal(redacted.rows[0].status, "deleted");
    assert.ok(redacted.rows[0].deleted_at);
    assert.equal((await store.listPublicTeacherReviews({ teacherId, after: null, limit: 20 })).length, 1);
  } finally {
    await database.close();
  }
});

test("database rejects user review digests that do not match normalized content", async () => {
  const database = await createDatabase();
  try {
    await assert.rejects(
      database.query(
        `INSERT INTO teacher_reviews (
           teacher_id, author_user_id, source_type, author_label, body,
           course_organization_rating, content_clarity_rating,
           assessment_explanation_rating, classroom_interaction_rating,
           material_completeness_rating, content_sha256
         ) VALUES ($1, $2, 'user', '已注册用户', $3, 5, 5, 5, 5, 5, $4)`,
        [teacherId, userA, "这条正文的摘要故意错误，因此数据库触发器必须拒绝写入。", "0".repeat(64)],
      ),
      /teacher review content digest mismatch/u,
    );
  } finally {
    await database.close();
  }
});
