#!/usr/bin/env bash
# start_server.sh — run the freqtrade webserver sidecar.
#
# Bridges Shady_Trader env vars (EXCHANGE_NAME, EXCHANGE_API_KEY, etc.) to
# Freqtrade's FREQTRADE__ prefix convention so config.json stays clean.
#
# Usage: npm run freqtrade:up
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/venv"
PID_FILE="${SCRIPT_DIR}/.pid"
LOG_FILE="${SCRIPT_DIR}/freqtrade.log"
CONFIG="${SCRIPT_DIR}/user_data/config.json"
USERDIR="${SCRIPT_DIR}/user_data"
PORT="${FREQTRADE_LISTEN_PORT:-8081}"

# Activate venv
if [ ! -f "${VENV_DIR}/bin/activate" ]; then
  echo "ERROR: venv not found at ${VENV_DIR}. Run: npm run freqtrade:install" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

# Refuse to double-start
if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "freqtrade already running (pid $(cat "${PID_FILE}")) on port ${PORT}"
  echo "Use npm run freqtrade:down first to stop it."
  exit 0
fi

# ── Bridge Shady_Trader env vars → Freqtrade FREQTRADE__ prefix ──
# These are consumed at runtime by freqtrade/configuration/environment_vars.py
if [ -z "${FREQTRADE_API_USER:-}" ] && [ -z "${FREQTRADE__API_SERVER__USERNAME:-}" ]; then
  echo "ERROR: FREQTRADE_API_USER is required before starting the Freqtrade webserver" >&2
  exit 1
fi

if [ -z "${FREQTRADE_API_PASS:-}" ] && [ -z "${FREQTRADE__API_SERVER__PASSWORD:-}" ]; then
  echo "ERROR: FREQTRADE_API_PASS is required before starting the Freqtrade webserver" >&2
  exit 1
fi

: "${FREQTRADE__EXCHANGE__NAME:=${EXCHANGE_NAME:-binance}}"
: "${FREQTRADE__EXCHANGE__KEY:=${EXCHANGE_API_KEY:-}}"
: "${FREQTRADE__EXCHANGE__SECRET:=${EXCHANGE_API_SECRET:-}}"
: "${FREQTRADE__EXCHANGE__PASSWORD:=${EXCHANGE_API_PASSWORD:-}}"
: "${FREQTRADE__API_SERVER__USERNAME:=${FREQTRADE_API_USER:-}}"
: "${FREQTRADE__API_SERVER__PASSWORD:=${FREQTRADE_API_PASS:-}}"

export FREQTRADE__EXCHANGE__NAME="${FREQTRADE__EXCHANGE__NAME}"
export FREQTRADE__EXCHANGE__KEY="${FREQTRADE__EXCHANGE__KEY}"
export FREQTRADE__EXCHANGE__SECRET="${FREQTRADE__EXCHANGE__SECRET}"
export FREQTRADE__EXCHANGE__PASSWORD="${FREQTRADE__EXCHANGE__PASSWORD}"
export FREQTRADE__API_SERVER__USERNAME="${FREQTRADE__API_SERVER__USERNAME}"
export FREQTRADE__API_SERVER__PASSWORD="${FREQTRADE__API_SERVER__PASSWORD}"

: "${EXCHANGE_NAME:=${FREQTRADE__EXCHANGE__NAME}}"
: "${EXCHANGE_API_KEY:=${FREQTRADE__EXCHANGE__KEY}}"
: "${EXCHANGE_API_SECRET:=${FREQTRADE__EXCHANGE__SECRET}}"
: "${EXCHANGE_API_PASSWORD:=${FREQTRADE__EXCHANGE__PASSWORD}}"

# Generate JWT secret if not pinned via env.
if [ -z "${FREQTRADE__API_SERVER__JWT_SECRET_KEY:-}" ]; then
  if command -v openssl >/dev/null 2>&1; then
    export FREQTRADE__API_SERVER__JWT_SECRET_KEY="$(openssl rand -base64 48 | tr -d '\n=' | cut -c1-64)"
  else
    export FREQTRADE__API_SERVER__JWT_SECRET_KEY="$(head -c 48 /dev/urandom | base64 | tr -d '\n=' | cut -c1-64)"
  fi
  echo "Generated ephemeral FREQTRADE_JWT_SECRET_KEY (sessions reset on restart)."
  echo "Set FREQTRADE__API_SERVER__JWT_SECRET_KEY in .env to persist."
fi

echo "Starting freqtrade webserver on http://127.0.0.1:${PORT} ..."
echo "  config:  ${CONFIG}"
echo "  userdir: ${USERDIR}"
echo "  log:     ${LOG_FILE}"
echo "  exchange: ${EXCHANGE_NAME}"

nohup freqtrade webserver \
  --config "${CONFIG}" \
  --userdir "${USERDIR}" \
  >"${LOG_FILE}" 2>&1 &

PID=$!
echo "${PID}" > "${PID_FILE}"
echo "freqtrade started (pid ${PID}). Tail logs: tail -f ${LOG_FILE}"
echo "Stop with: npm run freqtrade:down"
