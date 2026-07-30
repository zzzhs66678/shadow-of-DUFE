CREATE TABLE IF NOT EXISTS user_sync_mutations (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    mutation_id text NOT NULL
        CHECK (char_length(mutation_id) BETWEEN 16 AND 128),
    payload_hash text NOT NULL
        CHECK (char_length(payload_hash) = 64),
    base_revision bigint NOT NULL
        CHECK (base_revision >= 0),
    applied_revision bigint NOT NULL
        CHECK (applied_revision >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, mutation_id)
);

CREATE INDEX IF NOT EXISTS user_sync_mutations_created_idx
    ON user_sync_mutations (created_at);

COMMENT ON TABLE user_sync_mutations IS
    '同步写请求的幂等键；同一用户重复提交 mutation_id 时不会重复应用。';
