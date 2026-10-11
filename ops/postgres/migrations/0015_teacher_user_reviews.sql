CREATE UNIQUE INDEX IF NOT EXISTS teacher_reviews_one_active_user_review_uidx
    ON teacher_reviews (teacher_id, author_user_id)
    WHERE source_type = 'user' AND status <> 'deleted';

CREATE OR REPLACE FUNCTION guard_teacher_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_content_sha256 text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'teacher reviews must be soft-deleted';
    END IF;

    IF TG_OP = 'UPDATE' AND
       OLD.source_type = 'user' AND
       OLD.author_user_id IS NOT NULL AND
       NEW.author_user_id IS NULL THEN
        IF NEW.teacher_id IS DISTINCT FROM OLD.teacher_id OR
           NEW.source_type IS DISTINCT FROM OLD.source_type OR
           NEW.import_candidate_id IS DISTINCT FROM OLD.import_candidate_id OR
           NEW.author_label IS DISTINCT FROM OLD.author_label OR
           NEW.body IS DISTINCT FROM OLD.body OR
           NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR
           NEW.course_organization_rating IS DISTINCT FROM OLD.course_organization_rating OR
           NEW.content_clarity_rating IS DISTINCT FROM OLD.content_clarity_rating OR
           NEW.assessment_explanation_rating IS DISTINCT FROM OLD.assessment_explanation_rating OR
           NEW.classroom_interaction_rating IS DISTINCT FROM OLD.classroom_interaction_rating OR
           NEW.material_completeness_rating IS DISTINCT FROM OLD.material_completeness_rating OR
           NEW.created_at IS DISTINCT FROM OLD.created_at OR
           NEW.published_at IS DISTINCT FROM OLD.published_at THEN
            RAISE EXCEPTION 'teacher review account redaction cannot alter content';
        END IF;
        NEW.status := 'deleted';
        NEW.deleted_at := COALESCE(OLD.deleted_at, now());
        NEW.updated_at := now();
        NEW.version := OLD.version + 1;
        RETURN NEW;
    END IF;

    IF NEW.source_type = 'user' THEN
        IF NEW.author_user_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM app_users
            WHERE id = NEW.author_user_id AND status = 'active'
        ) THEN
            RAISE EXCEPTION 'user teacher reviews require an active author';
        END IF;
        expected_content_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        IF NEW.content_sha256 IS DISTINCT FROM expected_content_sha256 THEN
            RAISE EXCEPTION 'teacher review content digest mismatch';
        END IF;
    ELSIF TG_OP = 'INSERT' AND NOT EXISTS (
        SELECT 1 FROM teacher_review_candidates
        WHERE id = NEW.import_candidate_id
          AND teacher_id = NEW.teacher_id
          AND moderation_status = 'approved'
    ) THEN
        RAISE EXCEPTION 'legacy teacher review candidate must be approved';
    END IF;

    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;

    IF NEW.teacher_id IS DISTINCT FROM OLD.teacher_id OR
       NEW.author_user_id IS DISTINCT FROM OLD.author_user_id OR
       NEW.source_type IS DISTINCT FROM OLD.source_type OR
       NEW.import_candidate_id IS DISTINCT FROM OLD.import_candidate_id OR
       NEW.author_label IS DISTINCT FROM OLD.author_label OR
       NEW.created_at IS DISTINCT FROM OLD.created_at OR
       NEW.published_at IS DISTINCT FROM OLD.published_at THEN
        RAISE EXCEPTION 'teacher review source identity is immutable';
    END IF;

    IF OLD.source_type = 'legacy_approved' AND (
       NEW.body IS DISTINCT FROM OLD.body OR
       NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR
       NEW.course_organization_rating IS DISTINCT FROM OLD.course_organization_rating OR
       NEW.content_clarity_rating IS DISTINCT FROM OLD.content_clarity_rating OR
       NEW.assessment_explanation_rating IS DISTINCT FROM OLD.assessment_explanation_rating OR
       NEW.classroom_interaction_rating IS DISTINCT FROM OLD.classroom_interaction_rating OR
       NEW.material_completeness_rating IS DISTINCT FROM OLD.material_completeness_rating
    ) THEN
        RAISE EXCEPTION 'legacy teacher review evidence is immutable';
    END IF;

    NEW.updated_at := now();
    NEW.version := OLD.version + 1;
    IF NEW.status = 'deleted' THEN
        NEW.deleted_at := COALESCE(OLD.deleted_at, now());
    ELSE
        NEW.deleted_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;
