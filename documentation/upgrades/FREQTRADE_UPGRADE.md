# Freqtrade Upgrade Runbook

This document describes the process for upgrading the Freqtrade sidecar
integration, from dependency changes through smoke test and verification.

**Current status:** Implementation is present. Freqtrade config/env wiring, bounded timerange validation, tolerance normalization, fail-closed API credentials, CLI payload defaults, and React request payloads have been aligned. June 16 targeted verification now uses the local Node/npm toolchain; `tests/freqtrade/freqtrade_e2e.test.ts` passes with test-only API credentials, and `start_server.sh` preserves nested `FREQTRADE__*` env vars over legacy fallbacks. Coverage/complexity/audit gates remain unverified.

## Upgrade Checklist

### 1. Update Python dependencies

```bash
cd backend/freqtrade

# Activate venv
source venv/bin/activate

# Upgrade freqtrade and all dependencies
pip install --upgrade -r requirements.txt

# Record the new version
python -c "import freqtrade; print(freqtrade.__version__)" > UPGRADED_VERSION
```

### 2. Verify bridge compatibility

```bash
# Run the bridge unit test
npx tsx --test tests/freqtrade/bridge.test.ts

# Run the strategy discovery test
npx tsx --test tests/freqtrade/list_strategies.test.ts
```

Direct Freqtrade smoke check when Node/npm is unavailable:

```bash
FREQTRADE__EXCHANGE__NAME=binance \
FREQTRADE__EXCHANGE__KEY= \
FREQTRADE__EXCHANGE__SECRET= \
FREQTRADE__EXCHANGE__PASSWORD= \
FREQTRADE__API_SERVER__JWT_SECRET_KEY=dummy-secret-key-for-testing-1234567890 \
FREQTRADE__API_SERVER__USERNAME=change-me-freqtrade-api-user \
FREQTRADE__API_SERVER__PASSWORD=change-me-freqtrade-api-password \
backend/freqtrade/venv/bin/freqtrade list-strategies \
  --userdir backend/freqtrade/user_data \
  -c backend/freqtrade/user_data/config.json
```

Expected: `ShadyTraderReferenceStrategy` appears in the strategy table.

### 3. Run the smoke test

```bash
npm run freqtrade:smoke
```

This checks:
- Python version ≥ 3.11
- Strategy discovery (ShadyTraderReferenceStrategy must appear)
- Basic `--version` output

### 4. Run the full test suite

```bash
npm test
```

Full-suite status now passes in serial spec mode after the June 16 targeted fixes: `# tests 432`, `# suites 156`, `# pass 431`, `# fail 0`, `# skipped 1`. Freqtrade-specific tests should still be run directly and pass before release.
- `tests/freqtrade/bridge.test.ts`
- `tests/freqtrade/list_strategies.test.ts`
- `tests/freqtrade/bulk_ingest.test.ts`

### 5. Verify API endpoints (manual)

```bash
# Check sidecar status
curl -s http://localhost:3000/api/freqtrade/info | jq

# List available pairs
curl -s http://localhost:3000/api/freqtrade/pairs | jq

# List recent jobs
curl -s http://localhost:3000/api/freqtrade/jobs | jq
```

### 6. Verify validate endpoint

Submit a small validation job and check the result includes `pass: true/false`
with `inHouse`, `freqtrade`, and `deltas` fields.

```bash
curl -s -X POST http://localhost:3000/api/freqtrade/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "symbol": "BTC/USDT",
    "timerange": {"start": "20240101", "end": "20240201"},
    "strategy": "ShadyTraderReferenceStrategy",
    "mode": "conservative",
    "pairs": ["BTC/USDT"],
    "timeframe": "1h",
    "dryRunWallet": 10000
  }' | jq
```

### 7. Update the gap analysis

Update `documentation/upgrades/freqtrade_gap_analysis.md` with:
- The new freqtrade version
- Any schema changes in the bridge
- Any new API routes or Zod schemas added

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `freqtrade: command not found` | Venv not activated or missing | Run `npm run freqtrade:install` |
| `FreqtradeBridge.ping()` returns false | Venv Python < 3.11 | Check `python3 --version`, reinstall with Python 3.11+ |
| `list-strategies` cannot load config | Missing `FREQTRADE__*` env vars or JWT secret too short | Export `FREQTRADE__EXCHANGE__NAME`, `FREQTRADE__API_SERVER__JWT_SECRET_KEY`, username, and password before starting the sidecar |
| Backtest returns empty metrics | No candle data for the timerange | Run `npm run freqtrade:download` first |
| Validation always fails (`pass: false`) | No DB candles or indicator pipeline change | Check `candles` table; run `npm run freqtrade:ingest` |
| BullMQ queue not available | Redis not running | `npm run docker:up` or start Redis locally |
