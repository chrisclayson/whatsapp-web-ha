#!/bin/sh
set -eu

OPTIONS=/data/options.json
mkdir -p /data

TOKEN="$(jq -r '.api_token // ""' "$OPTIONS" 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  TOKEN="${BRIDGE_TOKEN:-}"
fi

if [ -z "$TOKEN" ]; then
  TOKEN="$(cat /data/api_token 2>/dev/null || true)"
  if [ -z "$TOKEN" ]; then
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /data/api_token
    chmod 600 /data/api_token
    TOKEN="$(cat /data/api_token)"
    echo "[INFO] Generated a new API token."
  fi
  echo "[INFO] Bridge API token: $TOKEN"
  echo "[INFO] Paste this token into the Home Assistant integration."
fi

LOG_LEVEL="$(jq -r '.log_level // "info"' "$OPTIONS" 2>/dev/null || echo info)"

export BRIDGE_TOKEN="$TOKEN"
export BRIDGE_LOG_LEVEL="$LOG_LEVEL"
export BRIDGE_DATA_DIR=/data
export BRIDGE_HOST=0.0.0.0
export BRIDGE_PORT=3000

exec node /app/src/index.js
