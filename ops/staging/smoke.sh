#!/bin/sh
set -eu

fail() {
  printf 'staging smoke: %s\n' "$1" >&2
  exit 1
}

base_url="${DUFESH_STAGING_ORIGIN:-}"
[ -n "$base_url" ] || fail "DUFESH_STAGING_ORIGIN is required"
case "$base_url" in
  https://*) ;;
  http://localhost|http://127.0.0.1) ;;
  *) fail "refusing a non-local HTTP target" ;;
esac
case "$base_url" in
  *dufesh.cn*|*112.126.75.74*) fail "refusing a production target" ;;
esac

tmp_headers="$(mktemp)"
trap 'rm -f "$tmp_headers"' EXIT HUP INT TERM

curl --fail --silent --show-error --max-time 15 -D "$tmp_headers" -o /dev/null "$base_url/"
grep -qi '^X-Content-Type-Options: nosniff' "$tmp_headers" || fail "homepage security headers are incomplete"
grep -qi '^X-Robots-Tag: noindex' "$tmp_headers" || fail "staging robots exclusion is missing"

curl --fail --silent --show-error --max-time 15 -o /dev/null "$base_url/api/auth/health"
curl --fail --silent --show-error --max-time 15 -o /dev/null "$base_url/api/teachers?limit=1"
curl --fail --silent --show-error --max-time 15 -o /dev/null "$base_url/community"

printf 'staging smoke: OK (%s)\n' "$base_url"
