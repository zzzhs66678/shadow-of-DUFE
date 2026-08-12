#!/bin/sh
set -eu
umask 077

APP_ROOT="${APP_ROOT:-/srv/apps/dufesh}"
ENV_FILE="${DUFESH_POSTGRES_ENV_FILE:-$APP_ROOT/shared/config/postgres.env}"
BACKUP_DIR="${BACKUP_DIR:-$APP_ROOT/shared/backups/postgres}"
COMPOSE_DIR="${COMPOSE_DIR:-$APP_ROOT/current}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dufesh}"
RESTORE_DRILL_MAX_SECONDS="${RESTORE_DRILL_MAX_SECONDS:-900}"
RESTORE_DRILL_MAX_BACKUP_AGE_HOURS="${RESTORE_DRILL_MAX_BACKUP_AGE_HOURS:-30}"
RESTORE_DRILL_MODE="${RESTORE_DRILL_MODE:-docker}"

if [ ! -r "$ENV_FILE" ]; then
  echo "PostgreSQL environment file is missing: $ENV_FILE" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

case "$RESTORE_DRILL_MODE" in
  docker|native) ;;
  *) echo "RESTORE_DRILL_MODE must be docker or native." >&2; exit 1 ;;
esac
if [ "$RESTORE_DRILL_MODE" = "native" ]; then
  PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
  export PGPASSWORD
fi

run_postgres() {
  if [ "$RESTORE_DRILL_MODE" = "native" ]; then
    "$@"
  else
    docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres "$@"
  fi
}

case "$RESTORE_DRILL_MAX_SECONDS" in
  ''|*[!0-9]*) echo "RESTORE_DRILL_MAX_SECONDS must be a positive integer." >&2; exit 1 ;;
esac
case "$RESTORE_DRILL_MAX_BACKUP_AGE_HOURS" in
  ''|*[!0-9]*) echo "RESTORE_DRILL_MAX_BACKUP_AGE_HOURS must be a positive integer." >&2; exit 1 ;;
esac
if [ "$RESTORE_DRILL_MAX_SECONDS" -lt 1 ] || [ "$RESTORE_DRILL_MAX_BACKUP_AGE_HOURS" -lt 1 ]; then
  echo "Restore drill limits must be positive." >&2
  exit 1
fi

backup_file="${1:-}"
if [ -z "$backup_file" ]; then
  backup_file="$(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "${POSTGRES_DB}-*.dump" -printf '%T@ %p\n' |
      sort -nr |
      awk 'NR == 1 {sub(/^[^ ]+ /, ""); print; exit}'
  )"
fi
if [ -z "$backup_file" ] || [ ! -f "$backup_file" ] || [ ! -r "$backup_file" ]; then
  echo "No readable PostgreSQL backup was found." >&2
  exit 1
fi

checksum_file="${backup_file}.sha256"
if [ ! -r "$checksum_file" ]; then
  echo "Backup checksum is missing: $checksum_file" >&2
  exit 1
fi
expected_checksum="$(awk 'NR == 1 {print $1; exit}' "$checksum_file")"
case "$expected_checksum" in
  *[!0-9a-f]*|'') echo "Backup checksum is malformed." >&2; exit 1 ;;
esac
if [ "${#expected_checksum}" -ne 64 ]; then
  echo "Backup checksum is malformed." >&2
  exit 1
fi
actual_checksum="$(sha256sum "$backup_file" | awk '{print $1}')"
if [ "$actual_checksum" != "$expected_checksum" ]; then
  echo "Backup checksum does not match." >&2
  exit 1
fi

now_epoch="$(date +%s)"
backup_epoch="$(stat -c %Y "$backup_file")"
backup_age_seconds="$((now_epoch - backup_epoch))"
maximum_age_seconds="$((RESTORE_DRILL_MAX_BACKUP_AGE_HOURS * 3600))"
if [ "$backup_age_seconds" -lt 0 ] || [ "$backup_age_seconds" -gt "$maximum_age_seconds" ]; then
  echo "Backup is outside the allowed restore-drill age window." >&2
  exit 1
fi

drill_suffix="$(date -u +%Y%m%d%H%M%S)_$$"
drill_database="dufesh_restore_drill_${drill_suffix}"
case "$drill_database" in
  dufesh_restore_drill_[0-9]*) ;;
  *) echo "Generated restore database name is invalid." >&2; exit 1 ;;
esac
if [ "$drill_database" = "$POSTGRES_DB" ]; then
  echo "Restore drill database must not be the production database." >&2
  exit 1
fi

created=0
cleanup() {
  if [ "$created" -eq 1 ]; then
    run_postgres dropdb --username "$POSTGRES_USER" \
      --maintenance-db "$POSTGRES_DB" \
      --if-exists "$drill_database" >/dev/null
  fi
}
trap cleanup EXIT INT TERM

started_at="$(date +%s)"
if [ "$RESTORE_DRILL_MODE" = "docker" ]; then
  cd "$COMPOSE_DIR"
fi

run_postgres createdb \
  --username "$POSTGRES_USER" \
  --maintenance-db "$POSTGRES_DB" \
  --template template0 "$drill_database"
created=1

run_postgres pg_restore \
    --username "$POSTGRES_USER" \
    --dbname "$drill_database" \
    --exit-on-error \
    --no-owner \
    --no-privileges < "$backup_file"

run_postgres psql \
    --username "$POSTGRES_USER" \
    --dbname "$drill_database" \
    --set ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align <<'SQL'
DO $$
DECLARE
    migration_count integer;
    invalid_constraint_count integer;
    missing_table_count integer;
BEGIN
    SELECT count(*) INTO migration_count FROM schema_migrations;
    IF migration_count < 20 THEN
        RAISE EXCEPTION 'restore contains only % migrations; expected at least 20', migration_count;
    END IF;

    SELECT count(*) INTO invalid_constraint_count
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND NOT convalidated;
    IF invalid_constraint_count <> 0 THEN
        RAISE EXCEPTION 'restore contains % unvalidated constraints', invalid_constraint_count;
    END IF;

    SELECT count(*) INTO missing_table_count
    FROM unnest(ARRAY[
        'app_users',
        'user_sessions',
        'timetable_plans',
        'community_topics',
        'community_reports',
        'community_announcements',
        'teachers',
        'course_schedule_teachers',
        'teacher_reviews',
        'teacher_review_comments',
        'teacher_review_comment_edits',
        'api_rate_limit_buckets'
    ]) AS required_table(name)
    WHERE to_regclass('public.' || required_table.name) IS NULL;
    IF missing_table_count <> 0 THEN
        RAISE EXCEPTION 'restore is missing % required tables', missing_table_count;
    END IF;
END;
$$;

SELECT json_build_object(
    'migrations', (SELECT count(*) FROM schema_migrations),
    'users', (SELECT count(*) FROM app_users),
    'sessions', (SELECT count(*) FROM user_sessions),
    'topics', (SELECT count(*) FROM community_topics),
    'teachers', (SELECT count(*) FROM teachers)
);
SQL

finished_at="$(date +%s)"
duration_seconds="$((finished_at - started_at))"
if [ "$duration_seconds" -gt "$RESTORE_DRILL_MAX_SECONDS" ]; then
  echo "Restore completed but exceeded the ${RESTORE_DRILL_MAX_SECONDS}s RTO gate." >&2
  exit 2
fi

cleanup
created=0
echo "Restore drill passed: backup=$(basename "$backup_file") duration_seconds=$duration_seconds"
