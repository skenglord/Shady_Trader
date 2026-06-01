# Component Readiness Matrix — v6.0

| Block | Component | Path | Phase | Wired | Tested | Status |
|-------|-----------|------|-------|-------|--------|--------|
| 1 | CLI Scaffold | `cli/` | 1 | ✅ | ✅ | Ready |
| 2 | Regime Types | `backend/types/regime.ts` | 1 | ✅ | ✅ | Ready |
| 2 | Migrations | `backend/migrations/` | 1 | ✅ | ✅ | Ready |
| 3 | RR-RSI | `backend/indicators/rrRsi.ts` | 1 | ✅ | ✅ | Ready |
| 3 | VPI | `backend/indicators/volumePressureIndex.ts` | 1 | ✅ | ✅ | Ready |
| 3 | WaveTrend/MFI | `backend/indicators/engine.ts` | 1 | ✅ | ✅ | Ready |
| 4 | Regime Detection v2 | `backend/regime/detector.ts` | 1 | ✅ | ✅ | Ready |
| 5 | Signal Scoring | `backend/strategy/signal_generator.ts` | 1 | ✅ | ✅ | Ready |
| 6 | Risk Safety | `backend/risk/manager.ts` | 1 | ✅ | ✅ | Ready |
| 7 | Fill Calculator | `backend/slippage/fillCalculator.ts` | 1 | ✅ | ✅ | Ready |
| 8 | Execution Lock | `backend/execution/executionLock.ts` | 1 | ✅ | ✅ | Ready |
| 9 | Seed Data | `backend/seed.ts` | 1 | ✅ | ✅ | Ready |
| 10 | Backtest Framework | `backend/scripts/backtest.ts` | 1 | ✅ | ✅ | Ready |
| 11 | ATR Ratchet | `backend/exits/atrRatchet.ts` | 2 | ⏸ | ✅ | Code Ready |
| 12 | Gemma Adapter | `backend/ai/gemmaAdapter.ts` | 2 | ⏸ | ✅ | Code Ready |
| 13 | Bayesian Analytics | `backend/analytics/bayesianAnalytics.ts` | 2 | ⏸ | ✅ | Code Ready |
| 14 | CLI Panels | `cli/src/commands/monitor.ts` | 2 | ✅ | ✅ | Ready |
| 15 | ML Predictor | `backend/ml/mlPredictor.ts` | 2 | ⏸ | ⏸ | Stub |
| 16 | Entry Filter | `backend/ml/entryPredictor.ts` | 3 | ❌ | ⏸ | Isolated |
| 17 | HMM Research | `backend/research/hmm/` | 3 | ❌ | ❌ | Isolated |

**Legend:**
- ✅ = Complete
- ⏸ = Deferred (awaiting data/models/calibration)
- ❌ = Intentionally isolated (no production imports)

## Phase 1 Components (Production-Ready)

All Phase 1 blocks are wired into the main trading cycle and verified by tests:
- Migrations run automatically on server start
- Regime detection returns canonical composite
- Indicators compute WaveTrend, MFI, VPI, RR-RSI
- Signal generator uses divergence guard + VPI/RR-RSI scoring
- Risk manager validates modes and caps positions
- Paper fills use slippage-adjusted prices
- Execution lock prevents duplicate trades

## Phase 2 Components (Code Ready, Awaiting Calibration)

Phase 2 modules are implemented and tested but not yet wired into production:
- **ATR Ratchet**: Requires `RATCHET_CALIBRATED=true` after backtest calibration
- **Gemma Adapter**: Requires `GEMMA_ENABLED=true` and Ollama endpoint
- **Bayesian Analytics**: Ready to compute posterior distributions
- **ML Predictor**: Stub awaiting ONNX model training

To wire Phase 2:
1. Run `npm run backtest -- --calibrate-ratchet`
2. Set `RATCHET_CALIBRATED=true` in `.env`
3. Configure Ollama endpoint and set `GEMMA_ENABLED=true`
4. Train ONNX models and place in `.models/`

## Phase 3 Components (Research Isolated)

Phase 3 modules are intentionally isolated from production:
- **Entry Filter**: A/B experiment framework, needs 500 trades before promotion decision
- **HMM Research**: Pure research module, no production imports allowed

These require separate validation before any production integration.

## Experiment A Status

**Deferred-Operational**: The 6-month backtest gate requires BTCUSDT/ETHUSDT historical candles not available in this environment. Framework is built and unit-verified. Run when data is available:

```bash
npm run backtest -- --symbol BTCUSDT --start 2024-01-01 --end 2026-04-01 \
  --mode conservative --slippage-enabled --fees-enabled
```

Gate passes when `profitFactor > 1.0` for both symbols.
