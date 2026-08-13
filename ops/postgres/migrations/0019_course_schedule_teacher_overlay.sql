ALTER TABLE data_import_batches
    DROP CONSTRAINT IF EXISTS data_import_batches_import_type_check;
ALTER TABLE data_import_batches
    ADD CONSTRAINT data_import_batches_import_type_check CHECK (
        import_type IN (
            'teacher_reviews',
            'teaching_section_textbooks',
            'course_schedule_teachers'
        )
    );

ALTER TABLE data_import_mutations
    DROP CONSTRAINT IF EXISTS data_import_mutations_entity_type_check;
ALTER TABLE data_import_mutations
    ADD CONSTRAINT data_import_mutations_entity_type_check CHECK (
        entity_type IN (
            'teacher', 'teacher_source_identity', 'teacher_course_section',
            'teaching_section_textbook', 'teacher_review_candidate',
            'course_schedule_teacher'
        )
    );

CREATE TABLE IF NOT EXISTS course_schedule_teachers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog_id text NOT NULL CHECK (
        char_length(catalog_id) BETWEEN 1 AND 80 AND
        catalog_id ~ '^[A-Za-z0-9:_-]+$'
    ),
    schedule_id text NOT NULL CHECK (
        char_length(schedule_id) BETWEEN 1 AND 160 AND
        schedule_id ~ '^[A-Za-z0-9:_-]+$'
    ),
    teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
    source_batch_id uuid NOT NULL REFERENCES data_import_batches(id) ON DELETE RESTRICT,
    source_row_id uuid NOT NULL REFERENCES data_import_rows(id) ON DELETE RESTRICT,
    record_status text NOT NULL DEFAULT 'current'
        CHECK (record_status IN ('current', 'withdrawn')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_row_id, teacher_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS course_schedule_teachers_active_uidx
    ON course_schedule_teachers (catalog_id, schedule_id, teacher_id)
    WHERE record_status = 'current';
CREATE INDEX IF NOT EXISTS course_schedule_teachers_lookup_idx
    ON course_schedule_teachers (catalog_id, schedule_id, teacher_id)
    WHERE record_status = 'current';
CREATE INDEX IF NOT EXISTS course_schedule_teachers_teacher_idx
    ON course_schedule_teachers (teacher_id, catalog_id, schedule_id)
    WHERE record_status = 'current';

CREATE OR REPLACE FUNCTION guard_course_schedule_teacher()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'course schedule teacher links cannot be deleted';
    END IF;
    IF NEW.catalog_id IS DISTINCT FROM OLD.catalog_id OR
       NEW.schedule_id IS DISTINCT FROM OLD.schedule_id OR
       NEW.teacher_id IS DISTINCT FROM OLD.teacher_id OR
       NEW.source_batch_id IS DISTINCT FROM OLD.source_batch_id OR
       NEW.source_row_id IS DISTINCT FROM OLD.source_row_id OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'course schedule teacher link identity is immutable';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS course_schedule_teachers_guard ON course_schedule_teachers;
CREATE TRIGGER course_schedule_teachers_guard
    BEFORE UPDATE OR DELETE ON course_schedule_teachers
    FOR EACH ROW EXECUTE FUNCTION guard_course_schedule_teacher();
