# Freqtrade Upgrade Runbook

This document describes the process for upgrading the Freqtrade sidecar
integration, from dependency changes through smoke test and verification.

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

All freqtrade-specific tests must pass:
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
| Backtest returns empty metrics | No candle data for the timerange | Run `npm run freqtrade:download` first |
| Validation always fails (`pass: false`) | No DB candles or indicator pipeline change | Check `candles` table; run `npm run freqtrade:ingest` |
| BullMQ queue not available | Redis not running | `npm run docker:up` or start Redis locally |
