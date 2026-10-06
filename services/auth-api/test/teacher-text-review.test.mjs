import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { createTeacherStore } from "../src/teacher-store.mjs";

const teacherId = "00000000-0000-4000-8000-000000000501";
const userA = "00000000-0000-4000-8000-000000000502";
const userB = "00000000-0000-4000-8000-000000000503";
const userC = "00000000-0000-4000-8000-000000000504";
const ratings = {
  courseOrganization: 5,
  contentClarity: 4,
  assessmentExplanation: 3,
  classroomInteraction: 2,
  materialCompleteness: 1,
};
const ratingColumns = [
  "course_organization_rating", "content_clarity_rating", "assessment_explanation_rating",
  "classroom_interaction_rating", "material_completeness_rating",
];
const migrations = new URL("../../../ops/postgres/migrations/", import.meta.url);
const migrationName = "0023_teacher_text_reviews.sql";

async function createDatabase(t, { beforeTextReviews = false } = {}) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.waitReady;
  const files = (await fs.readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.includes(migrationName));
  for (const file of files) {
    if (beforeTextReviews && file >= migrationName) break;
    await database.exec(await fs.readFile(new URL(file, migrations), "utf8"));
  }
  for (const [index, userId] of [userA, userB, userC].entries()) {
    await database.query(
      `INSERT INTO app_users (id, status, display_name, role, username, normalized_username, registered_via)
       VALUES ($1, 'active', '文本评价用户', 'user', $2, $2, 'credential')`,
      [userId, `text-review-${index}`],
    );
  }
  await database.query(
    `INSERT INTO teachers (id, display_name, normalized_name, college_name, normalized_college, identity_status)
     VALUES ($1, '文本评价教师', '文本评价教师', '测试学院', '测试学院', 'active')`,
    [teacherId],
  );
  return database;
}

const newReview = (userId, extra = {}) => ({ teacherId, userId, body: "好", expectedVersion: null, ...extra });
const versionConflict = (version) => (error) =>
  error.code === "TEACHER_REVIEW_VERSION_CONFLICT" && error.currentVersion === version;

test("0023 upgrades real pre-existing reviews without changing scores, evidence, versions, or guards", async (t) => {
  const database = await createDatabase(t, { beforeTextReviews: true });
  const store = createTeacherStore(database);
  for (const userId of [userA, userB, userC]) {
    await store.saveUserTeacherReview(newReview(userId, { ratings }));
  }
  await database.query("UPDATE teacher_reviews SET status = 'hidden' WHERE author_user_id = $1", [userB]);
  await store.deleteUserTeacherReview({ teacherId, userId: userC, expectedVersion: 1 });
  const before = await database.query("SELECT * FROM teacher_reviews ORDER BY id");
  const guardQuery = `SELECT oid::regprocedure::text AS name, pg_get_functiondef(oid) AS definition
    FROM pg_proc WHERE proname IN ('guard_teacher_review', 'moderate_teacher_review_candidate') ORDER BY proname`;
  const guards = await database.query(guardQuery);
  await assert.rejects(
    database.query(`UPDATE teacher_reviews SET ${ratingColumns.map((key) => `${key} = NULL`).join(", ")}
      WHERE author_user_id = $1`, [userA]),
    /teacher_reviews_check2/u,
  );

  await database.exec(await fs.readFile(new URL(migrationName, migrations), "utf8"));
  assert.deepEqual((await database.query("SELECT * FROM teacher_reviews ORDER BY id")).rows, before.rows);
  assert.deepEqual((await database.query(guardQuery)).rows, guards.rows);
  assert.deepEqual((await database.query(
    "SELECT convalidated FROM pg_constraint WHERE conname = 'teacher_reviews_ratings_complete_check'",
  )).rows, [{ convalidated: true }]);

  let updated = await store.saveUserTeacherReview(newReview(userA, { body: "正文编辑", expectedVersion: 1 }));
  assert.deepEqual(updated.ratings, ratings);
  assert.equal(updated.version, 2);
  updated = await store.saveUserTeacherReview(newReview(userA, { body: "只改文字", ratings: null, expectedVersion: 2 }));
  assert.deepEqual(updated.ratings, ratings);
  assert.equal(updated.version, 3);
  assert.deepEqual((await store.getUserTeacherReview({ teacherId, userId: userA })).ratings, ratings);
  assert.deepEqual((await store.listPublicTeacherReviews({ teacherId, after: null, limit: 20 }))[0].ratings, ratings);

  await assert.rejects(store.saveUserTeacherReview(newReview(userA)), versionConflict(3));
  await assert.rejects(store.saveUserTeacherReview(newReview(userA, { expectedVersion: 1 })), versionConflict(3));
  const changedRatings = { ...ratings, materialCompleteness: 5 };
  updated = await store.saveUserTeacherReview(newReview(userA, { ratings: changedRatings, expectedVersion: 3 }));
  assert.deepEqual(updated.ratings, changedRatings);
  assert.equal(updated.version, 4);
});

test("text-only SQL reviews create, edit, read, and soft-delete without scores; NULLs do not dilute means", async (t) => {
  const database = await createDatabase(t);
  const store = createTeacherStore(database);
  const first = await store.saveUserTeacherReview(newReview(userA));
  assert.equal(first.body, "好");
  assert.equal(first.ratings, null);
  assert.equal(first.version, 1);
  const second = await store.saveUserTeacherReview(newReview(userB, { body: "字".repeat(3000), ratings: null }));
  assert.equal(second.ratings, null);
  const unratedDetail = await store.getPublicTeacherDetail(teacherId);
  assert.equal(unratedDetail.reviewCount, 2);
  assert.deepEqual(Object.values(unratedDetail.ratings), [null, null, null, null, null]);
  assert.ok((await store.listPublicTeacherReviews({ teacherId, after: null, limit: 20 }))
    .every((review) => review.ratings === null));

  await assert.rejects(store.saveUserTeacherReview(newReview(userA)), versionConflict(1));
  const edited = await store.saveUserTeacherReview(newReview(userA, { body: "补充", ratings: null, expectedVersion: 1 }));
  assert.equal(edited.version, 2);
  assert.equal(edited.ratings, null);
  assert.equal((await store.getUserTeacherReview({ teacherId, userId: userA })).ratings, null);
  await assert.rejects(store.saveUserTeacherReview(newReview(userA, { expectedVersion: 1 })), versionConflict(2));
  assert.equal((await store.getUserTeacherReview({ teacherId, userId: userA })).body, "补充");

  const rated = await store.saveUserTeacherReview(newReview(userC, { ratings }));
  assert.deepEqual(rated.ratings, ratings);
  const mixedDetail = await store.getPublicTeacherDetail(teacherId);
  assert.equal(mixedDetail.reviewCount, 3);
  assert.deepEqual(mixedDetail.ratings, ratings, "two text reviews are not zero/default scores");

  const nextRatings = { ...ratings, courseOrganization: 1 };
  const scoredEdit = await store.saveUserTeacherReview(newReview(userB, { ratings: nextRatings, expectedVersion: 1 }));
  assert.deepEqual(scoredEdit.ratings, nextRatings, "an old client may add a complete real score later");
  assert.deepEqual((await store.getPublicTeacherDetail(teacherId)).ratings, { ...ratings, courseOrganization: 3 });
  const textEdit = await store.saveUserTeacherReview(newReview(userB, { body: "保留评分", expectedVersion: 2 }));
  assert.deepEqual(textEdit.ratings, nextRatings);

  await assert.rejects(store.deleteUserTeacherReview({ teacherId, userId: userA, expectedVersion: 1 }), versionConflict(2));
  const removed = await store.deleteUserTeacherReview({ teacherId, userId: userA, expectedVersion: 2 });
  assert.equal(removed.status, "deleted");
  assert.equal(removed.version, 3);
  assert.equal(await store.getUserTeacherReview({ teacherId, userId: userA }), null);
  const preserved = (await database.query("SELECT * FROM teacher_reviews WHERE id = $1", [first.id])).rows[0];
  assert.equal(preserved.body, "补充");
  assert.ok(preserved.deleted_at);
  assert.ok(ratingColumns.every((key) => preserved[key] === null));
  const recreated = await store.saveUserTeacherReview(newReview(userA));
  assert.notEqual(recreated.id, first.id);
  assert.equal(recreated.ratings, null);
});

test("0023 still rejects every partial score set, out-of-range scores, and invalid body lengths in SQL", async (t) => {
  const database = await createDatabase(t);
  const store = createTeacherStore(database);
  const created = await store.saveUserTeacherReview(newReview(userA));
  const setRatings = (values) => database.query(
    `UPDATE teacher_reviews SET ${ratingColumns.map((key, index) => `${key} = $${index + 2}`).join(", ")}
     WHERE id = $1`, [created.id, ...values],
  );
  for (let mask = 1; mask < 31; mask += 1) {
    await assert.rejects(setRatings(ratingColumns.map((_, index) => mask & (1 << index) ? 3 : null)),
      /teacher_reviews_ratings_complete_check/u);
  }
  for (let index = 0; index < 5; index += 1) {
    for (const invalid of [0, -1, 6]) {
      const values = [1, 2, 3, 4, 5];
      values[index] = invalid;
      await assert.rejects(setRatings(values), /violates check constraint/u);
    }
  }
  for (const body of ["", "字".repeat(3001)]) {
    await assert.rejects(store.saveUserTeacherReview(newReview(userA, { body, expectedVersion: 1 })),
      /teacher_reviews_body_check/u);
  }
  await assert.rejects(store.saveUserTeacherReview(newReview(userA, {
    ratings: { contentClarity: 4 }, expectedVersion: 1,
  })), /teacher_reviews_ratings_complete_check/u);
  assert.equal((await store.getUserTeacherReview({ teacherId, userId: userA })).version, 1);
  await store.saveUserTeacherReview(newReview(userA, { ratings, expectedVersion: 1 }));
  await assert.rejects(store.saveUserTeacherReview(newReview(userA, {
    ratings: { courseOrganization: 4 }, expectedVersion: 2,
  })), /teacher_reviews_ratings_complete_check/u);
  assert.deepEqual((await store.getUserTeacherReview({ teacherId, userId: userA })).ratings, ratings);
});

test("text reviews keep hidden/deleted evidence, active-author checks, and legacy approval guards", async (t) => {
  const database = await createDatabase(t);
  const store = createTeacherStore(database);
  const created = await store.saveUserTeacherReview(newReview(userA));
  await database.query("UPDATE teacher_reviews SET status = 'hidden' WHERE id = $1", [created.id]);
  await assert.rejects(store.saveUserTeacherReview(newReview(userA, { expectedVersion: 2 })),
    (error) => error.code === "COMMUNITY_CONTENT_UNAVAILABLE");
  await assert.rejects(database.query(
    "UPDATE teacher_reviews SET course_organization_rating = 4 WHERE id = $1", [created.id],
  ), /hidden teacher review content is immutable/u);
  assert.equal((await store.listPublicTeacherReviews({ teacherId, after: null, limit: 20 })).length, 0);
  await store.deleteUserTeacherReview({ teacherId, userId: userA, expectedVersion: 2 });
  await assert.rejects(database.query("UPDATE teacher_reviews SET status = 'published' WHERE id = $1", [created.id]),
    /invalid teacher review status transition/u);
  await assert.rejects(database.query("DELETE FROM teacher_reviews WHERE id = $1", [created.id]), /soft-deleted/u);
  await assert.rejects(database.exec("TRUNCATE teacher_reviews CASCADE"), /hard deletion|soft|truncate/iu);

  const other = await store.saveUserTeacherReview(newReview(userB));
  await database.query("DELETE FROM app_users WHERE id = $1", [userB]);
  const redacted = (await database.query("SELECT * FROM teacher_reviews WHERE id = $1", [other.id])).rows[0];
  assert.equal(redacted.author_user_id, null);
  assert.equal(redacted.status, "deleted");
  assert.equal(redacted.body, "好");
  assert.ok(ratingColumns.every((key) => redacted[key] === null));
  await assert.rejects(store.saveUserTeacherReview(newReview(userB)),
    (error) => error.code === "TEACHER_REVIEW_TARGET_NOT_FOUND");
  await assert.rejects(database.query(
    `INSERT INTO teacher_reviews (teacher_id, source_type, author_label, body, content_sha256)
     VALUES ($1, 'legacy_approved', '历史整理内容', '未经审核', $2)`, [teacherId, "a".repeat(64)],
  ), /legacy teacher review candidate must be approved/u);
});
