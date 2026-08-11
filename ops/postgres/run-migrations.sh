#!/bin/sh
set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/opt/dufesh-postgres/migrations}"

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${MIGRATION_DB_ROLE:?MIGRATION_DB_ROLE is required}"
: "${MIGRATION_DB_USER:?MIGRATION_DB_USER is required}"
: "${MIGRATION_DB_PASSWORD:?MIGRATION_DB_PASSWORD is required}"
: "${AUTH_DB_USER:?AUTH_DB_USER is required}"
: "${AUTH_DB_PASSWORD:?AUTH_DB_PASSWORD is required}"
: "${IMPORT_DB_USER:?IMPORT_DB_USER is required}"
: "${IMPORT_DB_PASSWORD:?IMPORT_DB_PASSWORD is required}"
: "${BACKUP_DB_USER:?BACKUP_DB_USER is required}"
: "${BACKUP_DB_PASSWORD:?BACKUP_DB_PASSWORD is required}"

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
  --variable "schema_owner=$MIGRATION_DB_ROLE" \
  --variable "migration_user=$MIGRATION_DB_USER" \
  --variable "migration_password=$MIGRATION_DB_PASSWORD" \
  <<'SQL'
SELECT format('CREATE ROLE %I NOLOGIN', :'schema_owner')
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'schema_owner'
) \gexec
SELECT format(
    'ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
    :'schema_owner'
) \gexec
SELECT format('REVOKE %I FROM %I', granted_role.rolname, :'schema_owner')
FROM pg_auth_members AS membership
INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = :'schema_owner' \gexec

SELECT format('CREATE ROLE %I LOGIN', :'migration_user')
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'migration_user'
) \gexec
SELECT format(
    'ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
    :'migration_user',
    :'migration_password'
) \gexec
SELECT format('REVOKE %I FROM %I', granted_role.rolname, :'migration_user')
FROM pg_auth_members AS membership
INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = :'migration_user' \gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), :'migration_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'migration_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'migration_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'migration_user') \gexec
SELECT format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'migration_user') \gexec
SELECT format('GRANT %I TO %I', :'schema_owner', :'migration_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'migration_user') \gexec

SELECT format('ALTER SCHEMA public OWNER TO %I', :'schema_owner') \gexec
SELECT format('ALTER TABLE %I.%I OWNER TO %I', namespace.nspname, relation.relname, :'schema_owner')
FROM pg_class AS relation
INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p')
  AND relation.relowner <> :'schema_owner'::regrole \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', namespace.nspname, relation.relname, :'schema_owner')
FROM pg_class AS relation
INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relkind = 'S'
  AND relation.relowner <> :'schema_owner'::regrole \gexec
SELECT format(
    'ALTER FUNCTION %I.%I(%s) OWNER TO %I',
    namespace.nspname,
    procedure.proname,
    pg_get_function_identity_arguments(procedure.oid),
    :'schema_owner'
)
FROM pg_proc AS procedure
INNER JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname = 'public'
  AND procedure.prokind = 'f'
  AND procedure.proowner <> :'schema_owner'::regrole \gexec
SQL

PGPASSWORD="$MIGRATION_DB_PASSWORD" \
PGOPTIONS="-c role=$MIGRATION_DB_ROLE" \
psql \
  --host "${PGHOST:-postgres}" \
  --port "${PGPORT:-5432}" \
  --username "$MIGRATION_DB_USER" \
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
    PGPASSWORD="$MIGRATION_DB_PASSWORD" \
    PGOPTIONS="-c role=$MIGRATION_DB_ROLE" \
    psql \
      --host "${PGHOST:-postgres}" \
      --port "${PGPORT:-5432}" \
      --username "$MIGRATION_DB_USER" \
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
  } | PGPASSWORD="$MIGRATION_DB_PASSWORD" \
    PGOPTIONS="-c role=$MIGRATION_DB_ROLE" \
    psql \
    --host "${PGHOST:-postgres}" \
    --port "${PGPORT:-5432}" \
    --username "$MIGRATION_DB_USER" \
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
  --variable "runtime_password=$AUTH_DB_PASSWORD" \
  --variable "schema_owner=$MIGRATION_DB_ROLE" \
  --variable "import_user=$IMPORT_DB_USER" \
  --variable "import_password=$IMPORT_DB_PASSWORD" \
  --variable "backup_user=$BACKUP_DB_USER" \
  --variable "backup_password=$BACKUP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'runtime_user')
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'runtime_user'
) \gexec

SELECT format(
    'ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    :'runtime_user',
    :'runtime_password'
) \gexec
SELECT format('REVOKE %I FROM %I', granted_role.rolname, :'runtime_user')
FROM pg_auth_members AS membership
INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = :'runtime_user' \gexec

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
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    :'schema_owner',
    :'runtime_user'
) \gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
    :'schema_owner',
    :'runtime_user'
) \gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',
    :'schema_owner',
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
    'REVOKE ALL PRIVILEGES ON teacher_review_candidate_decisions FROM %I',
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
SELECT format(
    'REVOKE ALL PRIVILEGES ON api_rate_limit_buckets FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'GRANT EXECUTE ON FUNCTION consume_api_rate_limit(text, bytea, double precision, double precision) TO %I',
    :'runtime_user'
) \gexec
SELECT format(
    'REVOKE EXECUTE ON FUNCTION require_elevated_teacher_review_admin(uuid, uuid, text), rollback_teacher_review_candidate_for_import(uuid, uuid) FROM %I',
    :'runtime_user'
) \gexec
SELECT format(
    'GRANT EXECUTE ON FUNCTION list_teacher_review_candidates_for_admin(uuid, uuid, text, text, timestamptz, uuid, integer), moderate_teacher_review_candidate(uuid, uuid, text, uuid, text, text, uuid, text, text) TO %I',
    :'runtime_user'
) \gexec

SELECT format('CREATE ROLE %I LOGIN', :'import_user')
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'import_user'
) \gexec
SELECT format(
    'ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
    :'import_user',
    :'import_password'
) \gexec
SELECT format('REVOKE %I FROM %I', granted_role.rolname, :'import_user')
FROM pg_auth_members AS membership
INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = :'import_user' \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'import_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'import_user') \gexec
SELECT format(
    'GRANT SELECT, INSERT, UPDATE ON data_import_batches TO %I',
    :'import_user'
) \gexec
SELECT format(
    'GRANT SELECT, INSERT ON data_import_rows, data_import_mutations TO %I',
    :'import_user'
) \gexec
SELECT format(
    'GRANT SELECT, INSERT, UPDATE ON teachers, teacher_source_identities, teacher_aliases, teacher_course_sections, teaching_section_textbooks TO %I',
    :'import_user'
) \gexec
SELECT format('GRANT SELECT, INSERT ON teacher_review_candidates TO %I', :'import_user') \gexec
SELECT format('GRANT SELECT ON teacher_reviews TO %I', :'import_user') \gexec
SELECT format(
    'GRANT USAGE, SELECT ON SEQUENCE data_import_mutations_id_seq TO %I',
    :'import_user'
) \gexec
SELECT format(
    'REVOKE ALL PRIVILEGES ON schema_migrations FROM %I',
    :'import_user'
) \gexec
SELECT format(
    'GRANT EXECUTE ON FUNCTION rollback_teacher_review_candidate_for_import(uuid, uuid) TO %I',
    :'import_user'
) \gexec

SELECT format('CREATE ROLE %I LOGIN', :'backup_user')
WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'backup_user'
) \gexec
SELECT format(
    'ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
    :'backup_user',
    :'backup_password'
) \gexec
SELECT format('REVOKE %I FROM %I', granted_role.rolname, :'backup_user')
FROM pg_auth_members AS membership
INNER JOIN pg_roles AS member_role ON member_role.oid = membership.member
INNER JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
WHERE member_role.rolname = :'backup_user' \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'backup_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'backup_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'backup_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'backup_user') \gexec
SELECT format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'backup_user') \gexec
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    :'schema_owner'
) \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', :'backup_user') \gexec
SELECT format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'backup_user') \gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO %I',
    :'schema_owner',
    :'backup_user'
) \gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON SEQUENCES TO %I',
    :'schema_owner',
    :'backup_user'
) \gexec
SQL

echo "Database migrations are up to date."
