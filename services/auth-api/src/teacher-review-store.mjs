function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function mapCandidate(row) {
  return {
    id: String(row.candidate_id),
    teacher: {
      id: String(row.teacher_id),
      displayName: row.teacher_display_name,
      collegeName: row.teacher_college_name,
    },
    body: row.sanitized_body,
    riskFlags: row.risk_flags ?? [],
    status: row.moderation_status,
    moderationReason: row.moderation_reason,
    moderatedAt: iso(row.moderated_at),
    publicReviewId: row.public_review_id
      ? String(row.public_review_id)
      : null,
    createdAt: iso(row.created_at),
  };
}

function databaseError(error) {
  const message = String(error?.message ?? "");
  const mapped = new Map([
    ["administrator_elevation_required", "AUTH_ADMIN_FORBIDDEN"],
    ["invalid_teacher_review_candidate_query", "TEACHER_REVIEW_QUERY_INVALID"],
    ["invalid_teacher_review_decision", "TEACHER_REVIEW_DECISION_INVALID"],
    ["teacher_review_candidate_not_found", "TEACHER_REVIEW_CANDIDATE_NOT_FOUND"],
    ["teacher_review_candidate_state_conflict", "TEACHER_REVIEW_CANDIDATE_CONFLICT"],
  ]);
  for (const [needle, code] of mapped) {
    if (message.includes(needle)) {
      error.code = code;
      break;
    }
  }
  return error;
}

export function createTeacherReviewStore(pool) {
  return {
    async listAdminTeacherReviewCandidates(input) {
      try {
        const result = await pool.query(
          `SELECT * FROM list_teacher_review_candidates_for_admin(
             $1, $2, $3, $4, $5, $6, $7
           )`,
          [
            input.actorUserId,
            input.actorSessionId,
            input.actorElevationTokenHash,
            input.status,
            input.afterCreatedAt,
            input.afterId,
            input.limit,
          ],
        );
        return result.rows.map(mapCandidate);
      } catch (error) {
        throw databaseError(error);
      }
    },

    async moderateAdminTeacherReviewCandidate(input) {
      try {
        const result = await pool.query(
          `SELECT * FROM moderate_teacher_review_candidate(
             $1, $2, $3, $4, $5, $6, $7, $8, $9
           )`,
          [
            input.actorUserId,
            input.actorSessionId,
            input.actorElevationTokenHash,
            input.candidateId,
            input.decision,
            input.reason,
            input.requestId,
            input.ipHash,
            input.userAgentHash,
          ],
        );
        const row = result.rows[0];
        return {
          id: String(row.candidate_id),
          status: row.moderation_status,
          publicReviewId: row.public_review_id
            ? String(row.public_review_id)
            : null,
          moderatedAt: iso(row.moderated_at),
        };
      } catch (error) {
        throw databaseError(error);
      }
    },
  };
}
