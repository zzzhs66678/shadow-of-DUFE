CREATE TABLE IF NOT EXISTS community_announcements (
    id uuid PRIMARY KEY,
    title text NOT NULL CHECK (char_length(title) BETWEEN 4 AND 160),
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
    fallback_path text NOT NULL CHECK (
        char_length(fallback_path) BETWEEN 1 AND 500 AND
        left(fallback_path, 1) = '/' AND
        left(fallback_path, 2) <> '//' AND
        position('://' in fallback_path) = 0 AND
        position(E'\\' in fallback_path) = 0
    ),
    audience text NOT NULL DEFAULT 'all_active'
        CHECK (audience = 'all_active'),
    delivery_count integer NOT NULL CHECK (delivery_count >= 0),
    created_by_admin_user_id uuid NOT NULL,
    created_by_label text NOT NULL CHECK (
        char_length(created_by_label) BETWEEN 1 AND 160
    ),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS community_announcements_created_idx
    ON community_announcements (created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_community_announcement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'community announcements are append-only';
END;
$$;

DROP TRIGGER IF EXISTS community_announcements_append_only
    ON community_announcements;

CREATE TRIGGER community_announcements_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON community_announcements
    FOR EACH STATEMENT EXECUTE FUNCTION reject_community_announcement_mutation();

COMMENT ON TABLE community_announcements IS
    '不可变系统公告主记录；id 同时作为前端重试幂等键，delivery_count 记录首次原子投递数量。';

REVOKE ALL PRIVILEGES ON community_announcements FROM PUBLIC;
