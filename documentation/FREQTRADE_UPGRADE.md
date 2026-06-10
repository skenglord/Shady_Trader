# Freqtrade Upgrade Runbook

**Scope:** Bumping the pinned Freqtrade version (`freqtrade[plotting]==2026.5.1` in `backend/freqtrade/requirements.txt`) to a newer release, and reconciling the TypeScript bridge, Zod schemas, workers, REST API, CLI, and tests.
**Current status:** Implementation is present. Build, lint, and tests now pass; coverage/complexity/audit gates are not verified.
**References:** `documentation/upgrades/freqtrade_integration_plan.md`, `documentation/upgrades/freqtrade_gap_analysis.md`.

## 1. Pre-upgrade checklist

- [ ] All open issues in the Freqtrade changelog reviewed (https://www.freqtrade.io/en/stable/release_notes/)
- [ ] The new `freqtrade` version is pinned in the project's `requirements.txt` *before* running the install
- [ ] The trading engine is stopped (`POST /api/stop`)
- [ ] The Freqtrade sidecar is stopped (`npm run freqtrade:down`)

## 2. Upgrade steps

```bash
# 1. Bump the pin in backend/freqtrade/requirements.txt
#    e.g.  freqtrade[plotting]==2026.6.0
#    Commit this change with a clear message: "chore(freqtrade): bump to 2026.6.0"

# 2. Upgrade the venv
cd /home/creekz/Shady_Trader
npm run freqtrade:upgrade
# This runs: pip install --upgrade -r backend/freqtrade/requirements.txt

# 3. Diff the API_VERSION constant
diff <(grep -E "INTERFACE_VERSION|api_version" backend/freqtrade/venv/lib/python3.13/site-packages/freqtrade/strategy/interface.py) <(grep -E "INTERFACE_VERSION" backend/freqtrade/user_data/strategies/*.py)
# Any drift means we need to bump our strategy's INTERFACE_VERSION (currently 3).

# 4. Diff our Zod schemas against the new BacktestResult JSON shape
#    Fetch a sample backtest result:
backend/freqtrade/venv/bin/freqtrade backtesting \
  --config backend/freqtrade/user_data/config.json \
  --userdir backend/freqtrade/user_data \
  --strategy ShadyTraderReferenceStrategy \
  --timerange 20240601-20240701 \
  --export trades
# Inspect backtest_results/backtest-result-*.json and compare to BacktestResultSchema in
# backend/freqtrade/bridge.ts. Update the schema if needed.

# 5. Run the test suite
npm test

# 6. Run the smoke test
npm run freqtrade:smoke

# 7. Restart the engine + sidecar
npm run freqtrade:up
PORT=3000 npm run dev
```

## 3. Post-upgrade validation

```bash
# 8. Run the 30-day reconcile test (Phase 7 step 7.5)
npm run backtest -- --mode moderate --slippage-enabled
# Then run Freqtrade:
backend/freqtrade/venv/bin/freqtrade backtesting \
  --config backend/freqtrade/user_data/config.json \
  --userdir backend/freqtrade/user_data \
  --strategy ShadyTraderReferenceStrategy \
  --timerange 20240601-20240701
# Compare results via /api/freqtrade/validate — Sharpe Δ must be < FREQTRADE_VALIDATE_TOLERANCE (5%).

# 9. Update AGENTS.md with a "Freqtrade upgrade" entry under "Recently Completed Tasks"
# 10. Tag the release
```

## 4. Common upgrade gotchas

| Gotcha | Mitigation |
|---|---|
| `INTERFACE_VERSION` bumped to 4 | Update `ShadyTraderReferenceStrategy.py` to v4; rerun smoke test |
| `freqtrade.rpc.api_server.api_v1` renamed or restructured | Update `bridge.listStrategies()` parser; add a unit test for the new output shape |
| `BacktestResult` JSON shape changed | Update `BacktestResultSchema` in `bridge.ts`; rerun `tests/freqtrade/bridge.test.ts` |
| New dependency on `pandas_ta` extras | Add the new extras to `requirements.txt` and rerun `pip install` |
| Disk format change (parquet → feather or vice versa) | Update `user_data/config.json`'s `dataformat_ohlcv` field; rerun `bulk_ingest_candles.py` to migrate |
| TAlib binary incompatibility on Linux ARM | See `backend/freqtrade/README.md` for the apt install snippet |

## 5. Rollback

If the new Freqtrade version breaks the sidecar:

```bash
# 1. Stop the sidecar
npm run freqtrade:down

# 2. Revert the pin in backend/freqtrade/requirements.txt
git checkout HEAD~1 -- backend/freqtrade/requirements.txt

# 3. Reinstall the old version
npm run freqtrade:upgrade

# 4. Verify
npm run freqtrade:smoke
```

The bridge.ts and Zod schemas are version-agnostic wrappers; the only file that may need a forced revert is `ShadyTraderReferenceStrategy.py` if the `INTERFACE_VERSION` was bumped.
