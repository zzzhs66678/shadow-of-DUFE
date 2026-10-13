CREATE TABLE miniprogram_wechat_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id text NOT NULL CHECK (app_id ~ '^wx[0-9a-f]{16}$'),
    openid_hash text NOT NULL CHECK (openid_hash ~ '^[0-9a-f]{64}$'),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (app_id, openid_hash),
    UNIQUE (app_id, user_id)
);

CREATE FUNCTION reject_miniprogram_wechat_identity_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'WeChat identity bindings cannot be changed'
        USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER miniprogram_wechat_identity_immutable
BEFORE UPDATE ON miniprogram_wechat_identities
FOR EACH ROW EXECUTE FUNCTION reject_miniprogram_wechat_identity_update();

CREATE UNIQUE INDEX user_sessions_id_owner_uidx ON user_sessions (id, user_id);

CREATE TABLE miniprogram_wechat_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    app_id text NOT NULL CHECK (app_id ~ '^wx[0-9a-f]{16}$'),
    openid_hash text NOT NULL CHECK (openid_hash ~ '^[0-9a-f]{64}$'),
    user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
    session_id uuid,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    FOREIGN KEY (session_id, user_id) REFERENCES user_sessions(id, user_id) ON DELETE CASCADE,
    CHECK ((user_id IS NULL) = (session_id IS NULL)),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes')
);
CREATE INDEX miniprogram_wechat_challenges_expiry_idx
    ON miniprogram_wechat_challenges (expires_at);

COMMENT ON TABLE miniprogram_wechat_identities IS
    'Explicit native WeChat bindings to existing website UUIDs. OpenID is purpose-separated HMAC only; no session_key or UnionID.';
COMMENT ON TABLE miniprogram_wechat_challenges IS
    'Short-lived single-use binding challenges. Binding requires the exact original live native session and current website password.';
