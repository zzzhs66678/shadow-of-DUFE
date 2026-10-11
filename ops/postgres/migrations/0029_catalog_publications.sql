CREATE TABLE IF NOT EXISTS catalog_releases (
    kind text NOT NULL CHECK (kind IN ('courses', 'materials')),
    version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
    full_gzip bytea NOT NULL CHECK (octet_length(full_gzip) BETWEEN 1 AND 3250000),
    full_size integer NOT NULL CHECK (full_size BETWEEN 1 AND 3250000),
    core_gzip bytea,
    core_size integer,
    catalog_id text CHECK (catalog_id IS NULL OR catalog_id ~ '^course-v1:[a-f0-9]{64}$'),
    summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(summary::text) <= 16384),
    source_name text NOT NULL CHECK (char_length(source_name) BETWEEN 1 AND 160),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, version),
    CHECK ((kind = 'courses' AND core_gzip IS NOT NULL AND core_size BETWEEN 1 AND 750000 AND catalog_id IS NOT NULL)
      OR (kind = 'materials' AND core_gzip IS NULL AND core_size IS NULL AND catalog_id IS NULL AND full_size <= 420000))
);

CREATE TABLE IF NOT EXISTS catalog_heads (
    kind text PRIMARY KEY CHECK (kind IN ('courses', 'materials')),
    version text,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0 AND revision <= 9007199254740991),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (kind, version) REFERENCES catalog_releases(kind, version) ON DELETE RESTRICT
);
INSERT INTO catalog_heads(kind) VALUES ('courses'), ('materials') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS catalog_publication_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('courses', 'materials')),
    revision bigint NOT NULL CHECK (revision > 0),
    version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
    previous_version text NOT NULL CHECK (previous_version ~ '^[a-f0-9]{64}$'),
    action text NOT NULL CHECK (action IN ('publish', 'rollback')),
    actor_user_id uuid NOT NULL,
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 500),
    source_name text NOT NULL CHECK (char_length(source_name) BETWEEN 1 AND 160),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, revision)
);
CREATE INDEX IF NOT EXISTS catalog_publication_events_history ON catalog_publication_events(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS catalog_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('courses', 'materials')),
    actor_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    base_revision bigint NOT NULL CHECK (base_revision >= 0),
    base_version text NOT NULL CHECK (base_version ~ '^[a-f0-9]{64}$'),
    course_revision bigint NOT NULL CHECK (course_revision >= 0),
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
    full_gzip bytea NOT NULL CHECK (octet_length(full_gzip) BETWEEN 1 AND 3250000),
    full_size integer NOT NULL CHECK (full_size BETWEEN 1 AND 3250000),
    core_gzip bytea,
    core_size integer,
    catalog_id text CHECK (catalog_id IS NULL OR catalog_id ~ '^course-v1:[a-f0-9]{64}$'),
    summary jsonb NOT NULL CHECK (octet_length(summary::text) <= 16384),
    changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) <= 50 AND octet_length(changes::text) <= 100000),
    warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings) = 'array' AND jsonb_array_length(warnings) <= 100 AND octet_length(warnings::text) <= 20000),
    source_name text NOT NULL CHECK (char_length(source_name) BETWEEN 1 AND 160),
    publication_id uuid REFERENCES catalog_publication_events(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '20 minutes',
    UNIQUE (actor_user_id, kind, base_revision, request_hash),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '20 minutes'),
    CHECK ((kind = 'courses' AND core_gzip IS NOT NULL AND core_size BETWEEN 1 AND 750000 AND catalog_id IS NOT NULL)
      OR (kind = 'materials' AND core_gzip IS NULL AND core_size IS NULL AND catalog_id IS NULL AND full_size <= 420000))
);
CREATE INDEX IF NOT EXISTS catalog_drafts_owner ON catalog_drafts(actor_user_id, expires_at);

CREATE TABLE IF NOT EXISTS catalog_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
    extension text NOT NULL CHECK (extension IN ('pdf', 'pptx', 'docx', 'xlsx', 'zip')),
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    published_at timestamptz,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS catalog_files_staged_owner ON catalog_files(actor_user_id, expires_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS catalog_schedule_origins (
    catalog_id text NOT NULL CHECK (catalog_id ~ '^course-v1:[a-f0-9]{64}$'),
    schedule_id text NOT NULL CHECK (char_length(schedule_id) BETWEEN 1 AND 160),
    origin_catalog_id text NOT NULL CHECK (origin_catalog_id ~ '^course-v1:[a-f0-9]{64}$'),
    PRIMARY KEY (catalog_id, schedule_id, origin_catalog_id)
);

CREATE OR REPLACE FUNCTION guard_catalog_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'published catalog evidence is immutable';
END;
$$;
DROP TRIGGER IF EXISTS catalog_releases_immutable ON catalog_releases;
CREATE TRIGGER catalog_releases_immutable BEFORE UPDATE OR DELETE ON catalog_releases
    FOR EACH ROW EXECUTE FUNCTION guard_catalog_immutable();
DROP TRIGGER IF EXISTS catalog_publication_events_immutable ON catalog_publication_events;
CREATE TRIGGER catalog_publication_events_immutable BEFORE UPDATE OR DELETE ON catalog_publication_events
    FOR EACH ROW EXECUTE FUNCTION guard_catalog_immutable();
DROP TRIGGER IF EXISTS catalog_schedule_origins_immutable ON catalog_schedule_origins;
CREATE TRIGGER catalog_schedule_origins_immutable BEFORE UPDATE OR DELETE ON catalog_schedule_origins
    FOR EACH ROW EXECUTE FUNCTION guard_catalog_immutable();

CREATE OR REPLACE FUNCTION guard_catalog_head_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'catalog publication heads cannot be deleted'; END IF;
    IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'catalog revision must advance exactly once';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS catalog_head_revision ON catalog_heads;
CREATE TRIGGER catalog_head_revision BEFORE UPDATE OR DELETE ON catalog_heads
    FOR EACH ROW EXECUTE FUNCTION guard_catalog_head_revision();

CREATE OR REPLACE FUNCTION guard_catalog_file_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.published_at IS NOT NULL THEN RAISE EXCEPTION 'published catalog files cannot be deleted'; END IF;
        RETURN OLD;
    END IF;
    IF (to_jsonb(NEW) - 'published_at') IS DISTINCT FROM (to_jsonb(OLD) - 'published_at') OR
       OLD.published_at IS NOT NULL OR NEW.published_at IS NULL THEN
        RAISE EXCEPTION 'catalog file identity is immutable';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS catalog_file_identity ON catalog_files;
CREATE TRIGGER catalog_file_identity BEFORE UPDATE OR DELETE ON catalog_files
    FOR EACH ROW EXECUTE FUNCTION guard_catalog_file_identity();

CREATE OR REPLACE FUNCTION guard_catalog_draft_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - 'publication_id') IS DISTINCT FROM (to_jsonb(OLD) - 'publication_id') OR
       OLD.publication_id IS NOT NULL OR NEW.publication_id IS NULL THEN
        RAISE EXCEPTION 'catalog draft evidence is immutable';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS catalog_draft_identity ON catalog_drafts;
CREATE TRIGGER catalog_draft_identity BEFORE UPDATE ON catalog_drafts
    FOR EACH ROW EXECUTE FUNCTION guard_catalog_draft_identity();

COMMENT ON TABLE catalog_releases IS 'Immutable bounded public catalog snapshots; drafts never appear in this table.';
COMMENT ON TABLE catalog_heads IS 'Atomic per-kind publication pointer, with monotonically increasing revision to prevent ABA.';
COMMENT ON TABLE catalog_drafts IS 'Actor-scoped 20 minute preflight snapshots; publication validates current references again.';
COMMENT ON TABLE catalog_files IS 'Owned staged uploads; only explicit material publication promotes them to immutable public files.';
