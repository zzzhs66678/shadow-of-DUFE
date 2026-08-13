CREATE TABLE IF NOT EXISTS teacher_review_comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id uuid NOT NULL REFERENCES teacher_reviews(id) ON DELETE RESTRICT,
    author_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    parent_comment_id uuid REFERENCES teacher_review_comments(id) ON DELETE RESTRICT,
    root_comment_id uuid REFERENCES teacher_review_comments(id) ON DELETE RESTRICT,
    reply_to_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 3000),
    status text NOT NULL DEFAULT 'published'
        CHECK (status IN ('published', 'hidden', 'deleted')),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    CHECK (
        (parent_comment_id IS NULL AND root_comment_id IS NULL) OR
        (parent_comment_id IS NOT NULL AND root_comment_id IS NOT NULL)
    ),
    CHECK (parent_comment_id IS NULL OR parent_comment_id <> id),
    CHECK (root_comment_id IS NULL OR root_comment_id <> id),
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION guard_teacher_review_comment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_review_id uuid;
    parent_parent_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'teacher review comments must be soft-deleted';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.author_user_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM app_users WHERE id = NEW.author_user_id AND status = 'active'
        ) OR NOT EXISTS (
            SELECT 1 FROM teacher_reviews WHERE id = NEW.review_id AND status = 'published'
        ) THEN
            RAISE EXCEPTION 'teacher review comment target is unavailable';
        END IF;
        IF NEW.parent_comment_id IS NULL THEN
            NEW.root_comment_id := NULL;
        ELSE
            SELECT review_id, parent_comment_id
            INTO parent_review_id, parent_parent_id
            FROM teacher_review_comments
            WHERE id = NEW.parent_comment_id AND status = 'published';
            IF NOT FOUND OR parent_review_id <> NEW.review_id THEN
                RAISE EXCEPTION 'teacher review reply parent must belong to the same review';
            END IF;
            IF parent_parent_id IS NOT NULL THEN
                RAISE EXCEPTION 'teacher review replies are limited to two levels';
            END IF;
            NEW.root_comment_id := NEW.parent_comment_id;
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.author_user_id IS NOT NULL AND NEW.author_user_id IS NULL THEN
        IF NEW.review_id IS DISTINCT FROM OLD.review_id OR
           NEW.parent_comment_id IS DISTINCT FROM OLD.parent_comment_id OR
           NEW.root_comment_id IS DISTINCT FROM OLD.root_comment_id OR
           (NEW.reply_to_user_id IS DISTINCT FROM OLD.reply_to_user_id AND NEW.reply_to_user_id IS NOT NULL) OR
           NEW.body IS DISTINCT FROM OLD.body OR
           NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'teacher review comment account redaction cannot alter evidence';
        END IF;
        NEW.status := 'deleted';
        NEW.deleted_at := COALESCE(OLD.deleted_at, now());
        NEW.updated_at := now();
        NEW.version := OLD.version + 1;
        RETURN NEW;
    END IF;

    IF NEW.review_id IS DISTINCT FROM OLD.review_id OR
       NEW.author_user_id IS DISTINCT FROM OLD.author_user_id OR
       NEW.parent_comment_id IS DISTINCT FROM OLD.parent_comment_id OR
       NEW.root_comment_id IS DISTINCT FROM OLD.root_comment_id OR
       (NEW.reply_to_user_id IS DISTINCT FROM OLD.reply_to_user_id AND NEW.reply_to_user_id IS NOT NULL) OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'teacher review comment thread identity is immutable';
    END IF;
    IF NOT (
        (OLD.status = 'published' AND NEW.status IN ('published', 'hidden', 'deleted')) OR
        (OLD.status = 'hidden' AND NEW.status IN ('hidden', 'published', 'deleted')) OR
        (OLD.status = 'deleted' AND NEW.status = 'deleted')
    ) THEN RAISE EXCEPTION 'invalid teacher review comment status transition'; END IF;
    IF OLD.status IN ('hidden', 'deleted') AND (
       NEW.body IS DISTINCT FROM OLD.body OR NEW.edited_at IS DISTINCT FROM OLD.edited_at
    ) THEN RAISE EXCEPTION 'hidden teacher review comment content is immutable'; END IF;
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

DROP TRIGGER IF EXISTS teacher_review_comments_guard ON teacher_review_comments;
CREATE TRIGGER teacher_review_comments_guard
    BEFORE INSERT OR UPDATE OR DELETE ON teacher_review_comments
    FOR EACH ROW EXECUTE FUNCTION guard_teacher_review_comment();
DROP TRIGGER IF EXISTS teacher_review_comments_truncate_guard ON teacher_review_comments;
CREATE TRIGGER teacher_review_comments_truncate_guard
    BEFORE TRUNCATE ON teacher_review_comments
    FOR EACH STATEMENT EXECUTE FUNCTION reject_community_content_hard_delete();

CREATE INDEX IF NOT EXISTS teacher_review_comments_roots_cursor_idx
    ON teacher_review_comments (review_id, created_at ASC, id ASC)
    WHERE parent_comment_id IS NULL;
CREATE INDEX IF NOT EXISTS teacher_review_comments_replies_cursor_idx
    ON teacher_review_comments (root_comment_id, created_at ASC, id ASC)
    WHERE root_comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS teacher_review_comments_author_idx
    ON teacher_review_comments (author_user_id, created_at DESC)
    WHERE author_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS teacher_review_comment_edits (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    comment_id uuid NOT NULL REFERENCES teacher_review_comments(id) ON DELETE RESTRICT,
    actor_user_id uuid,
    actor_label text NOT NULL CHECK (char_length(actor_label) BETWEEN 1 AND 120),
    previous_version bigint NOT NULL CHECK (previous_version >= 1),
    previous_body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS teacher_review_comment_edits_append_only ON teacher_review_comment_edits;
CREATE TRIGGER teacher_review_comment_edits_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON teacher_review_comment_edits
    FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_audit_mutation();

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

    IF TG_OP = 'UPDATE' AND OLD.source_type = 'user' AND
       OLD.author_user_id IS NOT NULL AND NEW.author_user_id IS NULL THEN
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
           NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
            RAISE EXCEPTION 'teacher review account redaction cannot alter content';
        END IF;
        NEW.status := 'deleted';
        NEW.deleted_at := COALESCE(OLD.deleted_at, now());
        NEW.updated_at := now();
        NEW.version := OLD.version + 1;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.status IN ('hidden', 'deleted') AND (
       NEW.body IS DISTINCT FROM OLD.body OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR
       NEW.course_organization_rating IS DISTINCT FROM OLD.course_organization_rating OR
       NEW.content_clarity_rating IS DISTINCT FROM OLD.content_clarity_rating OR
       NEW.assessment_explanation_rating IS DISTINCT FROM OLD.assessment_explanation_rating OR
       NEW.classroom_interaction_rating IS DISTINCT FROM OLD.classroom_interaction_rating OR
       NEW.material_completeness_rating IS DISTINCT FROM OLD.material_completeness_rating
    ) THEN RAISE EXCEPTION 'hidden teacher review content is immutable'; END IF;
    IF TG_OP = 'UPDATE' AND NOT (
        (OLD.status = 'published' AND NEW.status IN ('published', 'hidden', 'deleted')) OR
        (OLD.status = 'hidden' AND NEW.status IN ('hidden', 'published', 'deleted')) OR
        (OLD.status = 'deleted' AND NEW.status = 'deleted')
    ) THEN RAISE EXCEPTION 'invalid teacher review status transition'; END IF;

    IF NEW.source_type = 'user' THEN
        IF NEW.author_user_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM app_users WHERE id = NEW.author_user_id AND status = 'active'
        ) THEN RAISE EXCEPTION 'user teacher reviews require an active author'; END IF;
        expected_content_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
        IF NEW.content_sha256 IS DISTINCT FROM expected_content_sha256 THEN
            RAISE EXCEPTION 'teacher review content digest mismatch';
        END IF;
    ELSIF TG_OP = 'INSERT' AND NOT EXISTS (
        SELECT 1 FROM teacher_review_candidates WHERE id = NEW.import_candidate_id
          AND teacher_id = NEW.teacher_id AND moderation_status = 'approved'
    ) THEN RAISE EXCEPTION 'legacy teacher review candidate must be approved'; END IF;

    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    IF NEW.teacher_id IS DISTINCT FROM OLD.teacher_id OR
       NEW.author_user_id IS DISTINCT FROM OLD.author_user_id OR
       NEW.source_type IS DISTINCT FROM OLD.source_type OR
       NEW.import_candidate_id IS DISTINCT FROM OLD.import_candidate_id OR
       NEW.author_label IS DISTINCT FROM OLD.author_label OR
       NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
        RAISE EXCEPTION 'teacher review source identity is immutable';
    END IF;
    IF OLD.source_type = 'legacy_approved' AND (
       NEW.body IS DISTINCT FROM OLD.body OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR
       NEW.course_organization_rating IS DISTINCT FROM OLD.course_organization_rating OR
       NEW.content_clarity_rating IS DISTINCT FROM OLD.content_clarity_rating OR
       NEW.assessment_explanation_rating IS DISTINCT FROM OLD.assessment_explanation_rating OR
       NEW.classroom_interaction_rating IS DISTINCT FROM OLD.classroom_interaction_rating OR
       NEW.material_completeness_rating IS DISTINCT FROM OLD.material_completeness_rating
    ) THEN RAISE EXCEPTION 'legacy teacher review evidence is immutable'; END IF;
    NEW.updated_at := now();
    NEW.version := OLD.version + 1;
    IF NEW.status = 'deleted' THEN NEW.deleted_at := COALESCE(OLD.deleted_at, now());
    ELSE NEW.deleted_at := NULL; END IF;
    RETURN NEW;
END;
$$;

ALTER TABLE community_reports DROP CONSTRAINT IF EXISTS community_reports_target_type_check;
ALTER TABLE community_reports ADD CONSTRAINT community_reports_target_type_check
    CHECK (target_type IN ('topic', 'comment', 'user', 'teacher_review', 'teacher_review_comment'));
ALTER TABLE community_moderation_cases DROP CONSTRAINT IF EXISTS community_moderation_cases_target_type_check;
ALTER TABLE community_moderation_cases ADD CONSTRAINT community_moderation_cases_target_type_check
    CHECK (target_type IN ('topic', 'comment', 'user', 'teacher_review', 'teacher_review_comment'));
ALTER TABLE community_moderation_actions DROP CONSTRAINT IF EXISTS community_moderation_actions_target_type_check;
ALTER TABLE community_moderation_actions ADD CONSTRAINT community_moderation_actions_target_type_check
    CHECK (target_type IN ('topic', 'comment', 'user', 'teacher_review', 'teacher_review_comment'));

CREATE OR REPLACE FUNCTION community_target_exists(target_type_value text, target_id_value uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF target_type_value = 'topic' THEN
        RETURN EXISTS (SELECT 1 FROM community_topics WHERE id = target_id_value);
    ELSIF target_type_value = 'comment' THEN
        RETURN EXISTS (SELECT 1 FROM community_comments WHERE id = target_id_value);
    ELSIF target_type_value = 'user' THEN
        RETURN EXISTS (SELECT 1 FROM app_users WHERE id = target_id_value);
    ELSIF target_type_value = 'teacher_review' THEN
        RETURN EXISTS (SELECT 1 FROM teacher_reviews WHERE id = target_id_value);
    ELSIF target_type_value = 'teacher_review_comment' THEN
        RETURN EXISTS (SELECT 1 FROM teacher_review_comments WHERE id = target_id_value);
    END IF;
    RETURN false;
END;
$$;

ALTER TABLE community_notifications
    ADD COLUMN IF NOT EXISTS teacher_review_id uuid REFERENCES teacher_reviews(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS teacher_review_comment_id uuid REFERENCES teacher_review_comments(id) ON DELETE SET NULL;
ALTER TABLE community_notifications DROP CONSTRAINT IF EXISTS community_notifications_notification_type_check;
ALTER TABLE community_notifications ADD CONSTRAINT community_notifications_notification_type_check
    CHECK (notification_type IN (
        'topic_reply', 'comment_reply', 'mention', 'content_moderated',
        'system_announcement', 'teacher_review_reply'
    ));

CREATE OR REPLACE FUNCTION validate_community_notification_reference()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    referenced_topic_id uuid;
    referenced_review_id uuid;
BEGIN
    IF NEW.actor_user_id IS NOT NULL AND NOT community_target_exists('user', NEW.actor_user_id) THEN
        RAISE EXCEPTION 'community notification actor does not exist';
    END IF;
    IF NEW.comment_id IS NOT NULL THEN
        SELECT topic_id INTO referenced_topic_id FROM community_comments WHERE id = NEW.comment_id;
        IF NOT FOUND OR NEW.topic_id IS NULL OR referenced_topic_id <> NEW.topic_id THEN
            RAISE EXCEPTION 'community notification comment must belong to its topic';
        END IF;
    END IF;
    IF NEW.teacher_review_comment_id IS NOT NULL THEN
        SELECT review_id INTO referenced_review_id
        FROM teacher_review_comments WHERE id = NEW.teacher_review_comment_id;
        IF NOT FOUND OR NEW.teacher_review_id IS NULL OR referenced_review_id <> NEW.teacher_review_id THEN
            RAISE EXCEPTION 'teacher review notification comment must belong to its review';
        END IF;
    END IF;
    IF (NEW.topic_id IS NOT NULL OR NEW.comment_id IS NOT NULL) AND
       (NEW.teacher_review_id IS NOT NULL OR NEW.teacher_review_comment_id IS NOT NULL) THEN
        RAISE EXCEPTION 'notification cannot mix community and teacher review references';
    END IF;
    IF NEW.notification_type IN ('topic_reply', 'comment_reply', 'mention') AND
       (NEW.teacher_review_id IS NOT NULL OR NEW.teacher_review_comment_id IS NOT NULL) THEN
        RAISE EXCEPTION 'community notification cannot carry teacher review references';
    END IF;
    IF NEW.notification_type IN ('topic_reply', 'comment_reply') AND
       (NEW.actor_user_id IS NULL OR NEW.topic_id IS NULL OR NEW.comment_id IS NULL) THEN
        RAISE EXCEPTION 'reply notification requires actor, topic and comment';
    END IF;
    IF NEW.notification_type = 'teacher_review_reply' AND
       (NEW.actor_user_id IS NULL OR NEW.teacher_review_id IS NULL OR NEW.teacher_review_comment_id IS NULL OR
        NEW.topic_id IS NOT NULL OR NEW.comment_id IS NOT NULL) THEN
        RAISE EXCEPTION 'teacher review reply notification requires review references only';
    END IF;
    IF NEW.notification_type = 'mention' AND (NEW.actor_user_id IS NULL OR NEW.topic_id IS NULL) THEN
        RAISE EXCEPTION 'mention notification requires actor and topic';
    END IF;
    IF NEW.notification_type = 'system_announcement' AND
       (NEW.actor_user_id IS NOT NULL OR NEW.topic_id IS NOT NULL OR NEW.comment_id IS NOT NULL OR
        NEW.teacher_review_id IS NOT NULL OR NEW.teacher_review_comment_id IS NOT NULL) THEN
        RAISE EXCEPTION 'system notification cannot impersonate a user or content';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS community_notifications_reference_guard ON community_notifications;
CREATE TRIGGER community_notifications_reference_guard
    BEFORE INSERT OR UPDATE OF notification_type, actor_user_id, topic_id, comment_id,
        teacher_review_id, teacher_review_comment_id ON community_notifications
    FOR EACH ROW EXECUTE FUNCTION validate_community_notification_reference();

-- Reinstall the report guard after extending its evidence-bearing target types.
CREATE OR REPLACE FUNCTION guard_community_report()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'community reports cannot be deleted'; END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'open' OR NOT community_target_exists('user', NEW.reporter_user_id) OR
           NOT community_target_exists(NEW.target_type, NEW.target_id) OR
           NEW.evidence_author_label IS NULL OR
           (NEW.target_type IN ('topic', 'comment', 'teacher_review', 'teacher_review_comment') AND NEW.evidence_body IS NULL) THEN
            RAISE EXCEPTION 'invalid community report';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.reporter_user_id IS DISTINCT FROM OLD.reporter_user_id OR
       NEW.target_type IS DISTINCT FROM OLD.target_type OR NEW.target_id IS DISTINCT FROM OLD.target_id OR
       NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.detail IS DISTINCT FROM OLD.detail OR
       NEW.evidence_title IS DISTINCT FROM OLD.evidence_title OR NEW.evidence_body IS DISTINCT FROM OLD.evidence_body OR
       NEW.evidence_author_label IS DISTINCT FROM OLD.evidence_author_label OR
       NEW.evidence_captured_at IS DISTINCT FROM OLD.evidence_captured_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'community report evidence is immutable';
    END IF;
    IF NOT ((OLD.status = 'open' AND NEW.status IN ('open','reviewing','resolved','dismissed')) OR
            (OLD.status = 'reviewing' AND NEW.status IN ('reviewing','resolved','dismissed')) OR
            (OLD.status IN ('resolved','dismissed') AND NEW.status = OLD.status)) THEN
        RAISE EXCEPTION 'invalid community report status transition';
    END IF;
    NEW.updated_at := now();
    IF NEW.status IN ('resolved','dismissed') THEN NEW.resolved_at := COALESCE(OLD.resolved_at, now());
    ELSE NEW.resolved_at := NULL; END IF;
    RETURN NEW;
END;
$$;

COMMENT ON TABLE teacher_review_comments IS
    'Independent two-level discussions attached to teacher reviews; never represented as community topics.';
COMMENT ON TABLE teacher_review_comment_edits IS
    'Immutable pre-edit evidence for user-authored teacher review replies.';
