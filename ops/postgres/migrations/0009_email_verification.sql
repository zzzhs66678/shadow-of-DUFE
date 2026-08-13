CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    normalized_email text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_active_user_idx
    ON email_verification_tokens (user_id, expires_at DESC)
    WHERE consumed_at IS NULL;

COMMENT ON TABLE email_verification_tokens IS
    '一次性邮箱验证令牌；摘要与申请时的规范化邮箱绑定，邮箱变化后不能继续使用。';
