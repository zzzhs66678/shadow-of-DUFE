CREATE TABLE IF NOT EXISTS app_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled', 'deleted')),
    display_name text,
    avatar_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS oauth_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    provider_subject text NOT NULL,
    union_id text,
    profile jsonb NOT NULL DEFAULT '{}'::jsonb,
    linked_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz,
    UNIQUE (provider, provider_subject)
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_identities_provider_union_id_uidx
    ON oauth_identities (provider, union_id)
    WHERE union_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS oauth_identities_user_id_idx
    ON oauth_identities (user_id);

CREATE TABLE IF NOT EXISTS user_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    public_id uuid NOT NULL DEFAULT gen_random_uuid(),
    label text,
    platform text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    UNIQUE (public_id)
);

CREATE INDEX IF NOT EXISTS user_devices_user_id_idx
    ON user_devices (user_id);

CREATE TABLE IF NOT EXISTS user_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    device_id uuid REFERENCES user_devices(id) ON DELETE SET NULL,
    token_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    rotated_from uuid REFERENCES user_sessions(id) ON DELETE SET NULL,
    ip_hash text,
    user_agent_hash text,
    UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS user_sessions_user_active_idx
    ON user_sessions (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS user_sessions_device_idx
    ON user_sessions (device_id);

COMMENT ON TABLE app_users IS '东财之影站内用户；不保存微信密码。';
COMMENT ON TABLE oauth_identities IS '外部授权身份；微信 OpenID/UnionID 仅在服务端保存。';
COMMENT ON TABLE user_devices IS '用户已登录设备，用于多设备同步和主动下线。';
COMMENT ON TABLE user_sessions IS '站内会话；只保存随机会话令牌的哈希。';
