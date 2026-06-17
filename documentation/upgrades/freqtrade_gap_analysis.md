# Freqtrade Integration — Gap Analysis & Execution Plan

> **Date:** 2026-06-10 audit refresh
> **Scope:** Current on-disk state vs. implementation plan
> **Status:** Core Freqtrade implementation is present. Config/env wiring, bounded bridge/API timerange validation, tolerance normalization, fail-closed credentials, CLI defaults, and React payloads have been aligned. June 16 targeted verification uses the local Node/npm toolchain; full serial `npm test`, `npm run lint`, and `npm run build` pass.

## 1. Audit Progress (What is Done)

| Phase | Component | Status | Evidence |
|---|---|---|---|
| 0 | Bootstrap & venv | Complete | `backend/freqtrade/venv`, `requirements.txt`, `start_server.sh`, `smoke_test.py` |
| 1 | Reference strategy | Complete | `backend/freqtrade/user_data/strategies/ShadyTraderReferenceStrategy.py` |
| 2 | Bridge module | Implemented | `backend/freqtrade/bridge.ts` with Zod schemas, streaming, warning capture, nested-env injection, bounded timeranges, and fail-closed API credentials |
| 3 | Job queue wiring | Implemented | `dataWorker.ts`, `backtestWorker.ts`, `validateWorker.ts` |
| 4 | API surface | Implemented | `/api/freqtrade/download-data`, `backtest`, `validate`, `info`, `pairs`, `jobs`, `jobs/:id`, `jobs/:id/cancel`, `ingest` |
| 6 | Frontend UI | Implemented | `src/components/FreqtradePanel.tsx` with Data/Backtest/Validate tabs and schema-aligned payloads |
| 8 | CLI integration | Implemented | `cli/src/commands/freqtrade.ts` and `npm run freqtrade:cli` |

## 2. Remaining Gaps

- **Freqtrade hyperopt result persistence/API/UI/CLI is not implemented yet**, although migration `0004_freqtrade_hyperopt_results.ts` exists. This is the only significant remaining gap. Consider implementing in v6.1.
- Real validation jobs still depend on downloaded candles and a working Freqtrade venv.
- Operational hardening is not release-ready until CI/test gates are green.

## 3. Recommended Next Steps

1. In the local Node-enabled shell, rerun `npm run lint`, full serial `npm test`, and direct Freqtrade tests: bridge, list-strategies, and bulk-ingest.
2. Keep the full-suite teardown fix in place so serial `npm test` does not hang on open BullMQ/Redis handles.
3. Decide whether to implement v6.1 Freqtrade hyperopt automation.
4. Run real Freqtrade download/backtest/validate jobs against downloaded candles and compare in-house vs Freqtrade metrics.
