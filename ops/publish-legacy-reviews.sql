-- Private host operation, authorized by the site owner. Never exposed as an API.
-- psql variables: actor, source_sha, expected_count. Defaults to ROLLBACK;
-- supply -v apply=true only after inspecting the rollback run.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
CREATE TEMP TABLE publish_parameters ON COMMIT DROP AS
SELECT :'actor'::text AS actor, :'source_sha'::text AS source_sha,
       :'expected_count'::int AS expected_count;
CREATE TEMP TABLE publish_actor ON COMMIT DROP AS
SELECT id, COALESCE(NULLIF(display_name, ''), username) AS label
FROM app_users WHERE normalized_username = :'actor' AND role = 'admin' AND status = 'active'
FOR UPDATE;
SELECT id FROM data_import_batches WHERE source_sha256 = :'source_sha'
AND import_type = 'teacher_reviews' AND status = 'applied' FOR UPDATE;
CREATE TEMP TABLE publish_candidates ON COMMIT DROP AS
SELECT c.* FROM teacher_review_candidates c
JOIN data_import_rows r ON r.id = c.import_row_id
JOIN data_import_batches b ON b.id = r.batch_id
WHERE b.source_sha256 = :'source_sha' AND b.import_type = 'teacher_reviews'
AND b.status = 'applied' AND c.moderation_status = 'pending'
FOR UPDATE OF c;
DO $$ BEGIN
  IF (SELECT count(*) FROM publish_actor) <> 1 THEN
    RAISE EXCEPTION 'Exactly one active administrator is required';
  END IF;
  IF (SELECT count(*) FROM publish_candidates) <> (SELECT expected_count FROM publish_parameters) THEN
    RAISE EXCEPTION 'Pending candidate count changed; no publication performed';
  END IF;
END $$;
UPDATE teacher_review_candidates c SET moderation_status = 'approved',
moderated_by_user_id = a.id, moderated_at = now(),
moderation_reason = '站长于2026-09-20明确授权整批历史评价直接公开；保留来源和脱敏，不代表逐条人工审核。'
FROM publish_candidates selected CROSS JOIN publish_actor a WHERE c.id = selected.id;
INSERT INTO teacher_reviews (teacher_id, source_type, import_candidate_id, author_label, body, content_sha256)
SELECT teacher_id, 'legacy_approved', id, '历史整理内容', sanitized_body, normalized_body_sha256
FROM publish_candidates;
INSERT INTO teacher_review_candidate_decisions
(candidate_id, decision, actor_user_id, actor_label, reason, published_body, public_review_id)
SELECT c.id, 'approved', a.id, a.label,
'站长于2026-09-20明确授权整批历史评价直接公开；保留来源和脱敏，不代表逐条人工审核。',
c.sanitized_body, r.id
FROM publish_candidates c JOIN teacher_reviews r ON r.import_candidate_id=c.id CROSS JOIN publish_actor a;
INSERT INTO admin_audit_events (actor_user_id, actor_role, action, target_type, target_id, request_id, metadata)
SELECT a.id, 'admin', 'admin.teacher_review.owner_batch_publish', 'teacher_review_candidate',
c.id::text, gen_random_uuid(), jsonb_build_object('publicReviewId',r.id,'sourceSha256',p.source_sha,
'authorization','owner_explicit_2026-09-20','perItemHumanReview',false,'riskFlags',c.risk_flags)
FROM publish_candidates c JOIN teacher_reviews r ON r.import_candidate_id=c.id
CROSS JOIN publish_actor a CROSS JOIN publish_parameters p;
SELECT count(*) AS published_in_transaction FROM teacher_reviews r
JOIN publish_candidates c ON c.id=r.import_candidate_id WHERE r.status='published';
\if :{?apply}
  \if :apply
    COMMIT;
  \else
    ROLLBACK;
  \endif
\else
  ROLLBACK;
\endif
