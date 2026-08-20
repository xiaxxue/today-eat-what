#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"

lsof -ti tcp:$PORT | xargs -r kill -9 >/dev/null 2>&1 || true

echo "Starting at http://$HOST:$PORT ..."
HOST=$HOST PORT=$PORT npm start
