CREATE TABLE IF NOT EXISTS user_academic_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    client_id text NOT NULL
        CHECK (char_length(client_id) BETWEEN 1 AND 64),
    academic_year text NOT NULL
        CHECK (academic_year ~ '^20[0-9]{2}-20[0-9]{2}$'),
    term text NOT NULL
        CHECK (term IN ('fall', 'spring')),
    term_label text NOT NULL
        CHECK (char_length(term_label) BETWEEN 1 AND 32),
    imported_at timestamptz NOT NULL,
    snapshot jsonb NOT NULL
        CHECK (jsonb_typeof(snapshot) = 'object')
        CHECK (octet_length(snapshot::text) <= 1048576),
    revision bigint NOT NULL CHECK (revision > 0),
    client_updated_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (user_id, client_id)
);

CREATE INDEX IF NOT EXISTS user_academic_snapshots_revision_idx
    ON user_academic_snapshots (user_id, revision);

CREATE INDEX IF NOT EXISTS user_academic_snapshots_term_idx
    ON user_academic_snapshots (user_id, academic_year DESC, term)
    WHERE deleted_at IS NULL;

COMMENT ON TABLE user_academic_snapshots IS
    '用户主动从正式教务导入的学期快照；仅保存规范化课表和考试数据，不保存教务凭据或会话。';

