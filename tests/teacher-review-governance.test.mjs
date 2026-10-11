import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { createTeacherStore } from "../services/auth-api/src/teacher-store.mjs";
import { createCommunityStore } from "../services/auth-api/src/community-store.mjs";

const teacherId = "00000000-0000-4000-8000-000000000401";
const authorId = "00000000-0000-4000-8000-000000000402";
const replierId = "00000000-0000-4000-8000-000000000403";
const thirdId = "00000000-0000-4000-8000-000000000404";

async function fixture() {
  const db = new PGlite();
  await db.waitReady;
  const directory = path.resolve("ops/postgres/migrations");
  for (const file of (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(await fs.readFile(path.join(directory, file), "utf8"));
  }
  await db.query(
    `INSERT INTO app_users (id,status,display_name,role,username,normalized_username,registered_via) VALUES
       ($1,'active','评价作者','user','review-author','review-author','credential'),
       ($2,'active','回复者','user','review-replier','review-replier','credential'),
       ($3,'active','第三位','user','review-third','review-third','credential')`,
    [authorId, replierId, thirdId],
  );
  await db.query(
    `INSERT INTO teachers (id,display_name,normalized_name,college_name,normalized_college,identity_status)
     VALUES ($1,'治理测试教师','治理测试教师','测试学院','测试学院','active')`,
    [teacherId],
  );
  const body = "课程组织清晰，案例和作业反馈能够对应课堂进度，评价正文满足测试长度。";
  const review = await db.query(
    `INSERT INTO teacher_reviews (
       teacher_id,author_user_id,source_type,author_label,body,
       course_organization_rating,content_clarity_rating,assessment_explanation_rating,
       classroom_interaction_rating,material_completeness_rating,content_sha256
     ) VALUES ($1,$2,'user','已注册用户',$3,5,4,4,3,5,$4) RETURNING id`,
    [teacherId, authorId, body, createHash("sha256").update(body).digest("hex")],
  );
  return { db, reviewId: String(review.rows[0].id) };
}

test("teacher review comments are two-level, versioned, notified, reportable, and redact on account deletion", async () => {
  const { db, reviewId } = await fixture();
  try {
    const teachers = createTeacherStore(db);
    const community = createCommunityStore(db);
    const root = await teachers.createTeacherReviewComment({
      teacherId, reviewId, userId: replierId, body: "请问这门课平时的课堂互动频率怎么样？", replyToCommentId: null,
    });
    assert.equal(root.body, "请问这门课平时的课堂互动频率怎么样？");
    assert.equal(root.author.id, replierId);
    assert.equal(root.parentCommentId, null);
    const reply = await teachers.createTeacherReviewComment({
      teacherId, reviewId, userId: authorId, body: "每周都有讨论环节，具体形式会跟随课程进度调整。", replyToCommentId: root.id,
    });
    const nested = await teachers.createTeacherReviewComment({
      teacherId, reviewId, userId: thirdId, body: "谢谢补充，这样的安排听起来比较清楚。", replyToCommentId: reply.id,
    });
    assert.equal(nested.parentCommentId, root.id);
    assert.equal(nested.rootCommentId, root.id);
    assert.equal(nested.replyToUserId, authorId);

    const notices = await community.listCommunityNotifications({ userId: replierId, limit: 20 });
    assert.equal(notices.items.some((item) => item.type === "teacher_review_reply" && item.teacherReviewId === reviewId), true);

    const updated = await teachers.updateTeacherReviewComment({
      commentId: root.id, userId: replierId, body: "请问这门课平时的课堂互动和提问频率怎么样？", expectedVersion: root.version,
    });
    assert.equal(updated.version, 2);
    await assert.rejects(
      teachers.updateTeacherReviewComment({ commentId: root.id, userId: replierId, body: "旧版本不能覆盖。", expectedVersion: 1 }),
      (error) => error.code === "COMMUNITY_VERSION_CONFLICT" && error.currentVersion === 2,
    );
    await assert.rejects(
      teachers.updateTeacherReviewComment({ commentId: root.id, userId: thirdId, body: "不能改别人的回复。", expectedVersion: 2 }),
      (error) => error.code === "COMMUNITY_ACTION_FORBIDDEN",
    );

    const report = await community.createCommunityReport({
      reporterUserId: thirdId, targetType: "teacher_review_comment", targetId: root.id,
      reasonCode: "other", detail: "测试教师评价回复举报证据是否被固定保存。",
    });
    assert.equal(report.targetType, "teacher_review_comment");
    const evidence = await db.query(`SELECT evidence_body FROM community_reports WHERE id = $1`, [report.id]);
    assert.equal(evidence.rows[0].evidence_body, updated.body);

    await db.query(`UPDATE teacher_review_comments SET status='hidden' WHERE id=$1`, [root.id]);
    await assert.rejects(
      db.query(`UPDATE teacher_review_comments SET body='隐藏期间不能偷换回复正文' WHERE id=$1`, [root.id]),
      /hidden teacher review comment content is immutable/u,
    );
    await db.query(`UPDATE teacher_review_comments SET status='deleted' WHERE id=$1`, [root.id]);
    await assert.rejects(
      db.query(`UPDATE teacher_review_comments SET status='published' WHERE id=$1`, [root.id]),
      /invalid teacher review comment status transition/u,
    );

    await db.query("DELETE FROM app_users WHERE id = $1", [replierId]);
    const redacted = await db.query(
      `SELECT author_user_id,status,deleted_at FROM teacher_review_comments WHERE id = $1`, [root.id],
    );
    assert.equal(redacted.rows[0].author_user_id, null);
    assert.equal(redacted.rows[0].status, "deleted");
    assert.ok(redacted.rows[0].deleted_at);
  } finally { await db.close(); }
});

test("hidden reviews cannot be edited, remain deletable by author, and restore original evidence only", async () => {
  const { db, reviewId } = await fixture();
  try {
    const store = createTeacherStore(db);
    const before = await db.query(`SELECT body,version FROM teacher_reviews WHERE id=$1`, [reviewId]);
    await db.query(`UPDATE teacher_reviews SET status='hidden' WHERE id=$1`, [reviewId]);
    await assert.rejects(
      store.saveUserTeacherReview({ teacherId, userId: authorId, body: "隐藏期间不能替换正文，即使评分字段全部合法也不可以提交。", ratings: {
        courseOrganization: 5, contentClarity: 5, assessmentExplanation: 5, classroomInteraction: 5, materialCompleteness: 5,
      }, expectedVersion: 2 }),
      (error) => error.code === "COMMUNITY_CONTENT_UNAVAILABLE",
    );
    await assert.rejects(
      db.query(`UPDATE teacher_reviews SET body='直接修改隐藏正文也必须失败' WHERE id=$1`, [reviewId]),
      /hidden teacher review content is immutable/u,
    );
    await db.query(`UPDATE teacher_reviews SET status='published' WHERE id=$1`, [reviewId]);
    const restored = await db.query(`SELECT body FROM teacher_reviews WHERE id=$1`, [reviewId]);
    assert.equal(restored.rows[0].body, before.rows[0].body);
    await db.query(`UPDATE teacher_reviews SET status='hidden' WHERE id=$1`, [reviewId]);
    const current = await db.query(`SELECT version FROM teacher_reviews WHERE id=$1`, [reviewId]);
    const deleted = await store.deleteUserTeacherReview({
      teacherId, userId: authorId, expectedVersion: Number(current.rows[0].version),
    });
    assert.equal(deleted.status, "deleted");
    await assert.rejects(
      db.query(`UPDATE teacher_reviews SET status='published' WHERE id=$1`, [reviewId]),
      /invalid teacher review status transition/u,
    );
  } finally { await db.close(); }
});
