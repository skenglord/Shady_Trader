# Phase 1 Gate — v6.0 Production Upgrades

Date: 2026-06-01
Phase 1B update: 2026-06-10
Branch: `feat/phase1-foundation`

## Checklist Status

| Gate Criterion | Status | Evidence |
|---|---|---|
| `runMigrations()` completes, idempotent on re-run | ✅ PASS | Verified: double `runMigrations()` no errors |
| `SELECT DISTINCT composite FROM regimes_v2` only canonical | ✅ PASS | No underscore values present |
| `getCompositeRegime('down','weak','normal') === 'bear'` | ✅ PASS | BugFix3 unit-verified |
| `computeVPI(...)` always in [-1, +1] | ✅ PASS | 200-sample fuzz, all bounded (BugFix5) |
| Zero `stochRsi` references in production | ✅ PASS | grep: only replacement comments remain |
| Zero `_Pct` slippage variables in production | ✅ PASS | grep: NONE (values already fractions) |
| RR-RSI bootstrap flag false until 50 RSI obs | ✅ PASS | BugFix1 unit-verified |
| Paper fills use slippage-adjusted `fillPrice` | ✅ PASS | `shadow_trader.processSignal` → `computeFill()` |
| `validateModeForLive('degen')` throws w/o override | ✅ PASS | Verified throws when `DEGEN_LIVE_OVERRIDE` unset |
| `enforceRiskCap()` caps oversized positions | ✅ PASS | Verified clamps to maxFraction |
| Trade lock acquired before exec; released in `finally` | ✅ PASS | `main.ts` runCycle wraps processSignal |
| `stopSchedulers()` clears intervals/timers and closes queues | ✅ PASS | `backend/main.ts` lifecycle regression tests |
| `runCycle()` has overlap guard + abort token checks | ✅ PASS | `backend/main.ts` lifecycle regression tests |
| API lifecycle calls await engine completion | ✅ PASS | `backend/api/routes.ts` awaits `stop()`, `setTimeframe()`, and `loadSettings()` |
| Seed produces exactly 72 trades incl `ai_enhanced` | ✅ PASS | `seed_modes.test.ts` |
| `npx tsc --noEmit` passes | ✅ PASS | `npm run lint` passes with `tsc --noEmit --pretty false`. |
| `npm run test` passes | ✅ PASS | Serial spec run: `# tests 397`, `# suites 148`, `# pass 396`, `# fail 0`, `# skipped 1`. |
| **EXPERIMENT A:** profitFactor > 1.0 BTCUSDT & ETHUSDT | ⏸ DEFERRED-OPERATIONAL | Framework built + unit-verified; requires 6mo live historical candles unavailable in this environment |

## Phase 1B Lifecycle Stabilization

Date: 2026-06-10

Decision: chose production strategy B over the test-only DB initialization workaround. The failing deterministic symptom was not a database setup problem; it was caused by scheduler lifecycle gaps in production: `stopSchedulers()` was a no-op, `stop()`/`killBot()` were fire-and-forget, API handlers did not await lifecycle completion, and `runCycle()` could overlap stale work after stop/restart or timeframe changes.

Production changes:
- `stopSchedulers()` now increments `cycleAbortToken`, clears market/optimization/sleep timers, and closes BullMQ queues.
- `stop()`, `killBot()`, and `setTimeframe()` are async and awaited by callers.
- `/stop`, `/timeframe`, and settings reload route handlers await engine lifecycle completion.
- `runCycle()` now returns immediately when stopped, skips overlapping cycles with `cycleInProgress`, and checks `abortCycleIfNeeded()` after each async step.
- Redis state loading moved from the constructor into `async init()` so async setter changes are not overwritten by stale Redis state.

Regression evidence:
- `tests/deep-deterministic/deep_deterministic_main.test.ts` now covers scheduler stop, sleep cancellation, `setTimeframe()` awaiting `runCycle()`, DB retry cleanup, and missing-exchange `killBot()` behavior.
- Final targeted verification: `npx tsx --test tests/deep-deterministic/deep_deterministic_main.test.ts`
- Result: **# tests 33 / pass 33 / fail 0 / skipped 0**.

Known remaining quality gate:
- `npm run lint` and full `npm test` now pass. Remaining local CI parity work is to verify coverage, complexity, and audit gates.

## Experiment A — Deferred Operational

The backtest framework (`backend/scripts/backtest.ts`, `npm run backtest`) is fully
implemented and the gate metric logic (`computeBacktestMetrics`) is unit-tested
(`tests/backtest/backtest_metrics.test.ts`, 5 pass). The actual Experiment A run
requires ~2 years of BTCUSDT/ETHUSDT OHLCV from a live exchange/data provider,
which is not configured in this environment (no API key, no historical cache).

To run when data is available:

```bash
npm run backtest -- --symbol BTCUSDT --start 2024-01-01 --end 2026-04-01 \
  --mode conservative --slippage-enabled --fees-enabled \
  --output reports/phase1_experiment_a_btc.json

npm run backtest -- --symbol ETHUSDT --start 2024-01-01 --end 2026-04-01 \
  --mode conservative --slippage-enabled --fees-enabled \
  --output reports/phase1_experiment_a_eth.json
```

Gate passes when `profitFactor > 1.0` for BOTH symbols (the script exits non-zero otherwise).

## Pre-existing test failures (NOT introduced by v6 work)

These historical failures were present on the pre-v6 baseline (shared-DB / flaky):
`ExchangeConnector execution adapters`, `IndicatorEngine`,
`BalanceManager should move funds correctly`,
and `ShadowTrader should move funds when opening trade`.
`deep_deterministic_main` is no longer in this list because Phase 1B made the
deterministic engine lifecycle target green independently.

Phase 1 code is complete. With Experiment A formally deferred-operational, Phase 2
code implementation may proceed under the agreed scope (C).
