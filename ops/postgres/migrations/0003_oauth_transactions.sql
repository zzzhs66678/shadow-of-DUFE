CREATE TABLE IF NOT EXISTS oauth_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    state_hash text NOT NULL,
    browser_token_hash text NOT NULL,
    anonymous_device_id uuid NOT NULL
        REFERENCES anonymous_devices(id) ON DELETE CASCADE,
    return_to text NOT NULL DEFAULT '/',
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    UNIQUE (state_hash)
);

CREATE INDEX IF NOT EXISTS oauth_transactions_expiry_idx
    ON oauth_transactions (expires_at)
    WHERE consumed_at IS NULL;

COMMENT ON TABLE oauth_transactions IS
    '一次性 OAuth 登录事务；state 和浏览器绑定令牌只保存 HMAC 摘要。';
