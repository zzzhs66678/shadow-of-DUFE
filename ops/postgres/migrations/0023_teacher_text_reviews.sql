-- 0013's unnamed teacher_reviews_check2 requires scores on every user review.
-- Relax only that requirement; retain per-dimension 1..5 checks, source identity,
-- legacy approval/evidence guards, versioning, and soft-delete governance.
-- No row updates: historical scores, timestamps, and versions remain unchanged.
ALTER TABLE teacher_reviews
    DROP CONSTRAINT teacher_reviews_check2,
    ADD CONSTRAINT teacher_reviews_ratings_complete_check CHECK (
        (
            course_organization_rating IS NULL AND content_clarity_rating IS NULL AND
            assessment_explanation_rating IS NULL AND classroom_interaction_rating IS NULL AND
            material_completeness_rating IS NULL
        ) OR (
            source_type = 'user' AND
            course_organization_rating IS NOT NULL AND content_clarity_rating IS NOT NULL AND
            assessment_explanation_rating IS NOT NULL AND classroom_interaction_rating IS NOT NULL AND
            material_completeness_rating IS NOT NULL
        )
    );
