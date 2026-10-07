#!/usr/bin/env bash
# Validate the pinned Python runtime, config substitution, and strategy imports.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
USERDIR="${FT_DIR}/user_data"
PYTHON="${FREQTRADE_PYTHON:-${FT_DIR}/venv/bin/python}"
FREQTRADE_BIN="${FREQTRADE_BIN:-${FT_DIR}/venv/bin/freqtrade}"

if [[ ! -x "${PYTHON}" || ! -x "${FREQTRADE_BIN}" ]]; then
  echo "ERROR: Freqtrade runtime is missing. Run npm run freqtrade:install." >&2
  exit 1
fi

"${PYTHON}" -m json.tool "${USERDIR}/config.json" >/dev/null
export FREQTRADE__EXCHANGE__NAME="${FREQTRADE__EXCHANGE__NAME:-binance}"
export FREQTRADE__EXCHANGE__KEY="${FREQTRADE__EXCHANGE__KEY:-validation-only}"
export FREQTRADE__EXCHANGE__SECRET="${FREQTRADE__EXCHANGE__SECRET:-validation-only}"
export FREQTRADE__EXCHANGE__PASSWORD="${FREQTRADE__EXCHANGE__PASSWORD:-}"
export FREQTRADE__API_SERVER__USERNAME="${FREQTRADE_API_USER:-validation-user}"
export FREQTRADE__API_SERVER__PASSWORD="${FREQTRADE_API_PASS:-validation-password}"
export FREQTRADE__API_SERVER__JWT_SECRET_KEY="${FREQTRADE_JWT_SECRET_KEY:-$("${PYTHON}" -c 'import secrets; print(secrets.token_hex(32))')}"

"${FREQTRADE_BIN}" --version
STRATEGIES="$("${FREQTRADE_BIN}" list-strategies --config "${USERDIR}/config.json" --userdir "${USERDIR}" 2>&1)" || {
  echo "ERROR: Freqtrade failed to load its configuration or strategies." >&2
  echo "${STRATEGIES}" >&2
  exit 1
}
if ! grep -Fq 'ShadyTraderReferenceStrategy' <<<"${STRATEGIES}"; then
  echo "ERROR: ShadyTraderReferenceStrategy was not discovered by Freqtrade." >&2
  echo "${STRATEGIES}" >&2
  exit 1
fi
echo "Freqtrade runtime, config, and reference strategy validated."
