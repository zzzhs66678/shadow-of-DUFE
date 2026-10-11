-- Keep NFKC and edge whitespace consistent with ECMAScript String.trim,
-- including OGHAM SPACE and BOM. Public case comparison is PostgreSQL lower;
-- login normalized_username retains its existing JavaScript comparison rule.
CREATE FUNCTION public_account_name_key(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT lower(btrim(normalize(value, NFKC),
        U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
$$;

ALTER TABLE app_users
    ADD COLUMN name_mode text NOT NULL DEFAULT 'name' CHECK (name_mode IN ('name', 'momo')),
    ADD COLUMN name_mode_changed_at timestamptz;

-- Legacy momo was stored as the public label. Recover only the already-owned
-- login name; do not invent names or silently merge collisions during upgrade.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM app_users
        WHERE public_account_name_key(display_name) = 'momo'
          AND (public_account_name_key(username) IS NULL OR public_account_name_key(username) = '')) THEN
        RAISE EXCEPTION 'legacy momo account requires an existing account name';
    END IF;
    IF EXISTS (
        SELECT reserved_name FROM (
            SELECT public_account_name_key(
                CASE WHEN public_account_name_key(display_name) = 'momo' THEN username ELSE COALESCE(display_name, username) END
            ) AS reserved_name FROM app_users
        ) AS names
        WHERE reserved_name IS NOT NULL AND reserved_name NOT IN ('', 'momo')
        GROUP BY reserved_name
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'account name reservations conflict; review existing names before migration';
    END IF;
END;
$$;

UPDATE app_users SET display_name = username, name_mode = 'momo'
    WHERE public_account_name_key(display_name) = 'momo';

-- Own names remain reserved even while their owner publicly chooses momo.
-- Login identifiers keep their existing unique constraint independently.
CREATE UNIQUE INDEX app_users_public_display_name_uidx
    ON app_users (public_account_name_key(COALESCE(display_name, username)))
    WHERE COALESCE(display_name, username) IS NOT NULL
      AND public_account_name_key(COALESCE(display_name, username)) NOT IN ('', 'momo');

CREATE TABLE account_name_change_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    original_username text,
    original_normalized_username text,
    original_display_name text,
    requested_username text CHECK (
        requested_username IS NULL OR char_length(requested_username) BETWEEN 1 AND 24
    ),
    requested_normalized_username text,
    requested_display_name text CHECK (
        requested_display_name IS NULL OR
            (char_length(requested_display_name) BETWEEN 1 AND 40
             AND public_account_name_key(requested_display_name) <> 'momo')
    ),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    reviewed_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    reviewer_session_id uuid REFERENCES user_sessions(id) ON DELETE SET NULL,
    reviewer_elevation_id uuid REFERENCES admin_elevated_sessions(id) ON DELETE SET NULL,
    review_transaction_id bigint,
    CHECK (requested_username IS NOT NULL OR requested_display_name IS NOT NULL),
    CHECK ((requested_username IS NULL) = (requested_normalized_username IS NULL)),
    CHECK ((status = 'pending') = (reviewed_at IS NULL))
);

CREATE UNIQUE INDEX account_name_change_requests_pending_user_uidx
    ON account_name_change_requests (user_id) WHERE status = 'pending';
CREATE INDEX account_name_change_requests_queue_idx
    ON account_name_change_requests (created_at, id) WHERE status = 'pending';
CREATE INDEX account_name_change_requests_user_idx
    ON account_name_change_requests (user_id, created_at DESC, id DESC);

-- The guard remains effective if application code is rolled back. A caller-set
-- context alone is insufficient: the exact approved snapshot and an active MFA
-- reviewer must exist in this same transaction. Unrelated account fields and
-- inserts retain their existing behavior.
CREATE FUNCTION enforce_account_name_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    review_id text;
    valid_review boolean;
BEGIN
    IF NEW.username IS NOT DISTINCT FROM OLD.username
       AND NEW.normalized_username IS NOT DISTINCT FROM OLD.normalized_username
       AND NEW.display_name IS NOT DISTINCT FROM OLD.display_name THEN
        RETURN NEW;
    END IF;

    review_id := current_setting('dufesh.account_name_review_id', true);
    IF review_id IS NULL OR review_id !~ '^[0-9a-fA-F-]{36}$' THEN
        RAISE EXCEPTION 'AUTH_NAME_REVIEW_REQUIRED' USING ERRCODE = '42501';
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM account_name_change_requests AS requests
        JOIN app_users AS reviewer ON reviewer.id = requests.reviewed_by
            AND reviewer.role = 'admin' AND reviewer.status = 'active'
        JOIN user_sessions AS sessions ON sessions.id = requests.reviewer_session_id
            AND sessions.user_id = reviewer.id
            AND sessions.revoked_at IS NULL AND sessions.expires_at > clock_timestamp()
        JOIN admin_elevated_sessions AS elevation ON elevation.id = requests.reviewer_elevation_id
            AND elevation.user_id = reviewer.id AND elevation.base_session_id = sessions.id
            AND elevation.revoked_at IS NULL AND elevation.expires_at > clock_timestamp()
        WHERE requests.id::text = review_id
          AND requests.user_id = OLD.id
          AND requests.status = 'approved'
          AND requests.review_transaction_id = txid_current()
          AND requests.original_username IS NOT DISTINCT FROM OLD.username
          AND requests.original_normalized_username IS NOT DISTINCT FROM OLD.normalized_username
          AND requests.original_display_name IS NOT DISTINCT FROM OLD.display_name
          AND NEW.username IS NOT DISTINCT FROM COALESCE(requests.requested_username, OLD.username)
          AND NEW.normalized_username IS NOT DISTINCT FROM COALESCE(requests.requested_normalized_username, OLD.normalized_username)
          AND NEW.display_name IS NOT DISTINCT FROM COALESCE(requests.requested_display_name, OLD.display_name)
    ) INTO valid_review;
    IF NOT valid_review THEN
        RAISE EXCEPTION 'AUTH_NAME_REVIEW_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER app_users_name_review_guard
    BEFORE UPDATE OF username, normalized_username, display_name ON app_users
    FOR EACH ROW EXECUTE FUNCTION enforce_account_name_review();

CREATE FUNCTION enforce_account_name_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    mode_session text;
BEGIN
    IF NEW.name_mode IS NOT DISTINCT FROM OLD.name_mode
       AND NEW.name_mode_changed_at IS NOT DISTINCT FROM OLD.name_mode_changed_at THEN
        RETURN NEW;
    END IF;
    IF NEW.name_mode IS NOT DISTINCT FROM OLD.name_mode THEN
        RAISE EXCEPTION 'AUTH_NAME_MODE_REVIEW_REQUIRED' USING ERRCODE = '42501';
    END IF;
    mode_session := current_setting('dufesh.account_name_mode_session_id', true);
    IF mode_session IS NULL OR mode_session !~ '^[0-9a-fA-F-]{36}$'
       OR OLD.status <> 'active' OR NEW.status <> 'active'
       OR NOT EXISTS (SELECT 1 FROM user_sessions WHERE id::text = mode_session
            AND user_id = OLD.id AND revoked_at IS NULL AND expires_at > clock_timestamp()) THEN
        RAISE EXCEPTION 'AUTH_NAME_MODE_REVIEW_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF NEW.name_mode = 'name' AND COALESCE(NULLIF(public_account_name_key(NEW.display_name), ''), NULLIF(public_account_name_key(NEW.username), '')) IS NULL THEN
        RAISE EXCEPTION 'AUTH_NAME_MODE_NAME_REQUIRED';
    END IF;
    IF OLD.name_mode_changed_at IS NOT NULL
       AND OLD.name_mode_changed_at + interval '7 days' > clock_timestamp() THEN
        RAISE EXCEPTION 'AUTH_NAME_MODE_COOLDOWN';
    END IF;
    NEW.name_mode_changed_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER app_users_name_mode_guard
    BEFORE UPDATE OF name_mode, name_mode_changed_at ON app_users
    FOR EACH ROW EXECUTE FUNCTION enforce_account_name_mode();

COMMENT ON INDEX app_users_public_display_name_uidx IS
    '自己的名字 NFKC/trim/lower 唯一，切换 momo 不释放保留名；含停用及删除账号。';
COMMENT ON FUNCTION public_account_name_key(text) IS
    '公开名字比较键：NFKC、完整 ECMAScript trim 空白字符集、PostgreSQL lower；不改变历史原名。';
COMMENT ON COLUMN app_users.name_mode IS
    '公开展示自己名字或 momo；各账号仍独立，首次切换后每次间隔 7 天。';
COMMENT ON TABLE account_name_change_requests IS
    '站内名字申请；申请不改名，仅管理员有效基础会话及 MFA 审核事务可批准。';
