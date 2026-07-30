#!/bin/sh
set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/opt/dufesh-postgres/migrations}"

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

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
      --variable "version=$version" \
      --command "SELECT checksum FROM schema_migrations WHERE version = :'version';"
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

echo "Database migrations are up to date."
