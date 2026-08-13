#!/bin/sh
set -eu

fail() {
  printf 'staging preflight: %s\n' "$1" >&2
  exit 1
}

require_var() {
  eval "value=\${$1-}"
  [ -n "$value" ] || fail "$1 is required"
}

require_absolute_file() {
  eval "path=\${$1-}"
  case "$path" in
    /*) ;;
    *) fail "$1 must be an absolute path" ;;
  esac
  [ -f "$path" ] || fail "$1 does not name a regular file"
  case "$path" in
    /srv/apps/dufesh/shared/*) fail "$1 points at the production shared directory" ;;
  esac
  if command -v stat >/dev/null 2>&1; then
    mode="$(stat -c '%a' "$path" 2>/dev/null || true)"
    [ "$mode" = "600" ] || fail "$1 must have mode 600"
  fi
}

env_value() {
  key="$1"
  file="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

require_var DUFESH_IMAGE_TAG
case "$DUFESH_IMAGE_TAG" in
  *[!0-9a-f]*|'') fail "DUFESH_IMAGE_TAG must be a lowercase full Git SHA" ;;
esac
[ "${#DUFESH_IMAGE_TAG}" -eq 40 ] || fail "DUFESH_IMAGE_TAG must contain exactly 40 characters"

require_var DUFESH_STAGING_ORIGIN
require_var DUFESH_STAGING_SITE_ADDRESS
case "$DUFESH_STAGING_ORIGIN" in
  https://*) ;;
  *) fail "staging origin must use HTTPS" ;;
esac
case "$DUFESH_STAGING_ORIGIN,$DUFESH_STAGING_SITE_ADDRESS" in
  *dufesh.cn*|*112.126.75.74*) fail "production hosts are forbidden in staging" ;;
esac
case "$DUFESH_STAGING_SITE_ADDRESS" in
  https://localhost|https://127.0.0.1)
    case "$DUFESH_STAGING_ORIGIN" in
      https://localhost*|https://127.0.0.1*) ;;
      *) fail "the loopback Caddy listener is only valid for a local origin" ;;
    esac
    ;;
  https://*)
    [ "$DUFESH_STAGING_SITE_ADDRESS" = "$DUFESH_STAGING_ORIGIN" ] || \
      fail "public Caddy site address must match the staging origin"
    ;;
  *) fail "Caddy site address must be :80 locally or the HTTPS staging origin" ;;
esac

bind_address="${DUFESH_STAGING_BIND_ADDRESS:-127.0.0.1}"
case "$bind_address" in
  127.0.0.1|::1) ;;
  *)
    [ "${DUFESH_STAGING_ALLOW_PUBLIC_BIND:-}" = "YES-I-HAVE-APPROVAL" ] || \
      fail "public bind requires explicit approval"
    ;;
esac

require_var DUFESH_STAGING_POSTGRES_ENV_FILE
require_var DUFESH_STAGING_AUTH_ENV_FILE
require_absolute_file DUFESH_STAGING_POSTGRES_ENV_FILE
require_absolute_file DUFESH_STAGING_AUTH_ENV_FILE

postgres_db="$(env_value POSTGRES_DB "$DUFESH_STAGING_POSTGRES_ENV_FILE")"
[ -n "$postgres_db" ] || fail "POSTGRES_DB is missing"
case "$postgres_db" in
  *_staging) ;;
  *) fail "POSTGRES_DB must end in _staging" ;;
esac
for secret_name in POSTGRES_PASSWORD MIGRATION_DB_PASSWORD BACKUP_DB_PASSWORD IMPORT_DB_PASSWORD; do
  [ -n "$(env_value "$secret_name" "$DUFESH_STAGING_POSTGRES_ENV_FILE")" ] || fail "$secret_name is missing"
done

auth_origin="$(env_value AUTH_PUBLIC_ORIGIN "$DUFESH_STAGING_AUTH_ENV_FILE")"
allowed_origins="$(env_value AUTH_ALLOWED_ORIGINS "$DUFESH_STAGING_AUTH_ENV_FILE")"
[ "$auth_origin" = "$DUFESH_STAGING_ORIGIN" ] || fail "AUTH_PUBLIC_ORIGIN does not match staging origin"
case ",$allowed_origins," in
  *,"$DUFESH_STAGING_ORIGIN",*) ;;
  *) fail "AUTH_ALLOWED_ORIGINS does not contain the staging origin" ;;
esac
for secret_name in AUTH_TOKEN_PEPPER AUTH_ADMIN_MFA_KEYS AUTH_ADMIN_RECOVERY_PEPPER; do
  [ -n "$(env_value "$secret_name" "$DUFESH_STAGING_AUTH_ENV_FILE")" ] || fail "$secret_name is missing"
done
case "$auth_origin,$allowed_origins" in
  *dufesh.cn*|*112.126.75.74*) fail "production origins are forbidden in staging auth configuration" ;;
esac

require_var DUFESH_STAGING_RESOURCES_DIR
case "$DUFESH_STAGING_RESOURCES_DIR" in
  /*) ;;
  *) fail "DUFESH_STAGING_RESOURCES_DIR must be an absolute path" ;;
esac
[ -d "$DUFESH_STAGING_RESOURCES_DIR" ] || fail "staging resources directory does not exist"
case "$DUFESH_STAGING_RESOURCES_DIR" in
  /srv/apps/dufesh/shared/*) fail "staging resources point at production storage" ;;
esac

if [ -n "${NEXT_PUBLIC_XIAOYING_URL:-}" ]; then
  require_var DUFESH_STAGING_XIAOYING_ENV_FILE
  require_absolute_file DUFESH_STAGING_XIAOYING_ENV_FILE
fi

command -v docker >/dev/null 2>&1 || fail "docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
docker compose -p "dufesh-staging-${DUFESH_IMAGE_TAG%????????????????????????????????}" \
  -f docker-compose.staging.yml config --quiet

printf 'staging preflight: OK (%s)\n' "$DUFESH_IMAGE_TAG"
