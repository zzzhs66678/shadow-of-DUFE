import { createHash } from "node:crypto";

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

async function withTransaction(pool, callback) {
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

function domainError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function contentDigest(body) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function mapTeacherSummary(row) {
  return {
    id: String(row.id),
    displayName: row.display_name,
    collegeName: row.college_name,
    courseCount: Number(row.course_count ?? 0),
    reviewCount: Number(row.review_count ?? 0),
    updatedAt: iso(row.updated_at),
  };
}

function mapReview(row) {
  return {
    id: String(row.id),
    sourceType: row.source_type,
    authorLabel: row.source_type === "legacy_approved"
      ? "历史整理内容"
      : row.author_label ?? "已注册用户",
    body: row.body,
    ratings: row.source_type === "user" ? {
      courseOrganization: Number(row.course_organization_rating),
      contentClarity: Number(row.content_clarity_rating),
      assessmentExplanation: Number(row.assessment_explanation_rating),
      classroomInteraction: Number(row.classroom_interaction_rating),
      materialCompleteness: Number(row.material_completeness_rating),
    } : null,
    publishedAt: iso(row.published_at),
  };
}

function mapOwnReview(row) {
  if (!row) return null;
  return {
    ...mapReview(row),
    status: row.status,
    version: Number(row.version),
    updatedAt: iso(row.updated_at),
  };
}

function mapReviewComment(row) {
  const unavailable = row.status !== "published" || row.blocked_by_viewer;
  return {
    id: String(row.id),
    reviewId: String(row.review_id),
    parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
    rootCommentId: row.root_comment_id ? String(row.root_comment_id) : null,
    replyToUserId: row.reply_to_user_id ? String(row.reply_to_user_id) : null,
    body: unavailable ? null : row.body,
    status: row.blocked_by_viewer ? "blocked" : row.status,
    version: Number(row.version),
    author: unavailable || !row.author_user_id ? null : {
      id: String(row.author_user_id),
      username: row.author_username,
      displayName: row.author_display_name,
      avatarUrl: row.author_avatar_url,
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    editedAt: iso(row.edited_at),
  };
}

async function assertTeacherReviewPostingAllowed(client, userId) {
  const result = await client.query(
    `SELECT users.status,
            EXISTS (
              SELECT 1 FROM community_user_sanctions AS sanctions
              WHERE sanctions.user_id = users.id
                AND sanctions.revoked_at IS NULL
                AND sanctions.starts_at <= now()
                AND (sanctions.expires_at IS NULL OR sanctions.expires_at > now())
            ) AS sanctioned
     FROM app_users AS users WHERE users.id = $1::uuid FOR UPDATE OF users`,
    [userId],
  );
  if (result.rows.length !== 1 || result.rows[0].status !== "active" || result.rows[0].sanctioned) {
    throw domainError("COMMUNITY_POSTING_FORBIDDEN");
  }
}

export function createTeacherStore(pool) {
  return {
    async listPublicTeachersBySchedule({ catalogId, scheduleId }) {
      const result = await pool.query(
        `SELECT
           teacher.id,
           teacher.display_name,
           teacher.college_name,
           teacher.updated_at,
           (
             SELECT count(*)::integer
             FROM teacher_course_sections AS section
             WHERE section.teacher_id = teacher.id
               AND section.record_status IN ('current', 'needs_review')
           ) AS course_count,
           (
             SELECT count(*)::integer
             FROM teacher_reviews AS review
             WHERE review.teacher_id = teacher.id
               AND review.status = 'published'
           ) AS review_count
         FROM course_schedule_teachers AS link
         INNER JOIN teachers AS teacher ON teacher.id = link.teacher_id
         WHERE link.catalog_id = $1
           AND link.schedule_id = $2
           AND link.record_status = 'current'
           AND teacher.identity_status IN ('pending', 'active')
         ORDER BY teacher.normalized_name, teacher.normalized_college, teacher.id`,
        [catalogId, scheduleId],
      );
      return result.rows.map(mapTeacherSummary);
    },

    async listPublicTeachers({ query, college, after, limit }) {
      const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase("zh-CN");
      const normalizedCollege = college.normalize("NFKC").toLocaleLowerCase("zh-CN");
      const result = await pool.query(
        `SELECT
           teacher.id,
           teacher.display_name,
           teacher.college_name,
           teacher.normalized_name,
           teacher.normalized_college,
           teacher.updated_at,
           count(DISTINCT section.id)::integer AS course_count,
           count(DISTINCT review.id)::integer AS review_count
         FROM teachers AS teacher
         LEFT JOIN teacher_course_sections AS section
           ON section.teacher_id = teacher.id
          AND section.record_status IN ('current', 'needs_review')
         LEFT JOIN teacher_reviews AS review
           ON review.teacher_id = teacher.id
          AND review.status = 'published'
         WHERE teacher.identity_status IN ('pending', 'active')
           AND (
             $1 = '' OR teacher.normalized_name LIKE '%' || $1 || '%'
             OR EXISTS (
               SELECT 1 FROM teacher_aliases AS alias
               WHERE alias.teacher_id = teacher.id
                 AND alias.normalized_alias LIKE '%' || $1 || '%'
             )
           )
           AND ($2 = '' OR teacher.normalized_college = $2)
           AND (
             $3::text IS NULL OR
             (teacher.normalized_name, teacher.normalized_college, teacher.id) >
             ($3, $4, $5::uuid)
           )
         GROUP BY teacher.id
         ORDER BY teacher.normalized_name, teacher.normalized_college, teacher.id
         LIMIT $6`,
        [
          normalizedQuery,
          normalizedCollege,
          after?.normalizedName ?? null,
          after?.normalizedCollege ?? null,
          after?.id ?? null,
          limit,
        ],
      );
      return result.rows.map((row) => ({
        ...mapTeacherSummary(row),
        cursor: {
          normalizedName: row.normalized_name,
          normalizedCollege: row.normalized_college,
          id: String(row.id),
        },
      }));
    },

    async getPublicTeacherDetail(teacherId) {
      const teacher = await pool.query(
        `SELECT
           teacher.id,
           teacher.display_name,
           teacher.college_name,
           teacher.updated_at,
           count(DISTINCT section.id)::integer AS course_count,
           count(DISTINCT review.id)::integer AS review_count,
           round(avg(review.course_organization_rating)::numeric, 2) AS course_organization_rating,
           round(avg(review.content_clarity_rating)::numeric, 2) AS content_clarity_rating,
           round(avg(review.assessment_explanation_rating)::numeric, 2) AS assessment_explanation_rating,
           round(avg(review.classroom_interaction_rating)::numeric, 2) AS classroom_interaction_rating,
           round(avg(review.material_completeness_rating)::numeric, 2) AS material_completeness_rating
         FROM teachers AS teacher
         LEFT JOIN teacher_course_sections AS section
           ON section.teacher_id = teacher.id
          AND section.record_status IN ('current', 'needs_review')
         LEFT JOIN teacher_reviews AS review
           ON review.teacher_id = teacher.id
          AND review.status = 'published'
         WHERE teacher.id = $1
           AND teacher.identity_status IN ('pending', 'active')
         GROUP BY teacher.id`,
        [teacherId],
      );
      if (teacher.rows.length === 0) return null;

      const [sections, textbooks] = await Promise.all([
        pool.query(
          `SELECT id, term_key, course_id, course_title, section_no, course_college,
                  record_status, first_seen_at, last_seen_at
           FROM teacher_course_sections
           WHERE teacher_id = $1
             AND record_status IN ('current', 'needs_review')
           ORDER BY term_key DESC, course_id, section_no
           LIMIT 100`,
          [teacherId],
        ),
        pool.query(
          `SELECT id, term_key, course_id, course_title, section_no,
                  material_kind, selection_status, title, author, publisher,
                  publication_date, publication_date_raw, edition, printing,
                  isbn, isbn_status, position, record_status
           FROM teaching_section_textbooks
           WHERE teacher_id = $1
             AND record_status IN ('current', 'needs_review')
           ORDER BY term_key DESC, course_id, section_no, position
           LIMIT 100`,
          [teacherId],
        ),
      ]);
      const row = teacher.rows[0];
      return {
        ...mapTeacherSummary(row),
        ratings: {
          courseOrganization: numberOrNull(row.course_organization_rating),
          contentClarity: numberOrNull(row.content_clarity_rating),
          assessmentExplanation: numberOrNull(row.assessment_explanation_rating),
          classroomInteraction: numberOrNull(row.classroom_interaction_rating),
          materialCompleteness: numberOrNull(row.material_completeness_rating),
        },
        sections: sections.rows.map((section) => ({
          id: String(section.id),
          termKey: section.term_key,
          courseId: section.course_id,
          courseTitle: section.course_title,
          sectionNo: section.section_no,
          courseCollege: section.course_college,
          status: section.record_status,
          firstSeenAt: iso(section.first_seen_at),
          lastSeenAt: iso(section.last_seen_at),
        })),
        textbooks: textbooks.rows.map((textbook) => ({
          id: String(textbook.id),
          termKey: textbook.term_key,
          courseId: textbook.course_id,
          courseTitle: textbook.course_title,
          sectionNo: textbook.section_no,
          materialKind: textbook.material_kind,
          selectionStatus: textbook.selection_status,
          title: textbook.title,
          author: textbook.author,
          publisher: textbook.publisher,
          publicationDate: textbook.publication_date ? iso(textbook.publication_date).slice(0, 10) : null,
          publicationDateRaw: textbook.publication_date_raw,
          edition: textbook.edition,
          printing: textbook.printing,
          isbn: textbook.isbn,
          isbnStatus: textbook.isbn_status,
          position: Number(textbook.position),
          status: textbook.record_status,
        })),
      };
    },

    async listPublicTeacherReviews({ teacherId, after, limit }) {
      const result = await pool.query(
        `SELECT id, source_type, author_label, body,
                course_organization_rating, content_clarity_rating,
                assessment_explanation_rating, classroom_interaction_rating,
                material_completeness_rating, published_at
         FROM teacher_reviews
         WHERE teacher_id = $1
           AND status = 'published'
           AND ($2::timestamptz IS NULL OR (published_at, id) < ($2, $3::uuid))
         ORDER BY published_at DESC, id DESC
         LIMIT $4`,
        [teacherId, after?.publishedAt ?? null, after?.id ?? null, limit],
      );
      return result.rows.map((row) => ({
        ...mapReview(row),
        cursor: { publishedAt: iso(row.published_at), id: String(row.id) },
      }));
    },

    async listTeacherReviewComments({ reviewId, viewerUserId = null, after, limit }) {
      const roots = await pool.query(
        `SELECT id, created_at FROM teacher_review_comments
         WHERE review_id = $1::uuid AND parent_comment_id IS NULL
           AND ($2::timestamptz IS NULL OR (created_at, id) > ($2, $3::uuid))
         ORDER BY created_at ASC, id ASC LIMIT $4`,
        [reviewId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
      );
      const hasMore = roots.rows.length > limit;
      const rootRows = roots.rows.slice(0, limit);
      const rootIds = rootRows.map((row) => String(row.id));
      if (rootIds.length === 0) return { items: [], nextCursor: null };
      const result = await pool.query(
        `SELECT comments.*, authors.username AS author_username,
                authors.display_name AS author_display_name,
                authors.avatar_url AS author_avatar_url,
                EXISTS (
                  SELECT 1 FROM community_user_blocks AS blocks
                  WHERE (blocks.blocker_user_id = $2::uuid AND blocks.blocked_user_id = comments.author_user_id)
                     OR (blocks.blocker_user_id = comments.author_user_id AND blocks.blocked_user_id = $2::uuid)
                ) AS blocked_by_viewer
         FROM teacher_review_comments AS comments
         LEFT JOIN app_users AS authors ON authors.id = comments.author_user_id
         LEFT JOIN teacher_review_comments AS roots ON roots.id = COALESCE(comments.root_comment_id, comments.id)
         WHERE comments.review_id = $1::uuid
           AND (comments.id = ANY($3::uuid[]) OR comments.root_comment_id = ANY($3::uuid[]))
         ORDER BY roots.created_at, roots.id,
                  CASE WHEN comments.parent_comment_id IS NULL THEN 0 ELSE 1 END,
                  comments.created_at, comments.id`,
        [reviewId, viewerUserId, rootIds],
      );
      const last = rootRows.at(-1);
      return {
        items: result.rows.map(mapReviewComment),
        nextCursor: hasMore && last
          ? { createdAt: iso(last.created_at), id: String(last.id) }
          : null,
      };
    },

    async getPublicTeacherReviewForTeacher({ teacherId, reviewId }) {
      const result = await pool.query(
        `SELECT id FROM teacher_reviews
         WHERE id = $1::uuid AND teacher_id = $2::uuid AND status = 'published'
         LIMIT 1`,
        [reviewId, teacherId],
      );
      return result.rows.length === 1;
    },

    async createTeacherReviewComment({ teacherId, reviewId, userId, body, replyToCommentId }) {
      return withTransaction(pool, async (client) => {
        await assertTeacherReviewPostingAllowed(client, userId);
        const reviewResult = await client.query(
          `SELECT id, teacher_id, author_user_id, status
           FROM teacher_reviews WHERE id = $1::uuid AND teacher_id = $2::uuid
           FOR SHARE`,
          [reviewId, teacherId],
        );
        const review = reviewResult.rows[0];
        if (!review || review.status !== "published") {
          throw domainError("COMMUNITY_CONTENT_UNAVAILABLE");
        }
        if (review.author_user_id) {
          const blocked = await client.query(
            `SELECT EXISTS (
               SELECT 1 FROM community_user_blocks
               WHERE (blocker_user_id = $1::uuid AND blocked_user_id = $2::uuid)
                  OR (blocker_user_id = $2::uuid AND blocked_user_id = $1::uuid)
             ) AS blocked`,
            [userId, review.author_user_id],
          );
          if (blocked.rows[0].blocked) throw domainError("COMMUNITY_CONTENT_UNAVAILABLE");
        }
        let parentCommentId = null;
        let replyToUserId = null;
        if (replyToCommentId) {
          const targetResult = await client.query(
            `SELECT id, author_user_id, parent_comment_id, root_comment_id, status
             FROM teacher_review_comments
             WHERE id = $1::uuid AND review_id = $2::uuid FOR SHARE`,
            [replyToCommentId, reviewId],
          );
          const target = targetResult.rows[0];
          if (!target || target.status !== "published") {
            throw domainError("COMMUNITY_REPLY_TARGET_UNAVAILABLE");
          }
          if (target.author_user_id) {
            const blocked = await client.query(
              `SELECT EXISTS (
                 SELECT 1 FROM community_user_blocks
                 WHERE (blocker_user_id = $1::uuid AND blocked_user_id = $2::uuid)
                    OR (blocker_user_id = $2::uuid AND blocked_user_id = $1::uuid)
               ) AS blocked`,
              [userId, target.author_user_id],
            );
            if (blocked.rows[0].blocked) throw domainError("COMMUNITY_REPLY_TARGET_UNAVAILABLE");
          }
          parentCommentId = target.parent_comment_id ? target.root_comment_id : target.id;
          replyToUserId = target.author_user_id;
        }
        const inserted = await client.query(
          `INSERT INTO teacher_review_comments (
             review_id, author_user_id, parent_comment_id, root_comment_id,
             reply_to_user_id, body
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, $4::uuid, $5)
           RETURNING id, review_id, parent_comment_id, root_comment_id,
                     status, version, created_at, updated_at`,
          [reviewId, userId, parentCommentId, replyToUserId, body],
        );
        const recipientUserId = replyToCommentId ? replyToUserId : review.author_user_id;
        if (recipientUserId && String(recipientUserId) !== String(userId)) {
          await client.query(
            `INSERT INTO community_notifications (
               recipient_user_id, actor_user_id, notification_type,
               teacher_review_id, teacher_review_comment_id,
               title, body, fallback_path, dedupe_key
             ) VALUES ($1::uuid, $2::uuid, 'teacher_review_reply', $3::uuid, $4::uuid,
                       '你的教师评价收到新回复', left($5, 500),
                       '/teachers/' || $6::uuid::text,
                       'teacher-review-reply:' || $4::uuid::text)
             ON CONFLICT DO NOTHING`,
            [recipientUserId, userId, reviewId, inserted.rows[0].id, body, teacherId],
          );
        }
        const full = await client.query(
          `SELECT comments.*, users.username AS author_username,
                  users.display_name AS author_display_name, users.avatar_url AS author_avatar_url,
                  false AS blocked_by_viewer
           FROM teacher_review_comments AS comments
           LEFT JOIN app_users AS users ON users.id = comments.author_user_id
           WHERE comments.id = $1::uuid`,
          [inserted.rows[0].id],
        );
        return mapReviewComment(full.rows[0]);
      });
    },

    async updateTeacherReviewComment({ commentId, userId, body, expectedVersion }) {
      return withTransaction(pool, async (client) => {
        await assertTeacherReviewPostingAllowed(client, userId);
        const locked = await client.query(
          `SELECT comments.*, COALESCE(users.display_name, users.username, '已注销用户') AS actor_label,
                  reviews.status AS review_status
           FROM teacher_review_comments AS comments
           JOIN teacher_reviews AS reviews ON reviews.id = comments.review_id
           LEFT JOIN app_users AS users ON users.id = comments.author_user_id
           WHERE comments.id = $1::uuid AND comments.author_user_id = $2::uuid
           FOR UPDATE OF comments, reviews`,
          [commentId, userId],
        );
        const comment = locked.rows[0];
        if (!comment) throw domainError("COMMUNITY_ACTION_FORBIDDEN");
        if (comment.status !== "published" || comment.review_status !== "published") {
          throw domainError("COMMUNITY_CONTENT_UNAVAILABLE");
        }
        if (Number(comment.version) !== expectedVersion) {
          throw domainError("COMMUNITY_VERSION_CONFLICT", { currentVersion: Number(comment.version) });
        }
        await client.query(
          `INSERT INTO teacher_review_comment_edits
             (comment_id, actor_user_id, actor_label, previous_version, previous_body)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
          [commentId, userId, comment.actor_label, comment.version, comment.body],
        );
        const result = await client.query(
          `UPDATE teacher_review_comments SET body = $3, edited_at = now()
           WHERE id = $1::uuid AND author_user_id = $2::uuid
           RETURNING id, review_id, parent_comment_id, root_comment_id,
                     status, version, created_at, updated_at`,
          [commentId, userId, body],
        );
        const full = await client.query(
          `SELECT comments.*, users.username AS author_username,
                  users.display_name AS author_display_name, users.avatar_url AS author_avatar_url,
                  false AS blocked_by_viewer
           FROM teacher_review_comments AS comments
           LEFT JOIN app_users AS users ON users.id = comments.author_user_id
           WHERE comments.id = $1::uuid`,
          [result.rows[0].id],
        );
        return mapReviewComment(full.rows[0]);
      });
    },

    async deleteTeacherReviewComment({ commentId, userId, expectedVersion }) {
      return withTransaction(pool, async (client) => {
        const locked = await client.query(
          `SELECT comments.*, COALESCE(users.display_name, users.username, '已注销用户') AS actor_label
           FROM teacher_review_comments AS comments
           LEFT JOIN app_users AS users ON users.id = comments.author_user_id
           WHERE comments.id = $1::uuid AND comments.author_user_id = $2::uuid
           FOR UPDATE OF comments`,
          [commentId, userId],
        );
        const comment = locked.rows[0];
        if (!comment) throw domainError("COMMUNITY_ACTION_FORBIDDEN");
        if (comment.status !== "published") throw domainError("COMMUNITY_CONTENT_UNAVAILABLE");
        if (Number(comment.version) !== expectedVersion) {
          throw domainError("COMMUNITY_VERSION_CONFLICT", { currentVersion: Number(comment.version) });
        }
        await client.query(
          `INSERT INTO teacher_review_comment_edits
             (comment_id, actor_user_id, actor_label, previous_version, previous_body)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
          [commentId, userId, comment.actor_label, comment.version, comment.body],
        );
        const result = await client.query(
          `UPDATE teacher_review_comments SET status = 'deleted'
           WHERE id = $1::uuid AND author_user_id = $2::uuid
           RETURNING id, review_id, status, version`,
          [commentId, userId],
        );
        await client.query(
          `UPDATE community_notifications SET title = '相关教师评价回复已删除', body = NULL,
                  fallback_path = '/teachers/' || (SELECT teacher_id::text FROM teacher_reviews WHERE id = $2::uuid)
           WHERE teacher_review_comment_id = $1::uuid`,
          [commentId, comment.review_id],
        );
        const full = await client.query(
          `SELECT comments.*, users.username AS author_username,
                  users.display_name AS author_display_name, users.avatar_url AS author_avatar_url,
                  false AS blocked_by_viewer
           FROM teacher_review_comments AS comments
           LEFT JOIN app_users AS users ON users.id = comments.author_user_id
           WHERE comments.id = $1::uuid`,
          [result.rows[0].id],
        );
        return mapReviewComment(full.rows[0]);
      });
    },

    async getUserTeacherReview({ teacherId, userId }) {
      const result = await pool.query(
        `SELECT id, source_type, author_label, body,
                course_organization_rating, content_clarity_rating,
                assessment_explanation_rating, classroom_interaction_rating,
                material_completeness_rating, status, version, published_at, updated_at
         FROM teacher_reviews
         WHERE teacher_id = $1
           AND author_user_id = $2
           AND source_type = 'user'
           AND status <> 'deleted'
         LIMIT 1`,
        [teacherId, userId],
      );
      return mapOwnReview(result.rows[0]);
    },

    async saveUserTeacherReview({ teacherId, userId, body, ratings, expectedVersion }) {
      return withTransaction(pool, async (client) => {
        const access = await client.query(
          `SELECT users.id AS user_id, teacher.id AS teacher_id
           FROM app_users AS users
           INNER JOIN teachers AS teacher
             ON teacher.id = $2
            AND teacher.identity_status IN ('pending', 'active')
           WHERE users.id = $1 AND users.status = 'active'
           FOR UPDATE OF users`,
          [userId, teacherId],
        );
        if (access.rows.length === 0) throw domainError("TEACHER_REVIEW_TARGET_NOT_FOUND");

        const existingReview = await client.query(
          `SELECT version, status FROM teacher_reviews
           WHERE teacher_id = $1::uuid AND author_user_id = $2::uuid
             AND source_type = 'user' AND status <> 'deleted'
           LIMIT 1 FOR UPDATE`,
          [teacherId, userId],
        );
        if (existingReview.rows[0]?.status === "hidden") {
          throw domainError("COMMUNITY_CONTENT_UNAVAILABLE");
        }

        const values = [
          teacherId,
          userId,
          body,
          ratings.courseOrganization,
          ratings.contentClarity,
          ratings.assessmentExplanation,
          ratings.classroomInteraction,
          ratings.materialCompleteness,
          contentDigest(body),
        ];
        let result;
        if (expectedVersion === null) {
          result = await client.query(
            `INSERT INTO teacher_reviews (
               teacher_id, author_user_id, source_type, author_label, body,
               course_organization_rating, content_clarity_rating,
               assessment_explanation_rating, classroom_interaction_rating,
               material_completeness_rating, content_sha256
             ) VALUES ($1, $2, 'user', '已注册用户', $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (teacher_id, author_user_id)
               WHERE source_type = 'user' AND status <> 'deleted'
             DO NOTHING
             RETURNING id, source_type, author_label, body,
                       course_organization_rating, content_clarity_rating,
                       assessment_explanation_rating, classroom_interaction_rating,
                       material_completeness_rating, status, version, published_at, updated_at`,
            values,
          );
        } else {
          result = await client.query(
            `UPDATE teacher_reviews
             SET body = $3,
                 course_organization_rating = $4,
                 content_clarity_rating = $5,
                 assessment_explanation_rating = $6,
                 classroom_interaction_rating = $7,
                 material_completeness_rating = $8,
                 content_sha256 = $9
             WHERE teacher_id = $1
               AND author_user_id = $2
               AND source_type = 'user'
               AND status = 'published'
               AND version = $10
             RETURNING id, source_type, author_label, body,
                       course_organization_rating, content_clarity_rating,
                       assessment_explanation_rating, classroom_interaction_rating,
                       material_completeness_rating, status, version, published_at, updated_at`,
            [...values, expectedVersion],
          );
        }
        if (result.rows.length > 0) return mapOwnReview(result.rows[0]);

        const current = await client.query(
          `SELECT version FROM teacher_reviews
           WHERE teacher_id = $1 AND author_user_id = $2
             AND source_type = 'user' AND status <> 'deleted'
           LIMIT 1`,
          [teacherId, userId],
        );
        throw domainError("TEACHER_REVIEW_VERSION_CONFLICT", {
          currentVersion: current.rows[0] ? Number(current.rows[0].version) : null,
        });
      });
    },

    async deleteUserTeacherReview({ teacherId, userId, expectedVersion }) {
      return withTransaction(pool, async (client) => {
        const result = await client.query(
          `UPDATE teacher_reviews
           SET status = 'deleted'
           WHERE teacher_id = $1
             AND author_user_id = $2
             AND source_type = 'user'
             AND status IN ('published', 'hidden')
             AND version = $3
           RETURNING id, status, version`,
          [teacherId, userId, expectedVersion],
        );
        if (result.rows.length > 0) {
          return {
            id: String(result.rows[0].id),
            status: result.rows[0].status,
            version: Number(result.rows[0].version),
          };
        }
        const current = await client.query(
          `SELECT version FROM teacher_reviews
           WHERE teacher_id = $1 AND author_user_id = $2
             AND source_type = 'user' AND status <> 'deleted'
           LIMIT 1`,
          [teacherId, userId],
        );
        if (!current.rows[0]) throw domainError("TEACHER_REVIEW_NOT_FOUND");
        throw domainError("TEACHER_REVIEW_VERSION_CONFLICT", {
          currentVersion: Number(current.rows[0].version),
        });
      });
    },
  };
}
