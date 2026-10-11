ALTER TABLE community_reports
    ADD COLUMN IF NOT EXISTS evidence_title text,
    ADD COLUMN IF NOT EXISTS evidence_body text,
    ADD COLUMN IF NOT EXISTS evidence_author_label text,
    ADD COLUMN IF NOT EXISTS evidence_captured_at timestamptz NOT NULL DEFAULT now();

UPDATE community_reports AS reports
SET
    evidence_title = CASE
        WHEN reports.target_type = 'topic' THEN topics.title
        WHEN reports.target_type = 'user' THEN COALESCE(target_user.display_name, target_user.username)
        ELSE NULL
    END,
    evidence_body = CASE
        WHEN reports.target_type = 'topic' THEN topics.body
        WHEN reports.target_type = 'comment' THEN comments.body
        ELSE NULL
    END,
    evidence_author_label = COALESCE(
        topic_author.display_name, topic_author.username,
        comment_author.display_name, comment_author.username,
        target_user.display_name, target_user.username,
        '已注销用户'
    )
FROM community_reports AS source
LEFT JOIN community_topics AS topics
    ON source.target_type = 'topic' AND topics.id = source.target_id
LEFT JOIN app_users AS topic_author ON topic_author.id = topics.author_user_id
LEFT JOIN community_comments AS comments
    ON source.target_type = 'comment' AND comments.id = source.target_id
LEFT JOIN app_users AS comment_author ON comment_author.id = comments.author_user_id
LEFT JOIN app_users AS target_user
    ON source.target_type = 'user' AND target_user.id = source.target_id
WHERE reports.id = source.id
  AND reports.evidence_captured_at IS NOT NULL
  AND reports.evidence_title IS NULL
  AND reports.evidence_body IS NULL
  AND reports.evidence_author_label IS NULL;

CREATE OR REPLACE FUNCTION guard_community_report()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'community reports cannot be deleted';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'open' OR
           NOT community_target_exists('user', NEW.reporter_user_id) OR
           NOT community_target_exists(NEW.target_type, NEW.target_id) THEN
            RAISE EXCEPTION 'invalid community report';
        END IF;
        IF NEW.evidence_author_label IS NULL OR
           (NEW.target_type IN ('topic', 'comment') AND NEW.evidence_body IS NULL) THEN
            RAISE EXCEPTION 'community report evidence snapshot is required';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.reporter_user_id IS DISTINCT FROM OLD.reporter_user_id OR
       NEW.target_type IS DISTINCT FROM OLD.target_type OR
       NEW.target_id IS DISTINCT FROM OLD.target_id OR
       NEW.reason_code IS DISTINCT FROM OLD.reason_code OR
       NEW.detail IS DISTINCT FROM OLD.detail OR
       NEW.evidence_title IS DISTINCT FROM OLD.evidence_title OR
       NEW.evidence_body IS DISTINCT FROM OLD.evidence_body OR
       NEW.evidence_author_label IS DISTINCT FROM OLD.evidence_author_label OR
       NEW.evidence_captured_at IS DISTINCT FROM OLD.evidence_captured_at OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'community report evidence is immutable';
    END IF;

    IF NOT (
        (OLD.status = 'open' AND NEW.status IN ('open', 'reviewing', 'resolved', 'dismissed')) OR
        (OLD.status = 'reviewing' AND NEW.status IN ('reviewing', 'resolved', 'dismissed')) OR
        (OLD.status IN ('resolved', 'dismissed') AND NEW.status = OLD.status)
    ) THEN
        RAISE EXCEPTION 'invalid community report status transition';
    END IF;

    NEW.updated_at := now();
    IF NEW.status IN ('resolved', 'dismissed') THEN
        NEW.resolved_at := COALESCE(OLD.resolved_at, now());
    ELSE
        NEW.resolved_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_reports_guard ON community_reports;
CREATE TRIGGER community_reports_guard
    BEFORE INSERT OR UPDATE OR DELETE ON community_reports
    FOR EACH ROW EXECUTE FUNCTION guard_community_report();
