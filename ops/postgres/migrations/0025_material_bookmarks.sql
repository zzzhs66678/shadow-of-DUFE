-- References only. A bookmark never authorizes a material or stores a file URL.
CREATE TABLE material_bookmarks (
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    material_id text NOT NULL CHECK (material_id ~ '^[0-9a-f]{20}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, material_id)
);

CREATE INDEX material_bookmarks_user_created_idx
    ON material_bookmarks (user_id, created_at DESC, material_id);

-- UUID snapshots, without a foreign key, preserve minimal audit evidence when
-- the user deletes their account. No names, credentials, tokens or file URLs.
CREATE TABLE material_bookmark_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id uuid NOT NULL,
    material_id text NOT NULL CHECK (material_id ~ '^[0-9a-f]{20}$'),
    action text NOT NULL CHECK (action IN ('added', 'removed')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION reject_material_bookmark_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'material bookmark events are append-only';
END;
$$;

CREATE TRIGGER material_bookmark_events_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON material_bookmark_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_material_bookmark_event_mutation();

REVOKE ALL ON material_bookmarks, material_bookmark_events FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reject_material_bookmark_event_mutation() FROM PUBLIC;

COMMENT ON TABLE material_bookmarks IS
    'Private material-ID references; current catalog and file authorization remain authoritative.';
