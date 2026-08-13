WITH ranked_active_textbooks AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY
                term_key,
                course_id,
                section_no,
                COALESCE(teacher_id, '00000000-0000-0000-0000-000000000000'::uuid),
                position
            ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS active_rank
    FROM teaching_section_textbooks
    WHERE record_status IN ('current', 'needs_review')
)
UPDATE teaching_section_textbooks AS textbook
SET record_status = 'superseded', updated_at = now()
FROM ranked_active_textbooks AS ranked
WHERE textbook.id = ranked.id AND ranked.active_rank > 1;

DROP INDEX IF EXISTS teaching_section_textbooks_identity_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS teaching_section_textbooks_active_scope_uidx
    ON teaching_section_textbooks (
        term_key,
        course_id,
        section_no,
        COALESCE(teacher_id, '00000000-0000-0000-0000-000000000000'::uuid),
        position
    )
    WHERE record_status IN ('current', 'needs_review');
