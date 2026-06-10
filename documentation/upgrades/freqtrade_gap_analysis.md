# Freqtrade Integration — Gap Analysis & Execution Plan

> **Date:** 2026-06-10 audit refresh
> **Scope:** Current on-disk state vs. implementation plan
> **Status:** Core Freqtrade implementation is present. Build, lint, and tests now pass; coverage/complexity/audit gates are not verified.

## 1. Audit Progress (What is Done)

| Phase | Component | Status | Evidence |
|---|---|---|---|
| 0 | Bootstrap & venv | Complete | `backend/freqtrade/venv`, `requirements.txt`, `start_server.sh`, `smoke_test.py` |
| 1 | Reference strategy | Complete | `backend/freqtrade/user_data/strategies/ShadyTraderReferenceStrategy.py` |
| 2 | Bridge module | Implemented, typecheck blocked | `backend/freqtrade/bridge.ts` with Zod schemas, streaming, warning capture |
| 3 | Job queue wiring | Implemented, typecheck blocked | `dataWorker.ts`, `backtestWorker.ts`, `validateWorker.ts` |
| 3.6 | DB migration | Complete | `0003_freqtrade_jobs.ts`, `0004_freqtrade_hyperopt_results.ts` |
| 4 | API surface | Implemented, typecheck blocked | `/api/freqtrade/download-data`, `backtest`, `validate`, `info`, `pairs`, `jobs`, `jobs/:id`, `jobs/:id/cancel`, `ingest` |
| 5 | Bulk ingest script | Implemented | `backend/freqtrade/scripts/bulk_ingest_candles.py` and passing direct tests |
| 6 | Frontend UI | Implemented | `src/components/FreqtradePanel.tsx` with Data/Backtest/Validate tabs |
| 7 | Operational hardening | Partial | Docker/K8s manifests exist; build/lint/test gates pass, but coverage/complexity/audit gates are not verified |
| 8 | CLI integration | Implemented | `cli/src/commands/freqtrade.ts` and `npm run freqtrade:cli` |

## 2. Remaining Gaps

- Full TypeScript check is blocked by existing Freqtrade/backtest/optimization/test type errors.
- Full test suite passes in serial spec mode: `# tests 397`, `# suites 148`, `# pass 396`, `# fail 0`, `# skipped 1`.
- Freqtrade hyperopt result persistence/API/UI/CLI is not implemented yet, although migration `0004_freqtrade_hyperopt_results.ts` exists.
- Real validation jobs still depend on downloaded candles and a working Freqtrade venv.
- Operational hardening is not release-ready until CI/test gates are green.

## 3. Recommended Next Steps

1. Fix TypeScript blockers in `backend/freqtrade/bridge.ts`, `backend/observability/freqtrade_metrics.ts`, and related tests.
2. Run direct Freqtrade tests: bridge, list-strategies, and bulk-ingest.
3. Keep the full-suite teardown fix in place so serial `npm test` does not hang on open BullMQ/Redis handles.
4. Decide whether to implement v6.1 Freqtrade hyperopt automation.
5. Run real Freqtrade download/backtest/validate jobs against downloaded candles and compare in-house vs Freqtrade metrics.
