#!/bin/sh
set -eu
umask 077

APP_ROOT="${APP_ROOT:-/srv/apps/dufesh}"
ENV_FILE="${DUFESH_POSTGRES_ENV_FILE:-$APP_ROOT/shared/config/postgres.env}"
BACKUP_ENV_FILE="${DUFESH_BACKUP_ENV_FILE:-$APP_ROOT/shared/config/backup.env}"
BACKUP_DIR="${BACKUP_DIR:-$APP_ROOT/shared/backups/postgres}"
COMPOSE_DIR="${COMPOSE_DIR:-$APP_ROOT/current}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dufesh}"
MAX_DISK_PERCENT="${MAX_DISK_PERCENT:-85}"
LOCAL_KEEP="${LOCAL_KEEP:-1}"

if [ ! -r "$ENV_FILE" ]; then
  echo "PostgreSQL environment file is missing: $ENV_FILE" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
if [ -r "$BACKUP_ENV_FILE" ]; then
  . "$BACKUP_ENV_FILE"
fi
set +a

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

disk_percent="$(df -P "$APP_ROOT" | awk 'NR == 2 {gsub("%", "", $5); print $5}')"
if [ "$disk_percent" -ge "$MAX_DISK_PERCENT" ]; then
  echo "Refusing to create a local backup at ${disk_percent}% disk usage." >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp_file="$BACKUP_DIR/.${POSTGRES_DB}-${timestamp}.dump.tmp"
backup_file="$BACKUP_DIR/${POSTGRES_DB}-${timestamp}.dump"
checksum_file="${backup_file}.sha256"

cleanup_tmp() {
  rm -f "$tmp_file"
}
trap cleanup_tmp EXIT INT TERM

cd "$COMPOSE_DIR"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
  pg_dump \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --format=custom \
    --compress=9 \
    --no-owner \
    --no-privileges > "$tmp_file"

docker compose -p "$COMPOSE_PROJECT_NAME" exec -T postgres pg_restore --list < "$tmp_file" >/dev/null
mv "$tmp_file" "$backup_file"
sha256sum "$backup_file" > "$checksum_file"

uploaded=0
if [ -n "${OSS_BACKUP_URI:-}" ]; then
  if ! command -v ossutil >/dev/null 2>&1; then
    echo "ossutil is not installed; backup remains local." >&2
  else
    object_uri="${OSS_BACKUP_URI%/}/$(basename "$backup_file")"
    checksum_uri="${object_uri}.sha256"
    ossutil cp "$backup_file" "$object_uri" --force
    ossutil cp "$checksum_file" "$checksum_uri" --force
    ossutil stat "$object_uri" >/dev/null
    uploaded=1
  fi
fi

find "$BACKUP_DIR" -maxdepth 1 -type f -name "${POSTGRES_DB}-*.dump" \
  -printf '%T@ %p\n' | sort -nr | awk -v keep="$LOCAL_KEEP" 'NR > keep {print $2}' |
  while IFS= read -r old_backup; do
    [ -n "$old_backup" ] || continue
    rm -f "$old_backup" "${old_backup}.sha256"
  done

if [ "$uploaded" -eq 1 ]; then
  echo "Backup uploaded and verified: $(basename "$backup_file")"
else
  echo "Backup verified locally: $(basename "$backup_file")"
fi
