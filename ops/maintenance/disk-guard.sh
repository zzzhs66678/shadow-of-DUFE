#!/bin/sh
set -eu

APP_ROOT="${APP_ROOT:-/srv/apps/dufesh}"
WARN_PERCENT="${WARN_PERCENT:-70}"
CLEAN_PERCENT="${CLEAN_PERCENT:-75}"
CRITICAL_PERCENT="${CRITICAL_PERCENT:-85}"

usage_percent="$(df -P "$APP_ROOT" | awk 'NR == 2 {gsub("%", "", $5); print $5}')"
echo "Root disk usage: ${usage_percent}%"

if [ "$usage_percent" -ge "$WARN_PERCENT" ]; then
  logger -t dufesh-disk-guard "Disk usage warning: ${usage_percent}%"
fi

if [ "$usage_percent" -ge "$CLEAN_PERCENT" ]; then
  docker builder prune --force --filter "until=24h" >/dev/null
  docker image prune --force --filter "until=168h" >/dev/null

  find "$APP_ROOT/shared/backups/postgres" -maxdepth 1 -type f -name '*.tmp' -mtime +1 -delete 2>/dev/null || true
fi

mkdir -p "$APP_ROOT/shared/run"
if [ "$usage_percent" -ge "$CRITICAL_PERCENT" ]; then
  : > "$APP_ROOT/shared/run/disk-critical"
  logger -t dufesh-disk-guard "Disk usage critical: ${usage_percent}%"
else
  rm -f "$APP_ROOT/shared/run/disk-critical"
fi
