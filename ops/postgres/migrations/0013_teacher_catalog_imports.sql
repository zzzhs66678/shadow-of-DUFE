CREATE TABLE IF NOT EXISTS data_import_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_type text NOT NULL CHECK (
        import_type IN ('teacher_reviews', 'teaching_section_textbooks')
    ),
    source_filename text NOT NULL CHECK (char_length(source_filename) BETWEEN 1 AND 255),
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    mapping_version text NOT NULL CHECK (char_length(mapping_version) BETWEEN 1 AND 64),
    status text NOT NULL DEFAULT 'preflight' CHECK (
        status IN ('preflight', 'ready', 'applying', 'applied', 'failed', 'rolled_back')
    ),
    dry_run boolean NOT NULL DEFAULT true,
    row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    accepted_count integer NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
    warning_count integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
    rejected_count integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    created_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    applied_at timestamptz,
    rolled_back_at timestamptz,
    CHECK (accepted_count + warning_count + rejected_count <= row_count),
    CHECK ((status IN ('applied', 'rolled_back')) = (applied_at IS NOT NULL)),
    CHECK ((status = 'rolled_back') = (rolled_back_at IS NOT NULL)),
    CHECK (status NOT IN ('applied', 'rolled_back') OR dry_run = false)
);

CREATE INDEX IF NOT EXISTS data_import_batches_fingerprint_idx
    ON data_import_batches (import_type, source_sha256, mapping_version, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS data_import_batches_applied_fingerprint_uidx
    ON data_import_batches (import_type, source_sha256, mapping_version)
    WHERE status = 'applied';

CREATE OR REPLACE FUNCTION guard_data_import_batch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'data import batches cannot be deleted';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.import_type IS DISTINCT FROM OLD.import_type OR
           NEW.source_filename IS DISTINCT FROM OLD.source_filename OR
           NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256 OR
           NEW.mapping_version IS DISTINCT FROM OLD.mapping_version OR
           NEW.dry_run IS DISTINCT FROM OLD.dry_run OR
           NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR
           NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'data import source identity is immutable';
        END IF;

        IF NOT (
            (OLD.status = 'preflight' AND NEW.status IN ('preflight', 'ready', 'failed')) OR
            (OLD.status = 'ready' AND NEW.status IN ('ready', 'applying', 'failed')) OR
            (OLD.status = 'applying' AND NEW.status IN ('applying', 'applied', 'failed')) OR
            (OLD.status = 'applied' AND NEW.status IN ('applied', 'rolled_back')) OR
            (OLD.status IN ('failed', 'rolled_back') AND NEW.status = OLD.status)
        ) THEN
            RAISE EXCEPTION 'invalid data import batch status transition';
        END IF;

        IF OLD.status IN ('applied', 'failed', 'rolled_back') AND (
            NEW.row_count IS DISTINCT FROM OLD.row_count OR
            NEW.accepted_count IS DISTINCT FROM OLD.accepted_count OR
            NEW.warning_count IS DISTINCT FROM OLD.warning_count OR
            NEW.rejected_count IS DISTINCT FROM OLD.rejected_count
        ) THEN
            RAISE EXCEPTION 'finished data import counts are immutable';
        END IF;

        IF NEW.status = 'applied' THEN
            NEW.applied_at := COALESCE(OLD.applied_at, now());
        ELSE
            NEW.applied_at := OLD.applied_at;
        END IF;
        IF NEW.status = 'rolled_back' THEN
            NEW.rolled_back_at := COALESCE(OLD.rolled_back_at, now());
        ELSE
            NEW.rolled_back_at := OLD.rolled_back_at;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS data_import_batches_guard ON data_import_batches;
CREATE TRIGGER data_import_batches_guard
    BEFORE UPDATE OR DELETE ON data_import_batches
    FOR EACH ROW EXECUTE FUNCTION guard_data_import_batch();

CREATE TABLE IF NOT EXISTS data_import_rows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id uuid NOT NULL REFERENCES data_import_batches(id) ON DELETE RESTRICT,
    source_sheet text NOT NULL CHECK (char_length(source_sheet) BETWEEN 1 AND 120),
    source_row integer NOT NULL CHECK (source_row >= 1),
    source_column integer CHECK (source_column IS NULL OR source_column >= 1),
    source_locator text NOT NULL CHECK (char_length(source_locator) BETWEEN 3 AND 180),
    source_key text CHECK (source_key IS NULL OR char_length(source_key) BETWEEN 1 AND 500),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    disposition text NOT NULL CHECK (
        disposition IN ('accepted', 'warning', 'rejected', 'applied', 'rolled_back')
    ),
    risk_flags text[] NOT NULL DEFAULT '{}',
    error_codes text[] NOT NULL DEFAULT '{}',
    error_message text CHECK (
        error_message IS NULL OR char_length(error_message) BETWEEN 1 AND 2000
    ),
    sanitized_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    applied_entity_type text,
    applied_entity_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (batch_id, source_locator),
    CHECK ((applied_entity_type IS NULL) = (applied_entity_id IS NULL)),
    CHECK (
        disposition NOT IN ('applied', 'rolled_back') OR applied_entity_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS data_import_rows_batch_disposition_idx
    ON data_import_rows (batch_id, disposition, source_row, source_column);
CREATE INDEX IF NOT EXISTS data_import_rows_content_idx
    ON data_import_rows (batch_id, content_sha256);

CREATE OR REPLACE FUNCTION reject_data_import_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'data import row evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS data_import_rows_append_only ON data_import_rows;
CREATE TRIGGER data_import_rows_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON data_import_rows
    FOR EACH STATEMENT EXECUTE FUNCTION reject_data_import_row_mutation();

CREATE TABLE IF NOT EXISTS data_import_mutations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id uuid NOT NULL REFERENCES data_import_batches(id) ON DELETE RESTRICT,
    import_row_id uuid NOT NULL REFERENCES data_import_rows(id) ON DELETE RESTRICT,
    entity_type text NOT NULL CHECK (
        entity_type IN (
            'teacher', 'teacher_source_identity', 'teacher_course_section',
            'teaching_section_textbook', 'teacher_review_candidate'
        )
    ),
    entity_id uuid NOT NULL,
    mutation_type text NOT NULL CHECK (
        mutation_type IN ('created', 'superseded', 'withdrawn', 'restored')
    ),
    previous_entity_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (batch_id, import_row_id, entity_type, entity_id, mutation_type)
);

CREATE INDEX IF NOT EXISTS data_import_mutations_batch_idx
    ON data_import_mutations (batch_id, id);

DROP TRIGGER IF EXISTS data_import_mutations_append_only ON data_import_mutations;
CREATE TRIGGER data_import_mutations_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON data_import_mutations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_data_import_row_mutation();

CREATE TABLE IF NOT EXISTS teachers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
    normalized_name text NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 120),
    college_name text NOT NULL CHECK (char_length(college_name) BETWEEN 1 AND 160),
    normalized_college text NOT NULL CHECK (char_length(normalized_college) BETWEEN 1 AND 160),
    identity_status text NOT NULL DEFAULT 'pending'
        CHECK (identity_status IN ('pending', 'active', 'ambiguous', 'retired')),
    created_batch_id uuid REFERENCES data_import_batches(id) ON DELETE RESTRICT,
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS teachers_name_lookup_idx
    ON teachers (normalized_name, normalized_college, identity_status);

CREATE OR REPLACE FUNCTION guard_teacher_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.normalized_name IS DISTINCT FROM OLD.normalized_name OR
       NEW.normalized_college IS DISTINCT FROM OLD.normalized_college OR
       NEW.created_batch_id IS DISTINCT FROM OLD.created_batch_id OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'teacher identity fields are immutable';
    END IF;
    NEW.updated_at := now();
    NEW.version := OLD.version + 1;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teachers_identity_guard ON teachers;
CREATE TRIGGER teachers_identity_guard
    BEFORE UPDATE ON teachers
    FOR EACH ROW EXECUTE FUNCTION guard_teacher_identity();

CREATE TABLE IF NOT EXISTS teacher_source_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
    source_system text NOT NULL CHECK (char_length(source_system) BETWEEN 1 AND 120),
    external_teacher_key text NOT NULL CHECK (
        char_length(external_teacher_key) BETWEEN 1 AND 500
    ),
    source_name_snapshot text NOT NULL CHECK (
        char_length(source_name_snapshot) BETWEEN 1 AND 120
    ),
    source_college_snapshot text NOT NULL CHECK (
        char_length(source_college_snapshot) BETWEEN 1 AND 160
    ),
    source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
    source_batch_id uuid NOT NULL REFERENCES data_import_batches(id) ON DELETE RESTRICT,
    mapping_status text NOT NULL DEFAULT 'current'
        CHECK (mapping_status IN ('current', 'withdrawn')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_system, external_teacher_key)
);

CREATE INDEX IF NOT EXISTS teacher_source_identities_teacher_idx
    ON teacher_source_identities (teacher_id, source_system);

CREATE OR REPLACE FUNCTION guard_teacher_source_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'teacher source identities cannot be deleted';
    END IF;
    IF NEW.teacher_id IS DISTINCT FROM OLD.teacher_id OR
       NEW.source_system IS DISTINCT FROM OLD.source_system OR
       NEW.external_teacher_key IS DISTINCT FROM OLD.external_teacher_key OR
       NEW.source_batch_id IS DISTINCT FROM OLD.source_batch_id OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'teacher source identity mapping is immutable';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teacher_source_identities_guard ON teacher_source_identities;
CREATE TRIGGER teacher_source_identities_guard
    BEFORE UPDATE OR DELETE ON teacher_source_identities
    FOR EACH ROW EXECUTE FUNCTION guard_teacher_source_identity();

CREATE TABLE IF NOT EXISTS teacher_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
    alias_name text NOT NULL CHECK (char_length(alias_name) BETWEEN 1 AND 120),
    normalized_alias text NOT NULL CHECK (char_length(normalized_alias) BETWEEN 1 AND 120),
    source_label text NOT NULL CHECK (char_length(source_label) BETWEEN 1 AND 120),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (teacher_id, normalized_alias, source_label)
);

CREATE INDEX IF NOT EXISTS teacher_aliases_lookup_idx
    ON teacher_aliases (normalized_alias, teacher_id);

CREATE TABLE IF NOT EXISTS teacher_course_sections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
    term_key text NOT NULL CHECK (char_length(term_key) BETWEEN 1 AND 64),
    course_id text NOT NULL CHECK (char_length(course_id) BETWEEN 1 AND 80),
    course_title text NOT NULL CHECK (char_length(course_title) BETWEEN 1 AND 240),
    section_no text NOT NULL CHECK (char_length(section_no) BETWEEN 1 AND 80),
    course_college text NOT NULL CHECK (char_length(course_college) BETWEEN 1 AND 160),
    teacher_name_snapshot text NOT NULL CHECK (
        char_length(teacher_name_snapshot) BETWEEN 1 AND 120
    ),
    teacher_college_snapshot text NOT NULL CHECK (
        char_length(teacher_college_snapshot) BETWEEN 1 AND 160
    ),
    source_batch_id uuid NOT NULL REFERENCES data_import_batches(id) ON DELETE RESTRICT,
    source_row_id uuid NOT NULL REFERENCES data_import_rows(id) ON DELETE RESTRICT,
    record_status text NOT NULL DEFAULT 'current'
        CHECK (record_status IN ('current', 'needs_review', 'superseded', 'withdrawn')),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (term_key, course_id, section_no, teacher_id),
    UNIQUE (source_row_id)
);

CREATE INDEX IF NOT EXISTS teacher_course_sections_teacher_idx
    ON teacher_course_sections (teacher_id, term_key DESC, course_id, section_no);
CREATE INDEX IF NOT EXISTS teacher_course_sections_course_idx
    ON teacher_course_sections (term_key, course_id, section_no);

CREATE TABLE IF NOT EXISTS teaching_section_textbooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    term_key text NOT NULL CHECK (char_length(term_key) BETWEEN 1 AND 64),
    course_id text NOT NULL CHECK (char_length(course_id) BETWEEN 1 AND 80),
    course_title text NOT NULL CHECK (char_length(course_title) BETWEEN 1 AND 240),
    section_no text NOT NULL CHECK (char_length(section_no) BETWEEN 1 AND 80),
    teacher_id uuid REFERENCES teachers(id) ON DELETE RESTRICT,
    teacher_name_snapshot text NOT NULL CHECK (
        char_length(teacher_name_snapshot) BETWEEN 1 AND 120
    ),
    teacher_college_snapshot text NOT NULL CHECK (
        char_length(teacher_college_snapshot) BETWEEN 1 AND 160
    ),
    material_kind text NOT NULL DEFAULT 'book' CHECK (
        material_kind IN ('book', 'handout', 'slides', 'platform', 'reference', 'other')
    ),
    selection_status text NOT NULL CHECK (
        selection_status IN ('specified', 'not_specified', 'needs_review')
    ),
    title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 500),
    author text CHECK (author IS NULL OR char_length(author) BETWEEN 1 AND 500),
    publisher text CHECK (publisher IS NULL OR char_length(publisher) BETWEEN 1 AND 300),
    publication_date date,
    publication_date_raw text CHECK (
        publication_date_raw IS NULL OR char_length(publication_date_raw) BETWEEN 1 AND 80
    ),
    edition text CHECK (edition IS NULL OR char_length(edition) BETWEEN 1 AND 80),
    printing text CHECK (printing IS NULL OR char_length(printing) BETWEEN 1 AND 80),
    isbn text CHECK (isbn IS NULL OR char_length(isbn) BETWEEN 1 AND 40),
    isbn_status text NOT NULL DEFAULT 'missing'
        CHECK (isbn_status IN ('valid', 'missing', 'placeholder', 'invalid')),
    position smallint NOT NULL DEFAULT 1 CHECK (position BETWEEN 1 AND 50),
    material_sha256 text NOT NULL CHECK (material_sha256 ~ '^[0-9a-f]{64}$'),
    source_batch_id uuid NOT NULL REFERENCES data_import_batches(id) ON DELETE RESTRICT,
    source_row_id uuid NOT NULL REFERENCES data_import_rows(id) ON DELETE RESTRICT,
    supersedes_id uuid REFERENCES teaching_section_textbooks(id) ON DELETE RESTRICT,
    record_status text NOT NULL DEFAULT 'current'
        CHECK (record_status IN ('current', 'needs_review', 'superseded', 'withdrawn')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_row_id),
    CHECK (selection_status <> 'specified' OR title IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS teaching_section_textbooks_identity_uidx
    ON teaching_section_textbooks (
        term_key, course_id, section_no, COALESCE(teacher_id, '00000000-0000-0000-0000-000000000000'::uuid),
        position, material_sha256
    )
    WHERE record_status <> 'withdrawn';
CREATE INDEX IF NOT EXISTS teaching_section_textbooks_section_idx
    ON teaching_section_textbooks (term_key, course_id, section_no, record_status);

CREATE TABLE IF NOT EXISTS teacher_review_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
    import_row_id uuid NOT NULL UNIQUE REFERENCES data_import_rows(id) ON DELETE RESTRICT,
    sanitized_body text NOT NULL CHECK (char_length(sanitized_body) BETWEEN 1 AND 3000),
    original_body_sha256 text NOT NULL CHECK (original_body_sha256 ~ '^[0-9a-f]{64}$'),
    normalized_body_sha256 text NOT NULL CHECK (normalized_body_sha256 ~ '^[0-9a-f]{64}$'),
    risk_flags text[] NOT NULL DEFAULT '{}',
    moderation_status text NOT NULL DEFAULT 'pending' CHECK (
        moderation_status IN ('pending', 'approved', 'rejected', 'rolled_back')
    ),
    moderated_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    moderated_at timestamptz,
    moderation_reason text CHECK (
        moderation_reason IS NULL OR char_length(moderation_reason) BETWEEN 8 AND 1000
    ),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (moderation_status = 'pending' AND moderated_at IS NULL AND moderated_by_user_id IS NULL) OR
        (moderation_status <> 'pending' AND moderated_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS teacher_review_candidates_dedupe_uidx
    ON teacher_review_candidates (teacher_id, normalized_body_sha256)
    WHERE moderation_status <> 'rolled_back';
CREATE INDEX IF NOT EXISTS teacher_review_candidates_queue_idx
    ON teacher_review_candidates (moderation_status, created_at, id)
    WHERE moderation_status = 'pending';

CREATE OR REPLACE FUNCTION guard_teacher_review_candidate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'teacher review candidates cannot be deleted';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.moderation_status <> 'pending' THEN
            RAISE EXCEPTION 'legacy teacher review candidates must start pending';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.teacher_id IS DISTINCT FROM OLD.teacher_id OR
       NEW.import_row_id IS DISTINCT FROM OLD.import_row_id OR
       NEW.sanitized_body IS DISTINCT FROM OLD.sanitized_body OR
       NEW.original_body_sha256 IS DISTINCT FROM OLD.original_body_sha256 OR
       NEW.normalized_body_sha256 IS DISTINCT FROM OLD.normalized_body_sha256 OR
       NEW.risk_flags IS DISTINCT FROM OLD.risk_flags OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'teacher review candidate evidence is immutable';
    END IF;
    IF NOT (
        (OLD.moderation_status = 'pending' AND NEW.moderation_status IN ('pending', 'approved', 'rejected', 'rolled_back')) OR
        (OLD.moderation_status IN ('approved', 'rejected') AND NEW.moderation_status IN (OLD.moderation_status, 'rolled_back')) OR
        (OLD.moderation_status = 'rolled_back' AND NEW.moderation_status = 'rolled_back')
    ) THEN
        RAISE EXCEPTION 'invalid teacher review candidate status transition';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teacher_review_candidates_guard ON teacher_review_candidates;
CREATE TRIGGER teacher_review_candidates_guard
    BEFORE INSERT OR UPDATE OR DELETE ON teacher_review_candidates
    FOR EACH ROW EXECUTE FUNCTION guard_teacher_review_candidate();

CREATE TABLE IF NOT EXISTS teacher_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
    author_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    source_type text NOT NULL CHECK (source_type IN ('user', 'legacy_approved')),
    import_candidate_id uuid UNIQUE REFERENCES teacher_review_candidates(id) ON DELETE RESTRICT,
    author_label text CHECK (author_label IS NULL OR char_length(author_label) BETWEEN 1 AND 120),
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 3000),
    course_organization_rating smallint CHECK (course_organization_rating BETWEEN 1 AND 5),
    content_clarity_rating smallint CHECK (content_clarity_rating BETWEEN 1 AND 5),
    assessment_explanation_rating smallint CHECK (
        assessment_explanation_rating BETWEEN 1 AND 5
    ),
    classroom_interaction_rating smallint CHECK (classroom_interaction_rating BETWEEN 1 AND 5),
    material_completeness_rating smallint CHECK (
        material_completeness_rating BETWEEN 1 AND 5
    ),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    status text NOT NULL DEFAULT 'published' CHECK (
        status IN ('published', 'hidden', 'deleted')
    ),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CHECK (
        (source_type = 'legacy_approved' AND author_user_id IS NULL AND import_candidate_id IS NOT NULL) OR
        (source_type = 'user' AND import_candidate_id IS NULL)
    ),
    CHECK (source_type <> 'legacy_approved' OR author_label = '历史整理内容'),
    CHECK (
        (source_type = 'legacy_approved' AND
            course_organization_rating IS NULL AND content_clarity_rating IS NULL AND
            assessment_explanation_rating IS NULL AND classroom_interaction_rating IS NULL AND
            material_completeness_rating IS NULL) OR
        (source_type = 'user' AND
            course_organization_rating IS NOT NULL AND content_clarity_rating IS NOT NULL AND
            assessment_explanation_rating IS NOT NULL AND classroom_interaction_rating IS NOT NULL AND
            material_completeness_rating IS NOT NULL)
    ),
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS teacher_reviews_legacy_dedupe_uidx
    ON teacher_reviews (teacher_id, content_sha256)
    WHERE source_type = 'legacy_approved';
CREATE INDEX IF NOT EXISTS teacher_reviews_public_cursor_idx
    ON teacher_reviews (teacher_id, created_at DESC, id DESC)
    WHERE status = 'published';

CREATE OR REPLACE FUNCTION guard_teacher_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'teacher reviews must be soft-deleted';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.source_type = 'user' AND NEW.author_user_id IS NULL THEN
            RAISE EXCEPTION 'user teacher reviews require an active author';
        END IF;
        IF NEW.source_type = 'legacy_approved' AND NOT EXISTS (
            SELECT 1 FROM teacher_review_candidates
            WHERE id = NEW.import_candidate_id
              AND teacher_id = NEW.teacher_id
              AND moderation_status = 'approved'
        ) THEN
            RAISE EXCEPTION 'legacy teacher review candidate must be approved';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.teacher_id IS DISTINCT FROM OLD.teacher_id OR
       NEW.author_user_id IS DISTINCT FROM OLD.author_user_id OR
       NEW.source_type IS DISTINCT FROM OLD.source_type OR
       NEW.import_candidate_id IS DISTINCT FROM OLD.import_candidate_id OR
       NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'teacher review source identity is immutable';
    END IF;

    NEW.updated_at := now();
    NEW.version := OLD.version + 1;
    IF NEW.status = 'deleted' THEN
        NEW.deleted_at := COALESCE(OLD.deleted_at, now());
    ELSE
        NEW.deleted_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teacher_reviews_guard ON teacher_reviews;
CREATE TRIGGER teacher_reviews_guard
    BEFORE INSERT OR UPDATE OR DELETE ON teacher_reviews
    FOR EACH ROW EXECUTE FUNCTION guard_teacher_review();

DROP TRIGGER IF EXISTS teacher_reviews_truncate_guard ON teacher_reviews;
CREATE TRIGGER teacher_reviews_truncate_guard
    BEFORE TRUNCATE ON teacher_reviews
    FOR EACH STATEMENT EXECUTE FUNCTION reject_community_content_hard_delete();
