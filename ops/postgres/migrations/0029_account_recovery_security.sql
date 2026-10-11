-- Existing accounts, email verification state and sessions are unchanged.
-- Tokens issued before this migration have no snapshot and fail closed.
ALTER TABLE password_reset_tokens
    ADD COLUMN normalized_email text,
    ADD COLUMN credential_version timestamptz,
    ADD COLUMN delivery_status text NOT NULL DEFAULT 'pending'
        CHECK (delivery_status IN ('pending', 'delivered', 'failed'));

ALTER TABLE email_verification_tokens
    ADD COLUMN session_id uuid REFERENCES user_sessions(id) ON DELETE CASCADE,
    ADD COLUMN credential_version timestamptz,
    ADD COLUMN delivery_status text NOT NULL DEFAULT 'pending'
        CHECK (delivery_status IN ('pending', 'delivered', 'failed'));

COMMENT ON COLUMN password_reset_tokens.credential_version IS
    'SQL-precision password_changed_at snapshot; stale, unbound and undelivered tokens cannot reset a password.';
COMMENT ON COLUMN email_verification_tokens.session_id IS
    'Active initiating session, checked again during verification; logging out invalidates its verification token.';
