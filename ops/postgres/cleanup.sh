#!/bin/sh
set -eu
umask 077

APP_ROOT="${APP_ROOT:-/srv/apps/dufesh}"
ENV_FILE="${DUFESH_POSTGRES_ENV_FILE:-$APP_ROOT/shared/config/postgres.env}"
COMPOSE_DIR="${COMPOSE_DIR:-$APP_ROOT/current}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dufesh}"

if [ ! -r "$ENV_FILE" ]; then
  echo "PostgreSQL environment file is missing: $ENV_FILE" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

cd "$COMPOSE_DIR"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
  psql \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('dufesh-personal-data-cleanup'));

WITH removed AS (
    DELETE FROM user_sync_mutations
    WHERE created_at < now() - interval '30 days'
    RETURNING 1
)
SELECT 'sync_mutations' AS category, count(*) AS removed FROM removed;

WITH removed AS (
    DELETE FROM oauth_transactions
    WHERE (
        consumed_at < now() - interval '1 day'
        OR expires_at < now() - interval '1 day'
    )
    RETURNING 1
)
SELECT 'oauth_transactions' AS category, count(*) AS removed FROM removed;

WITH removed AS (
    DELETE FROM password_reset_tokens
    WHERE (
        consumed_at < now() - interval '30 days'
        OR expires_at < now() - interval '30 days'
    )
    RETURNING 1
)
SELECT 'password_reset_tokens' AS category, count(*) AS removed FROM removed;

WITH removed AS (
    DELETE FROM email_verification_tokens
    WHERE (
        consumed_at < now() - interval '30 days'
        OR expires_at < now() - interval '30 days'
    )
    RETURNING 1
)
SELECT 'email_verification_tokens' AS category, count(*) AS removed FROM removed;

WITH removed AS (
    DELETE FROM user_sessions
    WHERE (
        expires_at < now() - interval '30 days'
        OR revoked_at < now() - interval '30 days'
    )
    RETURNING 1
)
SELECT 'user_sessions' AS category, count(*) AS removed FROM removed;

WITH removed AS (
    DELETE FROM timetable_plan_schedules
    WHERE deleted_at < now() - interval '180 days'
    RETURNING 1
)
SELECT 'schedule_tombstones' AS category, count(*) AS removed FROM removed;

WITH removed AS (
    DELETE FROM personal_activities
    WHERE deleted_at < now() - interval '180 days'
    RETURNING 1
)
SELECT 'activity_tombstones' AS category, count(*) AS removed FROM removed;

WITH removed AS (
    DELETE FROM user_assignments
    WHERE deleted_at < now() - interval '180 days'
    RETURNING 1
)
SELECT 'assignment_tombstones' AS category, count(*) AS removed FROM removed;

WITH removed AS (
    DELETE FROM timetable_plans
    WHERE deleted_at < now() - interval '180 days'
    RETURNING 1
)
SELECT 'plan_tombstones' AS category, count(*) AS removed FROM removed;

WITH removed AS (
    DELETE FROM user_devices AS devices
    WHERE devices.revoked_at < now() - interval '180 days'
      AND NOT EXISTS (
          SELECT 1
          FROM user_sessions AS sessions
          WHERE sessions.device_id = devices.id
      )
    RETURNING 1
)
SELECT 'revoked_devices' AS category, count(*) AS removed FROM removed;

WITH removed AS (
    DELETE FROM anonymous_devices
    WHERE claimed_device_id IS NULL
      AND (
          revoked_at < now() - interval '30 days'
          OR last_seen_at < now() - interval '180 days'
      )
    RETURNING 1
)
SELECT 'anonymous_devices' AS category, count(*) AS removed FROM removed;

COMMIT;
SQL
