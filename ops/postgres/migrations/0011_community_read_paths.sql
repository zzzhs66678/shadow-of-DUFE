BEGIN;

-- Public comment threads retain soft-deleted roots as tombstones. These
-- indexes intentionally include deleted rows so cursor pagination can keep
-- the original thread anchor and load its replies without a table scan.
CREATE INDEX IF NOT EXISTS community_comments_public_roots_cursor_idx
    ON community_comments (topic_id, created_at ASC, id ASC)
    WHERE parent_comment_id IS NULL;

CREATE INDEX IF NOT EXISTS community_comments_public_replies_cursor_idx
    ON community_comments (root_comment_id, created_at ASC, id ASC)
    WHERE root_comment_id IS NOT NULL;

COMMIT;
