#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
CONFIG_DIR="${QODER_RESERVE_CONFIG_DIR:-/home/qoder/.qoder-reserve}"

mkdir -p "$CONFIG_DIR"

if command -v groupmod >/dev/null 2>&1 && grep -q "^qoder:" /etc/group; then
  groupmod -o -g "$PGID" qoder 2>/dev/null || true
fi
if command -v usermod >/dev/null 2>&1 && id qoder >/dev/null 2>&1; then
  usermod -o -u "$PUID" -g "$PGID" qoder 2>/dev/null || true
fi

chown -R "${PUID}:${PGID}" "$CONFIG_DIR" 2>/dev/null || true

echo "[entrypoint] config=${CONFIG_DIR} uid=${PUID} gid=${PGID}" >&2

if command -v su-exec >/dev/null 2>&1; then
  exec su-exec "${PUID}:${PGID}" node dist/cli.js "$@"
fi

exec node dist/cli.js "$@"
