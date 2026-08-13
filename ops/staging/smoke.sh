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
  *) fail "refusing a non-local HTTP target" ;;
esac
case "$base_url" in
  *dufesh.cn*|*112.126.75.74*) fail "refusing a production target" ;;
esac

tmp_headers="$(mktemp)"
tmp_body="$(mktemp)"
tmp_assets="$(mktemp)"
trap 'rm -f "$tmp_headers" "$tmp_body" "$tmp_assets"' EXIT HUP INT TERM

curl_tls=""
case "$base_url" in
  https://localhost*|https://127.0.0.1*) curl_tls="--insecure" ;;
esac

# --insecure is limited above to the loopback-only local certificate path.
curl $curl_tls --fail --silent --show-error --max-time 15 -D "$tmp_headers" -o "$tmp_body" "$base_url/"
grep -qi '^X-Content-Type-Options: nosniff' "$tmp_headers" || fail "homepage security headers are incomplete"
grep -qi '^X-Robots-Tag: noindex' "$tmp_headers" || fail "staging robots exclusion is missing"

grep -oE '(src|href)="/[^"?]+\.(js|css)(\?[^" ]*)?"' "$tmp_body" \
  | sed -E 's/^(src|href)="//; s/"$//' \
  | sort -u > "$tmp_assets" || true
[ -s "$tmp_assets" ] || fail "homepage does not reference any JS/CSS assets"
while IFS= read -r asset_path; do
  : > "$tmp_headers"
  curl $curl_tls --fail --silent --show-error --max-time 15 \
    -D "$tmp_headers" -o /dev/null "$base_url$asset_path"
  case "$asset_path" in
    *.js|*.js\?*)
      grep -qiE '^Content-Type: (text|application)/javascript' "$tmp_headers" || fail "invalid JavaScript MIME"
      ;;
    *.css|*.css\?*)
      grep -qi '^Content-Type: text/css' "$tmp_headers" || fail "invalid CSS MIME"
      ;;
  esac
  grep -qi '^Cache-Control: public, max-age=31536000, immutable' "$tmp_headers" || fail "compiled asset cache policy is missing"
done < "$tmp_assets"

curl $curl_tls --fail --silent --show-error --max-time 15 -o /dev/null "$base_url/api/auth/health"
curl $curl_tls --fail --silent --show-error --max-time 15 -o /dev/null "$base_url/api/teachers?limit=1"
curl $curl_tls --fail --silent --show-error --max-time 15 -o /dev/null "$base_url/community"

printf 'staging smoke: OK (%s)\n' "$base_url"
