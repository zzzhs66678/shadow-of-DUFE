CREATE TABLE IF NOT EXISTS community_topics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    author_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    title text NOT NULL CHECK (char_length(title) BETWEEN 4 AND 120),
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
    status text NOT NULL DEFAULT 'published'
        CHECK (status IN ('published', 'hidden', 'deleted')),
    visibility text NOT NULL DEFAULT 'public'
        CHECK (visibility IN ('public', 'unlisted')),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS community_topics_public_cursor_idx
    ON community_topics (created_at DESC, id DESC)
    WHERE status = 'published' AND visibility = 'public';
CREATE INDEX IF NOT EXISTS community_topics_author_idx
    ON community_topics (author_user_id, created_at DESC)
    WHERE author_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_community_content_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'community content must be soft-deleted';
END;
$$;

DROP TRIGGER IF EXISTS community_topics_soft_delete_guard
    ON community_topics;

CREATE TRIGGER community_topics_soft_delete_guard
    BEFORE DELETE OR TRUNCATE ON community_topics
    FOR EACH STATEMENT EXECUTE FUNCTION reject_community_content_hard_delete();

CREATE TABLE IF NOT EXISTS community_comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_id uuid NOT NULL REFERENCES community_topics(id) ON DELETE RESTRICT,
    author_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    parent_comment_id uuid REFERENCES community_comments(id) ON DELETE RESTRICT,
    root_comment_id uuid REFERENCES community_comments(id) ON DELETE RESTRICT,
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

CREATE OR REPLACE FUNCTION validate_community_comment_depth()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_topic_id uuid;
    parent_parent_id uuid;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW.topic_id IS DISTINCT FROM OLD.topic_id OR
        NEW.parent_comment_id IS DISTINCT FROM OLD.parent_comment_id OR
        NEW.root_comment_id IS DISTINCT FROM OLD.root_comment_id
    ) THEN
        RAISE EXCEPTION 'community comment thread identity is immutable';
    END IF;

    IF NEW.parent_comment_id IS NULL THEN
        NEW.root_comment_id := NULL;
        RETURN NEW;
    END IF;

    SELECT topic_id, parent_comment_id
    INTO parent_topic_id, parent_parent_id
    FROM community_comments
    WHERE id = NEW.parent_comment_id;

    IF NOT FOUND OR parent_topic_id <> NEW.topic_id THEN
        RAISE EXCEPTION 'community reply parent must belong to the same topic';
    END IF;
    IF parent_parent_id IS NOT NULL THEN
        RAISE EXCEPTION 'community replies are limited to two levels';
    END IF;

    NEW.root_comment_id := NEW.parent_comment_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_comments_depth_guard
    ON community_comments;

CREATE TRIGGER community_comments_depth_guard
    BEFORE INSERT OR UPDATE OF topic_id, parent_comment_id, root_comment_id
    ON community_comments
    FOR EACH ROW EXECUTE FUNCTION validate_community_comment_depth();

DROP TRIGGER IF EXISTS community_comments_soft_delete_guard
    ON community_comments;

CREATE TRIGGER community_comments_soft_delete_guard
    BEFORE DELETE OR TRUNCATE ON community_comments
    FOR EACH STATEMENT EXECUTE FUNCTION reject_community_content_hard_delete();

CREATE INDEX IF NOT EXISTS community_comments_topic_cursor_idx
    ON community_comments (topic_id, created_at ASC, id ASC)
    WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS community_comments_root_cursor_idx
    ON community_comments (root_comment_id, created_at ASC, id ASC)
    WHERE root_comment_id IS NOT NULL AND status <> 'deleted';
CREATE INDEX IF NOT EXISTS community_comments_author_idx
    ON community_comments (author_user_id, created_at DESC)
    WHERE author_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS community_content_edits (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id uuid,
    actor_label text CHECK (
        actor_label IS NULL OR char_length(actor_label) BETWEEN 1 AND 120
    ),
    content_type text NOT NULL CHECK (content_type IN ('topic', 'comment')),
    content_id uuid NOT NULL,
    previous_version bigint NOT NULL CHECK (previous_version >= 1),
    previous_title text,
    previous_body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (content_type = 'topic' AND previous_title IS NOT NULL) OR
        (content_type = 'comment' AND previous_title IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS community_content_edits_target_idx
    ON community_content_edits (content_type, content_id, created_at DESC);

DROP TRIGGER IF EXISTS community_content_edits_append_only
    ON community_content_edits;

CREATE TRIGGER community_content_edits_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON community_content_edits
    FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_audit_mutation();

CREATE OR REPLACE FUNCTION validate_community_content_edit_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.actor_user_id IS NOT NULL AND
       NOT EXISTS (SELECT 1 FROM app_users WHERE id = NEW.actor_user_id) THEN
        RAISE EXCEPTION 'community content edit actor does not exist';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_content_edits_actor_guard
    ON community_content_edits;

CREATE TRIGGER community_content_edits_actor_guard
    BEFORE INSERT ON community_content_edits
    FOR EACH ROW EXECUTE FUNCTION validate_community_content_edit_actor();

CREATE TABLE IF NOT EXISTS community_topic_likes (
    topic_id uuid NOT NULL REFERENCES community_topics(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (topic_id, user_id)
);

CREATE INDEX IF NOT EXISTS community_topic_likes_user_idx
    ON community_topic_likes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_comment_likes (
    comment_id uuid NOT NULL REFERENCES community_comments(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS community_comment_likes_user_idx
    ON community_comment_likes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_topic_bookmarks (
    topic_id uuid NOT NULL REFERENCES community_topics(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (topic_id, user_id)
);

CREATE INDEX IF NOT EXISTS community_topic_bookmarks_user_idx
    ON community_topic_bookmarks (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_user_blocks (
    blocker_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    blocked_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_user_id, blocked_user_id),
    CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX IF NOT EXISTS community_user_blocks_blocked_idx
    ON community_user_blocks (blocked_user_id, blocker_user_id);

CREATE OR REPLACE FUNCTION community_target_exists(
    target_type_value text,
    target_id_value uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF target_type_value = 'topic' THEN
        RETURN EXISTS (SELECT 1 FROM community_topics WHERE id = target_id_value);
    ELSIF target_type_value = 'comment' THEN
        RETURN EXISTS (SELECT 1 FROM community_comments WHERE id = target_id_value);
    ELSIF target_type_value = 'user' THEN
        RETURN EXISTS (SELECT 1 FROM app_users WHERE id = target_id_value);
    END IF;
    RETURN false;
END;
$$;

CREATE TABLE IF NOT EXISTS community_mentions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mentioned_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    topic_id uuid NOT NULL REFERENCES community_topics(id) ON DELETE CASCADE,
    comment_id uuid REFERENCES community_comments(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (actor_user_id IS NULL OR actor_user_id <> mentioned_user_id)
);

CREATE INDEX IF NOT EXISTS community_mentions_recipient_idx
    ON community_mentions (mentioned_user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS community_mentions_topic_uidx
    ON community_mentions (mentioned_user_id, topic_id)
    WHERE comment_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS community_mentions_comment_uidx
    ON community_mentions (mentioned_user_id, comment_id)
    WHERE comment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_community_mention_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    referenced_topic_id uuid;
BEGIN
    IF NEW.comment_id IS NOT NULL THEN
        SELECT topic_id INTO referenced_topic_id
        FROM community_comments
        WHERE id = NEW.comment_id;
        IF NOT FOUND OR referenced_topic_id <> NEW.topic_id THEN
            RAISE EXCEPTION 'community mention comment must belong to its topic';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_mentions_reference_guard
    ON community_mentions;

CREATE TRIGGER community_mentions_reference_guard
    BEFORE INSERT OR UPDATE OF topic_id, comment_id
    ON community_mentions
    FOR EACH ROW EXECUTE FUNCTION validate_community_mention_reference();

CREATE TABLE IF NOT EXISTS community_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    actor_user_id uuid,
    notification_type text NOT NULL CHECK (
        notification_type IN (
            'topic_reply', 'comment_reply', 'mention',
            'content_moderated', 'system_announcement'
        )
    ),
    topic_id uuid REFERENCES community_topics(id) ON DELETE SET NULL,
    comment_id uuid REFERENCES community_comments(id) ON DELETE SET NULL,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
    body text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 500),
    fallback_path text NOT NULL CHECK (
        char_length(fallback_path) BETWEEN 1 AND 500 AND
        left(fallback_path, 1) = '/' AND
        left(fallback_path, 2) <> '//' AND
        position('://' in fallback_path) = 0
    ),
    dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 8 AND 256),
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz,
    dismissed_at timestamptz,
    UNIQUE (recipient_user_id, dedupe_key),
    CHECK (actor_user_id IS NULL OR actor_user_id <> recipient_user_id)
);

CREATE INDEX IF NOT EXISTS community_notifications_unread_idx
    ON community_notifications (recipient_user_id, created_at DESC, id DESC)
    WHERE read_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS community_notifications_cursor_idx
    ON community_notifications (recipient_user_id, created_at DESC, id DESC)
    WHERE dismissed_at IS NULL;

CREATE OR REPLACE FUNCTION validate_community_notification_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    referenced_topic_id uuid;
BEGIN
    IF NEW.actor_user_id IS NOT NULL AND
       NOT community_target_exists('user', NEW.actor_user_id) THEN
        RAISE EXCEPTION 'community notification actor does not exist';
    END IF;
    IF NEW.comment_id IS NOT NULL THEN
        SELECT topic_id INTO referenced_topic_id
        FROM community_comments
        WHERE id = NEW.comment_id;
        IF NOT FOUND OR NEW.topic_id IS NULL OR referenced_topic_id <> NEW.topic_id THEN
            RAISE EXCEPTION 'community notification comment must belong to its topic';
        END IF;
    END IF;

    IF NEW.notification_type IN ('topic_reply', 'comment_reply') AND (
        NEW.actor_user_id IS NULL OR NEW.topic_id IS NULL OR NEW.comment_id IS NULL
    ) THEN
        RAISE EXCEPTION 'reply notification requires actor, topic and comment';
    END IF;
    IF NEW.notification_type = 'mention' AND (
        NEW.actor_user_id IS NULL OR NEW.topic_id IS NULL
    ) THEN
        RAISE EXCEPTION 'mention notification requires actor and topic';
    END IF;
    IF NEW.notification_type = 'system_announcement' AND NEW.actor_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'system notification cannot impersonate a user';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_notifications_reference_guard
    ON community_notifications;

CREATE TRIGGER community_notifications_reference_guard
    BEFORE INSERT OR UPDATE OF notification_type, actor_user_id, topic_id, comment_id
    ON community_notifications
    FOR EACH ROW EXECUTE FUNCTION validate_community_notification_reference();

CREATE TABLE IF NOT EXISTS community_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_user_id uuid NOT NULL,
    target_type text NOT NULL CHECK (target_type IN ('topic', 'comment', 'user')),
    target_id uuid NOT NULL,
    reason_code text NOT NULL CHECK (
        reason_code IN (
            'harassment', 'privacy', 'spam', 'misinformation',
            'illegal', 'self_harm', 'other'
        )
    ),
    detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 8 AND 1000),
    status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CHECK (
        (status IN ('resolved', 'dismissed')) = (resolved_at IS NOT NULL)
    ),
    CHECK (reason_code <> 'other' OR detail IS NOT NULL)
);

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
        RETURN NEW;
    END IF;

    IF NEW.reporter_user_id IS DISTINCT FROM OLD.reporter_user_id OR
       NEW.target_type IS DISTINCT FROM OLD.target_type OR
       NEW.target_id IS DISTINCT FROM OLD.target_id OR
       NEW.reason_code IS DISTINCT FROM OLD.reason_code OR
       NEW.detail IS DISTINCT FROM OLD.detail OR
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

DROP TRIGGER IF EXISTS community_reports_guard
    ON community_reports;

CREATE TRIGGER community_reports_guard
    BEFORE INSERT OR UPDATE OR DELETE ON community_reports
    FOR EACH ROW EXECUTE FUNCTION guard_community_report();

CREATE UNIQUE INDEX IF NOT EXISTS community_reports_open_dedupe_uidx
    ON community_reports (reporter_user_id, target_type, target_id)
    WHERE status IN ('open', 'reviewing');
CREATE INDEX IF NOT EXISTS community_reports_queue_idx
    ON community_reports (status, created_at ASC, id ASC)
    WHERE status IN ('open', 'reviewing');

CREATE TABLE IF NOT EXISTS community_moderation_cases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type text NOT NULL CHECK (target_type IN ('topic', 'comment', 'user')),
    target_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'reviewing', 'resolved', 'appealed', 'closed')),
    assigned_moderator_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    opened_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CHECK (
        status IN ('appealed') OR
        ((status IN ('resolved', 'closed')) = (resolved_at IS NOT NULL))
    )
);

CREATE OR REPLACE FUNCTION guard_community_moderation_case()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'community moderation cases cannot be deleted';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'open' OR
           NOT community_target_exists(NEW.target_type, NEW.target_id) THEN
            RAISE EXCEPTION 'invalid community moderation case';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.target_type IS DISTINCT FROM OLD.target_type OR
       NEW.target_id IS DISTINCT FROM OLD.target_id OR
       NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
        RAISE EXCEPTION 'community moderation case target is immutable';
    END IF;
    IF NOT (
        (OLD.status = 'open' AND NEW.status IN ('open', 'reviewing', 'resolved', 'closed')) OR
        (OLD.status = 'reviewing' AND NEW.status IN ('reviewing', 'resolved', 'closed')) OR
        (OLD.status = 'resolved' AND NEW.status IN ('resolved', 'appealed', 'closed')) OR
        (OLD.status = 'appealed' AND NEW.status IN ('appealed', 'reviewing', 'resolved', 'closed')) OR
        (OLD.status = 'closed' AND NEW.status = 'closed')
    ) THEN
        RAISE EXCEPTION 'invalid community moderation case status transition';
    END IF;

    NEW.updated_at := now();
    IF NEW.status IN ('resolved', 'closed') THEN
        NEW.resolved_at := COALESCE(OLD.resolved_at, now());
    ELSIF NEW.status IN ('open', 'reviewing') THEN
        NEW.resolved_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_moderation_cases_guard
    ON community_moderation_cases;

CREATE TRIGGER community_moderation_cases_guard
    BEFORE INSERT OR UPDATE OR DELETE ON community_moderation_cases
    FOR EACH ROW EXECUTE FUNCTION guard_community_moderation_case();

CREATE UNIQUE INDEX IF NOT EXISTS community_moderation_cases_active_uidx
    ON community_moderation_cases (target_type, target_id)
    WHERE status IN ('open', 'reviewing', 'appealed');
CREATE INDEX IF NOT EXISTS community_moderation_cases_queue_idx
    ON community_moderation_cases (status, opened_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS community_case_reports (
    case_id uuid NOT NULL
        REFERENCES community_moderation_cases(id) ON DELETE RESTRICT,
    report_id uuid NOT NULL REFERENCES community_reports(id) ON DELETE RESTRICT,
    linked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (case_id, report_id),
    UNIQUE (report_id)
);

CREATE OR REPLACE FUNCTION guard_community_case_report()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    case_target_type text;
    case_target_id uuid;
    report_target_type text;
    report_target_id uuid;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'community case-report links are append-only';
    END IF;

    SELECT target_type, target_id
    INTO case_target_type, case_target_id
    FROM community_moderation_cases
    WHERE id = NEW.case_id;
    SELECT target_type, target_id
    INTO report_target_type, report_target_id
    FROM community_reports
    WHERE id = NEW.report_id;

    IF case_target_type IS NULL OR report_target_type IS NULL OR
       case_target_type <> report_target_type OR
       case_target_id <> report_target_id THEN
        RAISE EXCEPTION 'community report target must match its moderation case';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_case_reports_guard
    ON community_case_reports;

CREATE TRIGGER community_case_reports_guard
    BEFORE INSERT OR UPDATE OR DELETE ON community_case_reports
    FOR EACH ROW EXECUTE FUNCTION guard_community_case_report();

CREATE TABLE IF NOT EXISTS community_moderation_actions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id uuid REFERENCES community_moderation_cases(id) ON DELETE RESTRICT,
    actor_user_id uuid,
    actor_label text CHECK (
        actor_label IS NULL OR char_length(actor_label) BETWEEN 1 AND 120
    ),
    actor_role text NOT NULL CHECK (actor_role IN ('moderator', 'admin', 'system')),
    action text NOT NULL CHECK (
        action IN (
            'case_opened', 'assigned', 'hide', 'restore', 'delete',
            'warn', 'suspend', 'ban', 'unban', 'dismiss',
            'appeal_opened', 'appeal_resolved'
        )
    ),
    target_type text NOT NULL CHECK (target_type IN ('topic', 'comment', 'user')),
    target_id uuid NOT NULL,
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 1000),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    request_id uuid UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (actor_role = 'system' AND actor_user_id IS NULL) OR
        (actor_role IN ('moderator', 'admin') AND actor_user_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS community_moderation_actions_case_idx
    ON community_moderation_actions (case_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS community_moderation_actions_target_idx
    ON community_moderation_actions (target_type, target_id, created_at DESC);

CREATE OR REPLACE FUNCTION validate_community_moderation_action()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    case_target_type text;
    case_target_id uuid;
BEGIN
    IF NEW.actor_user_id IS NOT NULL AND
       NOT community_target_exists('user', NEW.actor_user_id) THEN
        RAISE EXCEPTION 'community moderation action actor does not exist';
    END IF;
    IF NEW.case_id IS NOT NULL THEN
        SELECT target_type, target_id
        INTO case_target_type, case_target_id
        FROM community_moderation_cases
        WHERE id = NEW.case_id;
        IF NOT FOUND OR case_target_type <> NEW.target_type OR case_target_id <> NEW.target_id THEN
            RAISE EXCEPTION 'community moderation action target must match its case';
        END IF;
    ELSIF NOT community_target_exists(NEW.target_type, NEW.target_id) THEN
        RAISE EXCEPTION 'community moderation action target does not exist';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_moderation_actions_reference_guard
    ON community_moderation_actions;

CREATE TRIGGER community_moderation_actions_reference_guard
    BEFORE INSERT ON community_moderation_actions
    FOR EACH ROW EXECUTE FUNCTION validate_community_moderation_action();

DROP TRIGGER IF EXISTS community_moderation_actions_append_only
    ON community_moderation_actions;

CREATE TRIGGER community_moderation_actions_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON community_moderation_actions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_audit_mutation();

CREATE TABLE IF NOT EXISTS community_user_sanctions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    sanction_type text NOT NULL CHECK (sanction_type IN ('posting_suspension', 'ban')),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 1000),
    starts_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    revoked_at timestamptz,
    created_by_user_id uuid,
    revoked_by_user_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at IS NULL OR expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS community_user_sanctions_active_idx
    ON community_user_sanctions (user_id, starts_at DESC)
    WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION guard_community_user_sanction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'community user sanctions cannot be deleted';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NOT community_target_exists('user', NEW.user_id) OR
           NEW.revoked_at IS NOT NULL OR
           NEW.revoked_by_user_id IS NOT NULL OR
           (NEW.created_by_user_id IS NOT NULL AND
            NOT community_target_exists('user', NEW.created_by_user_id)) THEN
            RAISE EXCEPTION 'invalid community user sanction identity';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR
       NEW.sanction_type IS DISTINCT FROM OLD.sanction_type OR
       NEW.reason IS DISTINCT FROM OLD.reason OR
       NEW.starts_at IS DISTINCT FROM OLD.starts_at OR
       NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
       NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'community user sanction evidence is immutable';
    END IF;
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
       NEW.revoked_by_user_id IS NULL OR
       NOT community_target_exists('user', NEW.revoked_by_user_id) THEN
        RAISE EXCEPTION 'invalid community user sanction revocation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_user_sanctions_guard
    ON community_user_sanctions;

CREATE TRIGGER community_user_sanctions_guard
    BEFORE INSERT OR UPDATE OR DELETE ON community_user_sanctions
    FOR EACH ROW EXECUTE FUNCTION guard_community_user_sanction();

COMMENT ON TABLE community_comments IS
    '主题评论与一层回复；数据库触发器禁止产生第三层嵌套。';
COMMENT ON TABLE community_notifications IS
    '站内通知保留 fallback_path；内容删除后仍可进入明确的降级页。';
COMMENT ON TABLE community_moderation_actions IS
    '社区治理不可变审计链；运行角色只能追加，不能修改或删除。';
