#!/usr/bin/env bash
# Run Freqtrade's authenticated webserver in the foreground for containers.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USERDIR="${SCRIPT_DIR}/user_data"
CONFIG="${USERDIR}/config.json"
VENV_DIR="${FREQTRADE_VENV_DIR:-${SCRIPT_DIR}/venv}"

if [[ ! -x "${VENV_DIR}/bin/freqtrade" ]]; then
  echo "ERROR: Freqtrade is not installed in ${VENV_DIR}. Run npm run freqtrade:install." >&2
  exit 1
fi

: "${FREQTRADE_API_USER:=${FREQTRADE__API_SERVER__USERNAME:-}}"
: "${FREQTRADE_API_PASS:=${FREQTRADE__API_SERVER__PASSWORD:-}}"
if [[ -z "${FREQTRADE_API_USER}" || -z "${FREQTRADE_API_PASS}" ]]; then
  echo "ERROR: set FREQTRADE_API_USER and FREQTRADE_API_PASS before enabling the API." >&2
  exit 1
fi

export FREQTRADE__EXCHANGE__NAME="${FREQTRADE__EXCHANGE__NAME:-${EXCHANGE_NAME:-binance}}"
export FREQTRADE__EXCHANGE__KEY="${FREQTRADE__EXCHANGE__KEY:-${EXCHANGE_API_KEY:-}}"
export FREQTRADE__EXCHANGE__SECRET="${FREQTRADE__EXCHANGE__SECRET:-${EXCHANGE_API_SECRET:-}}"
export FREQTRADE__EXCHANGE__PASSWORD="${FREQTRADE__EXCHANGE__PASSWORD:-${EXCHANGE_API_PASSWORD:-}}"
export FREQTRADE__API_SERVER__USERNAME="${FREQTRADE_API_USER}"
export FREQTRADE__API_SERVER__PASSWORD="${FREQTRADE_API_PASS}"
export FREQTRADE__API_SERVER__LISTEN_IP_ADDRESS="${FREQTRADE__API_SERVER__LISTEN_IP_ADDRESS:-127.0.0.1}"
export FREQTRADE__API_SERVER__LISTEN_PORT="${FREQTRADE__API_SERVER__LISTEN_PORT:-${FREQTRADE_LISTEN_PORT:-8081}}"
if [[ -z "${FREQTRADE__API_SERVER__JWT_SECRET_KEY:-}" ]]; then
  export FREQTRADE__API_SERVER__JWT_SECRET_KEY="$("${VENV_DIR}/bin/python" -c 'import secrets; print(secrets.token_hex(32))')"
  echo "Generated an ephemeral Freqtrade JWT secret; set FREQTRADE__API_SERVER__JWT_SECRET_KEY to persist sessions."
fi

exec "${VENV_DIR}/bin/freqtrade" webserver \
  --config "${CONFIG}" \
  --userdir "${USERDIR}"
