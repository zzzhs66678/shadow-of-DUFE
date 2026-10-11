ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'moderator', 'admin'));

CREATE TABLE IF NOT EXISTS admin_mfa_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
    key_id text NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 48),
    encrypted_secret text NOT NULL,
    secret_iv text NOT NULL,
    secret_auth_tag text NOT NULL,
    last_totp_step bigint,
    enrolled_at timestamptz NOT NULL DEFAULT now(),
    rotated_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_recovery_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    code_hash text NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (code_hash)
);

CREATE INDEX IF NOT EXISTS admin_recovery_codes_active_user_idx
    ON admin_recovery_codes (user_id, created_at)
    WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_elevated_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    base_session_id uuid NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    method text NOT NULL CHECK (method IN ('totp', 'recovery_code')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    ip_hash text,
    user_agent_hash text
);

CREATE INDEX IF NOT EXISTS admin_elevated_sessions_active_idx
    ON admin_elevated_sessions (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id uuid,
    actor_role text,
    session_id uuid,
    action text NOT NULL CHECK (char_length(action) BETWEEN 3 AND 96),
    target_type text CHECK (
        target_type IS NULL OR char_length(target_type) BETWEEN 1 AND 48
    ),
    target_id text CHECK (
        target_id IS NULL OR char_length(target_id) BETWEEN 1 AND 128
    ),
    request_id uuid UNIQUE,
    ip_hash text,
    user_agent_hash text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_events_created_idx
    ON admin_audit_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS admin_audit_events_actor_idx
    ON admin_audit_events (actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_admin_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'admin audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS admin_audit_events_append_only
    ON admin_audit_events;

CREATE TRIGGER admin_audit_events_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON admin_audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_audit_mutation();

COMMENT ON COLUMN app_users.role IS
    '服务端权限角色；客户端字段永远不能直接修改。';
COMMENT ON TABLE admin_mfa_credentials IS
    '管理员 TOTP 凭据；密钥使用可轮换的独立服务端密钥以 AES-256-GCM 加密。';
COMMENT ON TABLE admin_recovery_codes IS
    '管理员单次恢复码；只保存带独立恢复码 pepper 的摘要。';
COMMENT ON TABLE admin_elevated_sessions IS
    '绑定基础会话的短期管理员提升会话；令牌只保存摘要。';
COMMENT ON TABLE admin_audit_events IS
    '仅追加的管理员安全审计事件；禁止 UPDATE 与 DELETE。';
