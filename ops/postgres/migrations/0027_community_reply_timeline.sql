-- Derived titles use the first visible body line, including single-character
-- short posts. Preserve NOT NULL, the upper bound, all old data and audit guards.
ALTER TABLE community_topics
    DROP CONSTRAINT community_topics_title_check,
    ADD CONSTRAINT community_topics_title_check
        CHECK (char_length(title) BETWEEN 1 AND 120);

-- Activity is computed per viewer after bilateral block filtering, never copied
-- onto a global topic timestamp that could expose an invisible reply's activity.
CREATE INDEX IF NOT EXISTS community_comments_visible_activity_idx
    ON community_comments (topic_id, created_at DESC, id DESC)
    INCLUDE (author_user_id)
    WHERE status = 'published';
