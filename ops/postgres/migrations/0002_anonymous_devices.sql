CREATE TABLE IF NOT EXISTS anonymous_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    public_id uuid NOT NULL DEFAULT gen_random_uuid(),
    token_hash text NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    claimed_device_id uuid REFERENCES user_devices(id) ON DELETE SET NULL,
    claimed_at timestamptz,
    revoked_at timestamptz,
    UNIQUE (public_id),
    UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS anonymous_devices_last_seen_idx
    ON anonymous_devices (last_seen_at);

CREATE INDEX IF NOT EXISTS anonymous_devices_claimed_device_idx
    ON anonymous_devices (claimed_device_id)
    WHERE claimed_device_id IS NOT NULL;

COMMENT ON TABLE anonymous_devices IS
    '登录前设备身份；Cookie 保存随机令牌，数据库只保存带服务端 pepper 的摘要。';
