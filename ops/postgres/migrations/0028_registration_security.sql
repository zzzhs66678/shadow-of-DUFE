-- Additive migration: legacy users, verification state and sessions are untouched.
CREATE TABLE security_mail_sends (
  id uuid PRIMARY KEY,
  recipient_digest text NOT NULL CHECK (recipient_digest ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed'))
);
CREATE INDEX security_mail_recipient_time_idx ON security_mail_sends(recipient_digest,requested_at);
CREATE INDEX security_mail_time_idx ON security_mail_sends(requested_at);
CREATE TABLE registration_email_attempts (
  email_digest text PRIMARY KEY CHECK (email_digest ~ '^[a-f0-9]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  reset_at timestamptz NOT NULL
);
CREATE TABLE registration_challenges (
  id uuid PRIMARY KEY,
  normalized_email text NOT NULL,
  email_digest text NOT NULL REFERENCES registration_email_attempts(email_digest),
  purpose text NOT NULL DEFAULT 'registration' CHECK (purpose='registration'),
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  mail_send_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX registration_challenge_email_idx ON registration_challenges(normalized_email);
CREATE INDEX registration_challenge_expiry_idx ON registration_challenges(expires_at);
ALTER TABLE app_users ADD CONSTRAINT app_users_verified_registration_chk
  CHECK (registered_via <> 'verified_password' OR email_verified_at IS NOT NULL);
REVOKE ALL ON security_mail_sends,registration_email_attempts,registration_challenges FROM PUBLIC;
COMMENT ON TABLE registration_challenges IS 'Registration only; HMAC code proof bound to email, purpose and browser. Never stores passwords or raw codes.';
