#!/usr/bin/env bash
# stop_server.sh — stop the freqtrade webserver sidecar.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${SCRIPT_DIR}/.pid"

if [ ! -f "${PID_FILE}" ]; then
  echo "No .pid file at ${PID_FILE}. Is the sidecar running?"
  exit 0
fi

PID="$(cat "${PID_FILE}")"
if ! kill -0 "${PID}" 2>/dev/null; then
  echo "Stale .pid (pid ${PID} not running). Removing."
  rm -f "${PID_FILE}"
  exit 0
fi

echo "Stopping freqtrade (pid ${PID}) ..."
kill "${PID}" || true

# Wait up to 5s for graceful exit
for _ in 1 2 3 4 5; do
  if ! kill -0 "${PID}" 2>/dev/null; then
    rm -f "${PID_FILE}"
    echo "✓ freqtrade stopped"
    exit 0
  fi
  sleep 1
done

echo "WARN: freqtrade did not exit after 5s; sending SIGKILL"
kill -9 "${PID}" || true
rm -f "${PID_FILE}"
