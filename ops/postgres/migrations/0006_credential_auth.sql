ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS username text,
    ADD COLUMN IF NOT EXISTS normalized_username text,
    ADD COLUMN IF NOT EXISTS email text,
    ADD COLUMN IF NOT EXISTS normalized_email text,
    ADD COLUMN IF NOT EXISTS email_verified_at timestamptz,
    ADD COLUMN IF NOT EXISTS school_account text,
    ADD COLUMN IF NOT EXISTS school_account_verified_at timestamptz,
    ADD COLUMN IF NOT EXISTS registered_via text NOT NULL DEFAULT 'oauth',
    ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_normalized_username_uidx
    ON app_users (normalized_username)
    WHERE normalized_username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_normalized_email_uidx
    ON app_users (normalized_email)
    WHERE normalized_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS app_users_last_login_idx
    ON app_users (last_login_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS password_credentials (
    user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    password_hash text NOT NULL,
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until timestamptz,
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_active_user_idx
    ON password_reset_tokens (user_id, expires_at DESC)
    WHERE consumed_at IS NULL;

COMMENT ON COLUMN app_users.normalized_username IS
    'NFKC、去首尾空白并转小写后的唯一用户名，仅用于查找与去重。';
COMMENT ON COLUMN app_users.normalized_email IS
    '去首尾空白并转小写后的唯一邮箱，仅用于查找与去重。';
COMMENT ON COLUMN app_users.school_account IS
    '可选校园账号；未经验证时不得作为真实学生身份凭据。';
COMMENT ON TABLE password_credentials IS
    '密码凭据；仅保存 Argon2id 编码哈希和服务端登录失败状态。';
COMMENT ON TABLE password_reset_tokens IS
    '一次性密码重置令牌；数据库只保存带服务器 pepper 的摘要。';
