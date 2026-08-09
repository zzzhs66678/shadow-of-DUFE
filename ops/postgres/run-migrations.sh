#!/bin/sh
set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/opt/dufesh-postgres/migrations}"

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${AUTH_DB_USER:?AUTH_DB_USER is required}"
: "${AUTH_DB_PASSWORD:?AUTH_DB_PASSWORD is required}"

export PGPASSWORD="$POSTGRES_PASSWORD"

until pg_isready -h "${PGHOST:-postgres}" -p "${PGPORT:-5432}" -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  sleep 1
done

psql \
  --host "${PGHOST:-postgres}" \
  --port "${PGPORT:-5432}" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for migration in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$migration" ] || continue

  version="$(basename "$migration")"
  checksum="$(sha256sum "$migration" | awk '{print $1}')"
  stored_checksum="$(
    psql \
      --host "${PGHOST:-postgres}" \
      --port "${PGPORT:-5432}" \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      --tuples-only \
      --no-align \
      --set ON_ERROR_STOP=1 \
      --variable "version=$version" <<'SQL'
SELECT checksum
FROM schema_migrations
WHERE version = :'version';
SQL
  )"

  if [ -n "$stored_checksum" ]; then
    if [ "$stored_checksum" != "$checksum" ]; then
      echo "Migration checksum mismatch: $version" >&2
      exit 1
    fi
    echo "Already applied: $version"
    continue
  fi

  echo "Applying: $version"
  {
    echo "BEGIN;"
    cat "$migration"
    printf "\nINSERT INTO schema_migrations(version, checksum) VALUES ('%s', '%s');\n" "$version" "$checksum"
    echo "COMMIT;"
  } | psql \
    --host "${PGHOST:-postgres}" \
    --port "${PGPORT:-5432}" \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set ON_ERROR_STOP=1
done

psql \
  --host "${PGHOST:-postgres}" \
  --port "${PGPORT:-5432}" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  --variable "runtime_user=$AUTH_DB_USER" \
  --variable "runtime_password=$AUTH_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'runtime_user')
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'runtime_user'
) \gexec

SELECT format(
    'ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'runtime_user',
    :'runtime_password'
) \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_user') \gexec
SELECT format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
    :'runtime_user'
) \gexec
SELECT format(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I',
    :'runtime_user'
) \gexec
SELECT format(
    'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I',
    :'runtime_user'
) \gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    :'runtime_user'
) \gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
    :'runtime_user'
) \gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',
    :'runtime_user'
) \gexec

SELECT format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON admin_audit_events FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON community_moderation_actions FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON community_content_edits FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'REVOKE DELETE, TRUNCATE ON community_reports, community_moderation_cases, community_user_sanctions FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'REVOKE UPDATE, DELETE, TRUNCATE ON community_case_reports FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'REVOKE DELETE, TRUNCATE ON community_topics, community_comments FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'REVOKE ALL PRIVILEGES ON data_import_batches, data_import_rows, data_import_mutations, teacher_review_candidates FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON teachers, teacher_source_identities, teacher_aliases, teacher_course_sections, teaching_section_textbooks FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'REVOKE DELETE, TRUNCATE ON teacher_reviews FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'REVOKE ALL PRIVILEGES ON schema_migrations FROM %I',
    :'runtime_user'
) \gexec
SQL

echo "Database migrations are up to date."
