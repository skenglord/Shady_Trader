# Freqtrade Hyperopt Spike — Task 0 (v6.1 plan) — PASSED

**Date:** 2026-06-07
**Plan:** `.hermes/plans/2026-06-07_082426-freqtrade-hyperopt-v6.1.md` (Task 0)
**Spike log:** `.hermes/spike-logs/hyperopt-smoke-20260607-164643.log`

## Outcome

The `freqtrade hyperopt` CLI machinery runs end-to-end. Hit the expected
"no data found" wall (no OHLCV has been downloaded for BTC/USDT:USDT on
1h yet) — **per the plan, that IS success**: "the goal is to confirm the
CLI machinery, not to actually run hyperopt on empty data."

## Verification signals (all present in the log)

- `Parameter -s/--spaces detected: ['buy', 'sell']`
- `Parameter --print-json detected ...`
- `Using Hyperopt loss class name: SharpeHyperOptLoss`
- `Using pairs ['BTC/USDT:USDT']`
- `Using resolved hyperoptloss SharpeHyperOptLoss from ... hyperopt_loss_sharpe.py`
- `manager queue <class 'multiprocessing.managers.AutoProxy[Queue]'>`
- `Using optimizer random state: 27668`
- Strategy parameters enumerated: `buy_rsi = 30`, `atr_mult = 2.0`, `sell_rsi = 70`
- Terminated with: `No data found. Use 'freqtrade download-data' to download the data`

## Negative signals (none present)

- No "No module named" (optuna, filelock, sklearn all installed)
- No "is not known to the ccxt library" (env vars bridged correctly)
- No "is too short" (JWT secret >= 32 chars)
- No "is not tradable" / "No pair in whitelist" (pair format is futures)
- No "Configuration error" (no schema validation failures)

## Blockers resolved during the spike

1. **Hyperopt extras missing from base install** — `freqtrade[plotting]` in
   `requirements.txt` does NOT include hyperopt deps. Installed
   `freqtrade[hyperopt]==2026.5.1` (pulled optuna, scikit-learn, scipy,
   filelock, cmaes, colorlog, mako, alembic, pyyaml, threadpoolctl,
   narwhals). **Action item for the plan:** add `freqtrade[hyperopt]` to
   `backend/freqtrade/requirements.txt` so the venv has it on next
   rebuild.

2. **PyPI too slow** — `files.pythonhosted.org` was throttled / unreachable
   in this env. Switched to `https://mirrors.aliyun.com/pypi/simple/`.
   Drops 5+ min hangs to <30s. Documented in
   `~/.hermes/skills/software-development/external-engine-integration/references/freqtrade.md`
   pitfall #6 and in `MEMORY.md`.

3. **Config env-var interpolation** — `config.json` uses bash-style
   `${VAR:-default}` but freqtrade expects `FREQTRADE__SECTION__KEY` env
   vars. `start_server.sh` already does the bridge; for spikes we use
   `/tmp/freqtrade-hyperopt-env.sh` (env-only, doesn't start the server).

4. **Pair format for futures** — config is futures mode, must use
   `BTC/USDT:USDT` not `BTC/USDT`.

5. **Bash quoting in Hermes multi-line `terminal()`** — `$(openssl rand ...)`
   inline gets mangled. Workaround: write env-var block to a script file
   first, then `source` it.

## Bug in plan step 4

The plan's step 4 was:
```bash
echo "spike-logs/" >> .gitignore
git add .gitignore .hermes/spike-logs/
git commit -m "spike(freqtrade): verify hyperopt CLI works in our env"
```

This is broken: `.gitignore` line 21 has `*.log` which catches these
spike logs, AND the new `spike-logs/` entry only matches a top-level
dir, not `.hermes/spike-logs/`. So `git add .hermes/spike-logs/` is a
no-op. **Workaround applied:** committed this summary markdown
(`HYPEROPT-SPIKE-SUMMARY.md`) as the durable spike outcome; the raw
log is left gitignored as noise.

## Next step

Tasks 1-4 of the v6.1 plan are unblocked. Recommendation: proceed to
Task 1 (database migration for `freqtrade_hyperopt_results` table).
But first, run `freqtrade download-data` to actually pull OHLCV for
BTC/USDT:USDT 1h, so we can validate the strategy produces non-default
hyperopt results in a follow-up spike (Task 0.5 maybe).
