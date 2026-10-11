CREATE TABLE IF NOT EXISTS teacher_review_candidate_decisions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    candidate_id uuid NOT NULL UNIQUE
        REFERENCES teacher_review_candidates(id) ON DELETE RESTRICT,
    decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
    actor_user_id uuid NOT NULL,
    actor_label text NOT NULL CHECK (char_length(actor_label) BETWEEN 1 AND 120),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 1000),
    published_body text CHECK (published_body IS NULL OR char_length(published_body) BETWEEN 1 AND 3000),
    public_review_id uuid UNIQUE REFERENCES teacher_reviews(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (decision = 'approved' AND published_body IS NOT NULL AND public_review_id IS NOT NULL) OR
        (decision = 'rejected' AND published_body IS NULL AND public_review_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS teacher_review_candidate_decisions_created_idx
    ON teacher_review_candidate_decisions (created_at DESC, id DESC);

DROP TRIGGER IF EXISTS teacher_review_candidate_decisions_append_only
    ON teacher_review_candidate_decisions;
CREATE TRIGGER teacher_review_candidate_decisions_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON teacher_review_candidate_decisions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_audit_mutation();

CREATE OR REPLACE FUNCTION require_elevated_teacher_review_admin(
    p_actor_user_id uuid,
    p_actor_session_id uuid,
    p_actor_elevation_token_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM 1
    FROM public.app_users AS users
    INNER JOIN public.user_sessions AS sessions
        ON sessions.id = p_actor_session_id
       AND sessions.user_id = users.id
       AND sessions.revoked_at IS NULL
       AND sessions.expires_at > now()
    INNER JOIN public.admin_elevated_sessions AS elevation
        ON elevation.base_session_id = sessions.id
       AND elevation.user_id = users.id
       AND elevation.token_hash = p_actor_elevation_token_hash
       AND elevation.revoked_at IS NULL
       AND elevation.expires_at > now()
    WHERE users.id = p_actor_user_id
      AND users.status = 'active'
      AND users.role = 'admin'
    FOR UPDATE OF users, sessions, elevation;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'administrator_elevation_required';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION list_teacher_review_candidates_for_admin(
    p_actor_user_id uuid,
    p_actor_session_id uuid,
    p_actor_elevation_token_hash text,
    p_status text DEFAULT 'pending',
    p_after_created_at timestamptz DEFAULT NULL,
    p_after_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 50
)
RETURNS TABLE (
    candidate_id uuid,
    teacher_id uuid,
    teacher_display_name text,
    teacher_college_name text,
    sanitized_body text,
    risk_flags text[],
    moderation_status text,
    moderation_reason text,
    moderated_at timestamptz,
    public_review_id uuid,
    created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF p_status NOT IN ('pending', 'approved', 'rejected', 'rolled_back') OR
       p_limit < 1 OR p_limit > 100 OR
       ((p_after_created_at IS NULL) <> (p_after_id IS NULL)) THEN
        RAISE EXCEPTION 'invalid_teacher_review_candidate_query';
    END IF;

    PERFORM public.require_elevated_teacher_review_admin(
        p_actor_user_id,
        p_actor_session_id,
        p_actor_elevation_token_hash
    );

    RETURN QUERY
    SELECT
        candidate.id,
        teacher.id,
        teacher.display_name,
        teacher.college_name,
        candidate.sanitized_body,
        candidate.risk_flags,
        candidate.moderation_status,
        candidate.moderation_reason,
        candidate.moderated_at,
        review.id,
        candidate.created_at
    FROM public.teacher_review_candidates AS candidate
    INNER JOIN public.teachers AS teacher ON teacher.id = candidate.teacher_id
    LEFT JOIN public.teacher_reviews AS review
        ON review.import_candidate_id = candidate.id
    WHERE candidate.moderation_status = p_status
      AND (
        p_after_created_at IS NULL OR
        (candidate.created_at, candidate.id) > (p_after_created_at, p_after_id)
      )
    ORDER BY candidate.created_at ASC, candidate.id ASC
    LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION moderate_teacher_review_candidate(
    p_actor_user_id uuid,
    p_actor_session_id uuid,
    p_actor_elevation_token_hash text,
    p_candidate_id uuid,
    p_decision text,
    p_reason text,
    p_request_id uuid,
    p_ip_hash text,
    p_user_agent_hash text
)
RETURNS TABLE (
    candidate_id uuid,
    moderation_status text,
    public_review_id uuid,
    moderated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    candidate_record record;
    review_id uuid;
    decision_status text;
    actor_label_snapshot text;
BEGIN
    IF p_decision NOT IN ('approve', 'reject') OR
       p_reason IS NULL OR char_length(p_reason) < 8 OR char_length(p_reason) > 1000 OR
       p_request_id IS NULL THEN
        RAISE EXCEPTION 'invalid_teacher_review_decision';
    END IF;

    PERFORM public.require_elevated_teacher_review_admin(
        p_actor_user_id,
        p_actor_session_id,
        p_actor_elevation_token_hash
    );

    SELECT candidate.id, candidate.teacher_id, candidate.sanitized_body,
           candidate.normalized_body_sha256, candidate.risk_flags,
           candidate.moderation_status, import_batch.status AS batch_status
    INTO candidate_record
    FROM public.teacher_review_candidates AS candidate
    INNER JOIN public.data_import_rows AS import_row
        ON import_row.id = candidate.import_row_id
    INNER JOIN public.data_import_batches AS import_batch
        ON import_batch.id = import_row.batch_id
    WHERE candidate.id = p_candidate_id
    FOR UPDATE OF import_batch, candidate;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'teacher_review_candidate_not_found';
    END IF;
    IF candidate_record.moderation_status <> 'pending' THEN
        RAISE EXCEPTION 'teacher_review_candidate_state_conflict';
    END IF;
    IF candidate_record.batch_status <> 'applied' THEN
        RAISE EXCEPTION 'teacher_review_candidate_state_conflict';
    END IF;

    SELECT COALESCE(NULLIF(users.display_name, ''), users.username, '管理员')
    INTO actor_label_snapshot
    FROM public.app_users AS users
    WHERE users.id = p_actor_user_id;

    decision_status := CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
    UPDATE public.teacher_review_candidates
    SET moderation_status = decision_status,
        moderated_by_user_id = p_actor_user_id,
        moderated_at = now(),
        moderation_reason = p_reason
    WHERE id = p_candidate_id;

    IF p_decision = 'approve' THEN
        INSERT INTO public.teacher_reviews (
            teacher_id,
            source_type,
            import_candidate_id,
            author_label,
            body,
            content_sha256
        )
        VALUES (
            candidate_record.teacher_id,
            'legacy_approved',
            p_candidate_id,
            '历史整理内容',
            candidate_record.sanitized_body,
            candidate_record.normalized_body_sha256
        )
        RETURNING id INTO review_id;
    END IF;

    INSERT INTO public.teacher_review_candidate_decisions (
        candidate_id,
        decision,
        actor_user_id,
        actor_label,
        reason,
        published_body,
        public_review_id
    )
    VALUES (
        p_candidate_id,
        decision_status,
        p_actor_user_id,
        actor_label_snapshot,
        p_reason,
        CASE WHEN p_decision = 'approve' THEN candidate_record.sanitized_body ELSE NULL END,
        review_id
    );

    INSERT INTO public.admin_audit_events (
        actor_user_id,
        actor_role,
        session_id,
        action,
        target_type,
        target_id,
        request_id,
        ip_hash,
        user_agent_hash,
        metadata
    )
    VALUES (
        p_actor_user_id,
        'admin',
        p_actor_session_id,
        'admin.teacher_review.' || p_decision,
        'teacher_review_candidate',
        p_candidate_id::text,
        p_request_id,
        p_ip_hash,
        p_user_agent_hash,
        jsonb_build_object(
            'decision', p_decision,
            'reason', p_reason,
            'riskFlags', candidate_record.risk_flags,
            'publicReviewId', review_id
        )
    );

    RETURN QUERY
    SELECT p_candidate_id, decision_status, review_id, candidate.moderated_at
    FROM public.teacher_review_candidates AS candidate
    WHERE candidate.id = p_candidate_id;
END;
$$;

CREATE OR REPLACE FUNCTION rollback_teacher_review_candidate_for_import(
    p_candidate_id uuid,
    p_batch_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_status text;
BEGIN
    SELECT candidate.moderation_status
    INTO current_status
    FROM public.data_import_batches AS import_batch
    INNER JOIN public.data_import_rows AS import_row
        ON import_row.batch_id = import_batch.id
    INNER JOIN public.teacher_review_candidates AS candidate
        ON import_row.id = candidate.import_row_id
    WHERE import_batch.id = p_batch_id
      AND candidate.id = p_candidate_id
    FOR UPDATE OF import_batch, candidate;

    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF current_status = 'rolled_back' THEN
        RETURN true;
    END IF;
    IF current_status = 'approved' OR EXISTS (
        SELECT 1 FROM public.teacher_reviews AS review
        WHERE review.import_candidate_id = p_candidate_id
    ) OR EXISTS (
        SELECT 1 FROM public.teacher_review_candidate_decisions AS decision
        WHERE decision.candidate_id = p_candidate_id
          AND decision.decision = 'approved'
    ) THEN
        RAISE EXCEPTION 'approved_teacher_review_candidate_cannot_be_rolled_back';
    END IF;

    UPDATE public.teacher_review_candidates
    SET moderation_status = 'rolled_back',
        moderated_at = now(),
        moderation_reason = CASE
            WHEN current_status = 'pending' THEN '导入批次执行回滚'
            ELSE moderation_reason
        END
    WHERE id = p_candidate_id;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION require_elevated_teacher_review_admin(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_teacher_review_candidates_for_admin(uuid, uuid, text, text, timestamptz, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION moderate_teacher_review_candidate(uuid, uuid, text, uuid, text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rollback_teacher_review_candidate_for_import(uuid, uuid) FROM PUBLIC;

COMMENT ON FUNCTION list_teacher_review_candidates_for_admin(uuid, uuid, text, text, timestamptz, uuid, integer) IS
    '只向具备有效短期 MFA 提升的管理员返回脱敏历史评价候选。';
COMMENT ON FUNCTION moderate_teacher_review_candidate(uuid, uuid, text, uuid, text, text, uuid, text, text) IS
    '在一个事务中锁定候选、做出一次性决策、按需发布历史评价并写入管理员审计。';
COMMENT ON FUNCTION rollback_teacher_review_candidate_for_import(uuid, uuid) IS
    '供独立 importer 角色回滚未批准候选；不能撤回已公开评价。';
COMMENT ON TABLE teacher_review_candidate_decisions IS
    '管理员对历史教师评价候选的一次性不可变决定；批准正文和操作者标签均保留快照。';
