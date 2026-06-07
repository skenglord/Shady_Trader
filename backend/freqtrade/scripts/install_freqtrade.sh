#!/usr/bin/env bash
# install_freqtrade.sh — create venv and install freqtrade sidecar deps.
#
# Idempotent: skips pip install if `freqtrade --version` already works.
# Run from anywhere; resolves its own location.
#
# Usage: npm run freqtrade:install
#        ./backend/freqtrade/scripts/install_freqtrade.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV_DIR="${FT_DIR}/venv"
REQ_FILE="${FT_DIR}/requirements.txt"

# --- 1. Pick a Python (3.11+ required by freqtrade) --------------------------
if command -v python3.11 >/dev/null 2>&1; then
  PY_BIN=python3.11
elif command -v python3.12 >/dev/null 2>&1; then
  PY_BIN=python3.12
elif command -v python3.13 >/dev/null 2>&1; then
  # freqtrade supports 3.11+; 3.13 works but some wheels may need --no-build-isolation
  PY_BIN=python3.13
elif command -v python3 >/dev/null 2>&1; then
  PY_BIN=python3
else
  echo "ERROR: no python3 found on PATH. Install Python 3.11+ first." >&2
  exit 1
fi
echo "Using Python: $($PY_BIN --version)"

# --- 2. Create venv if missing ----------------------------------------------
if [ ! -d "${VENV_DIR}" ]; then
  echo "Creating venv at ${VENV_DIR} ..."
  "${PY_BIN}" -m venv "${VENV_DIR}"
else
  echo "Venv already exists at ${VENV_DIR}"
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

# --- 3. Install requirements (skip if freqtrade already importable) ---------
if "${VENV_DIR}/bin/freqtrade" --version >/dev/null 2>&1; then
  echo "freqtrade already installed: $(${VENV_DIR}/bin/freqtrade --version)"
else
  echo "Installing requirements from ${REQ_FILE} ..."
  pip install --upgrade pip wheel setuptools
  # 3.13 sometimes needs --no-build-isolation for older sdists (e.g. pandas-ta)
  pip install --no-build-isolation -r "${REQ_FILE}" || {
    echo "WARN: pip install failed with --no-build-isolation; retrying without it"
    pip install -r "${REQ_FILE}"
  }
fi

# --- 4. Optional: detect TA-Lib C library and warn if missing ---------------
if "${VENV_DIR}/bin/python" -c "import talib" >/dev/null 2>&1; then
  echo "TA-Lib: available (some indicators will use the optimized C path)"
else
  echo "WARN: TA-Lib C library not installed. freqtrade still works for most"
  echo "      indicators via pandas_ta, but ADX/ATR variants and a handful of"
  echo "      others are disabled. To install: see backend/freqtrade/README.md"
fi

echo
echo "✓ freqtrade sidecar install complete"
echo "  Activate with:  source ${VENV_DIR}/bin/activate"
echo "  Start with:     npm run freqtrade:up"
