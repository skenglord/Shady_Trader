# Freqtrade Integration — Gap Analysis & Execution Plan

> **Date:** 5 June 2026  
> **Scope:** Audit of on-disk state vs. `freqtrade_integration_plan.md`  
> **Status:** Phases 0-6 complete. Phases 7 (ops hardening) and 8 (CLI) implemented.
|
| ---

## 1. Audit Progress (What is Done)

| Phase | Component | Status | Evidence |
|---|---|---|---|
| **Phase 0** | Bootstrap & Venv | ✅ Complete | `backend/freqtrade/venv`, `requirements.txt`, `start_server.sh` exist. |
| **Phase 1** | Reference Strategy | ✅ Complete | `backend/freqtrade/user_data/strategies/ShadyTraderReferenceStrategy.py` exists. |
| **Phase 2** | Bridge Module | ✅ Complete | `backend/freqtrade/bridge.ts` (Zod validation, streaming, warning capture). Tests pass. |
| **Phase 3** | Job Queue Wiring | ✅ Complete | `dataWorker.ts`, `backtestWorker.ts`, `validateWorker.ts` exist. Registered in `job_queues.ts`. |
| **Phase 3.6** | DB Migration | ✅ Complete | `0003_freqtrade_jobs.ts` exists. `freqtrade_jobs` table confirmed in `trading.db`. |
| **Phase 4** | API Surface | ✅ Complete | 8 routes in `routes.ts`: download-data, backtest, validate, info, pairs, jobs, jobs/:id, ingest, jobs/:id/cancel. All with Zod validation. |
| **Phase 5** | Bulk Ingest Script | ✅ Complete | `backend/freqtrade/scripts/bulk_ingest_candles.py` exists with passing tests. |
| **Phase 6** | Frontend UI | ✅ Complete | `src/components/FreqtradePanel.tsx` with Data/Backtest/Validate tabs. `App.tsx` has button + modal at line 3244. |
| **Phase 7** | Operational Hardening | ✅ Complete | `docker-compose.yml` has freqtrade service + `freqtrade_data` volume. `k8s/pvc.yaml` has `freqtrade-data-pvc`. CI gate validates backtest service + validateWorker compilation. `FREQTRADE_UPGRADE.md` runbook created. |
| **Phase 8** | CLI Integration | ✅ Complete | `cli/src/commands/freqtrade.ts` with 8 subcommands (info, jobs, job, cancel, pairs, download, backtest, validate, ingest). Registered in `cli/src/index.ts`. `npm run freqtrade:cli` wired. |

---

## 2. Gap Analysis (What is Missing)

All integration gaps have been closed. See `FREQTRADE_UPGRADE.md` for the
upgrade runbook and `AGENTS.md` for the changelog.

---

## 3. Implementation Strategy (Prioritized Execution Plan)

To complete the integration, build the missing layers in this logical dependency order: **API → Observability → CLI → Frontend → Deployment**.

### Priority 1: Phase 4 — API Surface (Critical Foundation)
*Without these routes, the system is unusable from the outside.*
1. **Add Zod schemas** for all Freqtrade API requests in `backend/api/routes.ts`.
2. **Implement `POST /api/freqtrade/download-data`** (admin): Validates payload, generates `jobId`, inserts `queued` row into `freqtrade_jobs`, and adds job to `freqtradeDataQueue`.
3. **Implement `POST /api/freqtrade/backtest`** (admin): Similar flow, adds to `freqtradeBacktestQueue`.
4. **Implement `POST /api/freqtrade/validate`** (admin): Adds to `freqtradeValidateQueue`. *Note: Update `validateWorker.ts` to actually call `engine.runBacktest` instead of the current placeholder.*
5. **Implement `GET /api/freqtrade/jobs`** and **`GET /api/freqtrade/jobs/:id`** (trader): Query the `freqtrade_jobs` table.
6. **Implement `POST /api/freqtrade/ingest`** (admin): Spawns `bulk_ingest_candles.py` (or calls it via a new worker) to push data to SQLite.
7. **Add routes to `traderRoutes`/`adminRoutes`** for proper auth.

### Priority 2: Phase 7 — Observability (Metrics Wiring)
1. **Wire Metrics**: Import `freqtradeMetricsRegistry` in `backend/api/routes.ts` and merge its output into the `/api/diagnostics/metrics` endpoint.
2. **Update Workers**: Modify `dataWorker.ts`, `backtestWorker.ts`, and `validateWorker.ts` to call `recordFreqtradeJob()` upon completion/failure.

### Priority 3: Phase 8 — CLI Integration (Developer Experience)
1. **Add `freqtrade` command** to `cli/src/index.ts` using Commander.
2. **Implement subcommands**: `download`, `backtest`, `validate`, `jobs`, `ingest`.
3. **Wire to API**: Each subcommand should call the corresponding `POST/GET /api/freqtrade/*` endpoint using the existing `cli/src/utils/api.ts` helper.

### Priority 4: Phase 6 — Frontend UI (User Experience)
1. **Create `src/components/FreqtradePanel.tsx`**: Three tabs (Data, Backtest, Validate).
2. **Data Tab**: List available pairs/timeframes, form to trigger `POST /api/freqtrade/download-data`.
3. **Backtest Tab**: Form for strategy, timerange, wallet; submit to `POST /4. **Validate Tab**: Side-by-side comparison of in-house vs. Freqtrade metrics.
5. **Add to Navigation**: Include in the main `App.tsx` settings/menu.

### Priority 5: Phase 7 — Deployment (Docker/K8s)
1. **Update `docker-compose.yml`**: Ensure the `backend` service has `FREQTRADE_ENABLED=true` and mounts a named volume for `backend/freqtrade/user_data/data`.
2. **Update `k8s/deployment.yaml`**: Add `FREQTRADE_ENABLED=true` and the PVC mount.
3. **Update `k8s/pvc.yaml`**: Add `freqtrade-data` PVC definition (50 GB, `ReadWriteOnce`).

---

## 4. Next Steps

1. **Acknowledge this plan**.
2. **Begin with Priority 1 (Phase 4 API)**: I will generate the Zod schemas and the 7 new API routes in `backend/api/routes.ts`.
3. **Iterate**: We will proceed through the priorities one by one, verifying each with tests before moving to the next.
