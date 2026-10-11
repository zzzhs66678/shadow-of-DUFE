-- Public content is intentionally distinct from personal inbox announcements.
-- No seed content, user data rewrite, account FK or credential is introduced.
CREATE TABLE whiteboard_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('note', 'event')),
    title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
    body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
    guest text NOT NULL DEFAULT '' CHECK (char_length(guest) <= 80),
    guest_bio text NOT NULL DEFAULT '' CHECK (char_length(guest_bio) <= 1500),
    location text NOT NULL DEFAULT '' CHECK (char_length(location) <= 160),
    starts_at timestamptz CHECK (starts_at IS NULL OR isfinite(starts_at)),
    ends_at timestamptz CHECK (ends_at IS NULL OR isfinite(ends_at)),
    expires_at timestamptz CHECK (expires_at IS NULL OR isfinite(expires_at)),
    status text NOT NULL CHECK (status IN ('draft', 'published', 'withdrawn')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    published_at timestamptz CHECK (published_at IS NULL OR isfinite(published_at)),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (status <> 'published' OR published_at IS NOT NULL),
    CHECK (
      (kind = 'note' AND guest = '' AND guest_bio = '' AND location = '' AND starts_at IS NULL AND ends_at IS NULL) OR
      (kind = 'event' AND char_length(btrim(title)) > 0 AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at AND expires_at IS NULL)
    )
);
CREATE INDEX whiteboard_public_queue ON whiteboard_entries (published_at DESC, id DESC) WHERE status = 'published';
CREATE INDEX whiteboard_admin_queue ON whiteboard_entries (updated_at DESC, id DESC);

-- Immutable processing/idempotence receipts; actor UUID is a snapshot, not a
-- public field or cascading account FK. Retrying an old mutation returns the
-- original receipt, not a second publication or an unaudited mutation.
CREATE TABLE whiteboard_actions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id uuid NOT NULL REFERENCES whiteboard_entries(id),
    actor_user_id uuid NOT NULL,
    mutation_id uuid NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    operation text NOT NULL CHECK (operation IN ('create', 'update')),
    from_status text CHECK (from_status IN ('draft', 'published', 'withdrawn')),
    to_status text NOT NULL CHECK (to_status IN ('draft', 'published', 'withdrawn')),
    version integer NOT NULL CHECK (version > 0),
    receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (actor_user_id, mutation_id),
    UNIQUE (entry_id, version)
);

CREATE FUNCTION reject_whiteboard_action_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'whiteboard actions are append-only';
END;
$$;
CREATE TRIGGER whiteboard_actions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON whiteboard_actions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_whiteboard_action_mutation();
CREATE FUNCTION reject_whiteboard_entry_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'whiteboard entries must be soft-withdrawn';
END;
$$;
CREATE TRIGGER whiteboard_entries_soft_withdraw BEFORE DELETE OR TRUNCATE ON whiteboard_entries
    FOR EACH STATEMENT EXECUTE FUNCTION reject_whiteboard_entry_delete();
REVOKE ALL ON whiteboard_entries, whiteboard_actions FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reject_whiteboard_action_mutation(), reject_whiteboard_entry_delete() FROM PUBLIC;
