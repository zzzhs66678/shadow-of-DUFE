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
               AND status <> 'deleted'
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
             AND status <> 'deleted'
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
