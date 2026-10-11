# Shady Trader research/database audit (2026-10-10)

Read-only source inspection and isolated Node/Python reproductions; no production database opened or mutated, no repository edits. Node 22.23.3 was used for native SQLite reproduction. The default Node 24.21.0 fails loading installed better-sqlite3 (ABI127 vs ABI137); parent is auditing broader runtime/tests. Historical Hermes documents were not treated as current evidence.

## Prioritized findings

### P1: A failed optimiser changes active risk configuration

- `backend/strategy/optimization_engine.ts:91` shallow-copies the outer configuration map. At line 101 it mutates the same inner objects held by `RiskManager.RISK_CONFIGS`, before all modes succeed, before `saveConfigs`, and before nominal validation.
- Reproduced with injected manager `{moderate:{leverage:1},aggressive:{leverage:2}}` and query function returning a scored moderate trial `{leverage:10}` then no aggressive trials: logs “Bayesian optimization failed,” never calls `saveConfigs`, but moderate leverage becomes **8.2**.
- Impact: scheduled optimisation may change active sizing/leverage despite reporting failure; modifications are unpersisted and partial. Also any numerical key can be applied without bounds. `validateWithMonteCarlo` at lines 129-131 merely logs an instruction; it is not a validation gate.
- Fix: build an independent candidate, validate schema/risk bounds and real validation results, persist and activate atomically only after every required mode succeeds. Propagate failure rather than report job success.
- Scope: live/shadow optimisation when scored trials exist. On fresh SQLite another issue prevents this path (see schema parity below).

### P1: Optional LLM controls risk mode and blocks position processing

- `backend/main.ts:1071` awaits `applyAiStrategySwitch`; lines 1089-1095 explicitly ask an LLM to select risk mode; line 1097 awaits completion; lines 1112-1114 assign/persist the returned mode. A valid `degen` string suffices. Existing-open-live-position guard prevents mode changes for existing live trades, but does not remove LLM authority for future trades or shadow trades.
- `runCycle` at lines 1393-1409 performs narrative/AI switching before `runShadowAndLiveStage` (position updates). `backend/regime/detector.ts:131-169` also synchronously awaits a narrative call and sends technical metrics; it parses JSON without Zod. Model/client timeout is not locally bounded.
- These violate explicit project policy `AGENTS.md:425-432` (no synchronous LLM execution gates, risk-management decisions, indicator analysis; cache-based background processing and typed validation required).
- `backend/api/routes.ts:1192-1216` still asks the LLM for maxRiskPerTrade/maxDrawdown/leverage and returns arbitrary merged JSON. This route **does not persist** changes now; distinguish advisory output from active mode switching.
- Fix: remove LLM risk authority; use deterministic bounded risk controls and background cached narrative/sentiment with typed schema.
- Scope: AI settings enabled; default false, so not an always-on failure.

### P1: Bridge cannot consume the installed Freqtrade backtest export

- `backend/freqtrade/bridge.ts:465-467,516-533` expects an exact temporary `.json` and otherwise scans latest `backtest-result-*.json` in `user_data/backtest_results` (lines 822-845). `BacktestResultSchema` at line 91 requires `strategy` to be a string, with metrics at top level.
- Installed primary implementation `backend/freqtrade/venv/lib/python3.12/site-packages/freqtrade/optimize/optimize_reports/bt_storage.py:68-89` creates a timestamped **ZIP** and puts JSON inside it, where `strategy` is a map from strategy name to result. This is local installed-version evidence, not remembered documentation.
- Reproduced `withMetadata({strategy:{ShadyTraderReferenceStrategy:{total_trades:1,sharpe:1}},strategy_comparison:[]},meta)` → Zod `Expected string, received object`.
- Impact: real successful backtest/validation commands fail ingestion, or the fallback consumes an unrelated old JSON. Current mock-shaped schemas/tests do not establish runtime compatibility.
- Fix: locate exact run export/archive, read the contained results, select requested strategy, normalize actual fields (including `max_drawdown_account`), validate the normalized result; never select unrelated latest files.

### P2: ML SELECT calls use write-query mode, so active models are ignored

- `backend/ml/predictor.ts:20-27`, `backend/ml/index.ts:31-34`, `backend/ml/retrain_job.ts:25-31`, `scripts/train_models.ts:63-69`, and reconciliation SELECTs omit the `'all'` argument. `backend/database.ts:296-303,350` defaults to `'run'`, returning `{changes,lastInsertRowid}` rather than rows; PG does the same (`database_postgres.ts:611-624`).
- Reproduced using real in-memory better-sqlite3 and exactly the production `.all`/`.run` dispatch, with one active model: actual count is 1, `getPrediction` returns fallback/no model and `getMLHealth` returns `modelsReady:false, modelCount:0`. No Python needed to reproduce.
- Trainer serializes write metadata as candles rather than a candle array; reconciliation attempts to iterate non-rows.
- Fix: explicit row retrieval for SELECTs and an API/type that makes incorrect selection modes difficult. Verify registry → inference on real driver.
- Scope: enabled experimental ML and training/health tooling.

### P2: ML Python paths fail in the repository's ESM runtime

- `backend/ml/python_bridge.ts:35` and `backend/ml/retrain_job.ts:41` reference `__dirname`, despite package `type:module` and tsx ESM usage.
- Direct isolated `await extractFeatures([])` under normal `node --import tsx --input-type=module` reproducibly returns **ReferenceError: __dirname is not defined**, before Python spawns.
- Fix: derive filesystem path with `fileURLToPath(import.meta.url)` / new URL. Handle spawn errors as well.
- Scope: ML inference/retraining after registry lookup is fixed; masked today by the preceding row-mode bug.

### P2: Fresh PostgreSQL has incompatible ML schema; SQLite optimisation schema is missing

- PostgreSQL base initializer has no ML tables; migration `backend/migrations/0001_regime_v2_and_ml_schema.ts:52-78` creates registry columns `model_type`, `onnx_path`, and prediction fields `pred_score`, `actual_outcome`.
- SQLite initializer `backend/database.ts:173-203` instead creates `model_path`, precision/recall/drift fields, and prediction direction/probability fields. Runtime `predictor.ts:21,101-112`, `retrain_job.ts:87-100`, API `routes.ts:717-720,736-746` require the latter.
- Running migration 0001 against isolated in-memory DB reproduces `SELECT model_path FROM ml_models` → `no such column: model_path`; schema inspection confirms ONNX shape. PostgreSQL follows this migration path, so `/ml/status` also queries nonexistent drift columns even with ML disabled.
- `optimization_trials` is created only in PostgreSQL initializer (`database_postgres.ts:463`), absent from SQLite initializer and migrations; default fresh SQLite optimiser query always fails `no such table`.
- Fix: unify canonical schema in portable migrations, migrate existing registries explicitly, and test fresh SQLite and PostgreSQL initialization with actual runtime queries.
- Additional PG parity: migration regimes_v2 timestamp translates DATETIME→TIMESTAMP, but main.ts:1034 supplies Date.now() milliseconds; ingest endpoint routes.ts:1971-1974 always writes SQLite regardless of USE_POSTGRES. Source-level findings, not exercised against a live PG server.

### P2: Freqtrade cancellation does not address the worker's child process

- API chooses external job UUID (`routes.ts:1747-1753`, equivalent other job routes); worker strips it (`workers/backtestWorker.ts:25`) then bridge creates a different UUID (`bridge.ts:459`, download at 425). `activeJobs` is keyed by bridge UUID (`bridge.ts:817`). Cancellation uses API UUID (`routes.ts:1930`) so `bridge.cancel` at line 551 finds nothing.
- API ignores the false return and reports/persists cancelled (`routes.ts:1941-1947`). Active BullMQ jobs cannot ordinarily be removed while locked (caught/nonfatal here). Local jobs have no pending-queue cancellation and workers unconditionally set running/completed, overwriting cancelled status.
- Fix: pass external ID through bridge; remove pending local items; conditional state transitions and cancellation token; await actual child exit before success.
- Scope: download/backtest/validation CPU/disk jobs, not exchange orders.

### P2: Walk-forward optimiser uses OOS data to choose parameters

- `backend/validation/wfa/rolling-optimizer.ts:82-87` selects best candidate by fitness; lines 129-138 evaluate OOS for every candidate and use **70% OOS** fitness; line 99 also uses OOS for early stopping. Controller then reports the same OOS (`wfa-controller.ts:241-245`).
- This makes the reported OOS an optimization/validation set, not an untouched forward evaluation; the claimed walk-forward performance is selection-biased.
- Fix: optimize solely on training (possibly inner validation), freeze candidate, evaluate once on untouched next window. Use a final holdout beyond tuning windows.
- Related simulator correctness: sell stop/take levels at lines 194-195 are constructed with long-side formulas. A short entry at 100, 2% SL and TP produces stop 98/take 102; normal next high >=98 records +2% profit instead of a short stop loss (lines 217-224).
- Scope: research WFA tooling; not evidence of current live order execution failure.

### P2: Reported ML holdout metrics evaluate already-fit data

- `backend/ml/model_trainer.py:95` fits calibrated estimator on all X/y, then lines 100-107 report last 20% as “holdout.” Those rows participated in fitted time-series folds/calibrators, so this is not an independent holdout. Retraining deployment threshold uses it (`retrain_job.ts:143-156`).
- Fix: reserve tail before fitting/calibration, fit only earlier rows with embargo, evaluate untouched tail, gate deployment on independent metrics. The separately calculated walk-forward report is not currently the deployment gate.
- Feature-label issue: `feature_engineering.py:76-79` computes unknown final target as false/0 then forward-fills final return. Reproduction on 50 monotonically rising rows returns final target_direction 0 with positive carried-forward target_return. Remove unlabeled rows before filling feature columns.
- Scope: experimental ML training/validation; only operational after integration blockers fixed.

## Experimental limitations versus current operational bugs

- Standalone backtest is a simplified signal TP/SL simulator, not production-equivalent: no capital allocation, fees/funding/slippage, trailing/partial exits; raw per-trade percentage returns are summed. It ignores original signal take-profit at service.ts:145-147 and computes drawdown as absolute cumulative percentage points (lines 255-260), Sharpe from per-trade returns ×sqrt(252) (lines 269-279).
- Cross-validation uses Python's fixed conservative momentum strategy (ShadyTraderReferenceStrategy.py:65,181-216), whereas TS unknown strategy name falls through to regime strategy (signal_generator.ts:182-204). Worker does not pass risk mode to Python and compares one TS symbol against arbitrary FT pairs (validateWorker.ts:163-171), with unlike metric definitions and defaulting missing FT metrics to 0/1 (lines 96-102). Results cannot establish production parity even after archive reader is repaired.
- EntryPredictor explicitly says isolated/advisory-only (entryPredictor.ts:3-8). Gemma adjuster startup, ML prediction logging/reconciliation and retrain worker have no callers outside declarations/exports in current backend. Treat these as unfinished experimental integration, not a live strategy regression.
- `bayesianOptimize` now selects highest stored real score; it is not Bayesian search. Old claims of synthetic trials or LLM hyperparameter tuning do not match current code. No scored trial producers found except optimiser re-saving selected trials. Validation fail-closes when fewer than 100 real candles; historical synthetic fallback is removed.

## Verification scope

Isolated real in-memory SQLite model lookup/health, migration schema check; optimiser injected-dependency reproduction; feature-extractor ESM invocation; Freqtrade actual-shape schema parse; pandas feature-label reproduction. Source evidence for installed Freqtrade ZIP format and remaining integration/validation issues. No full suite, network/exchange tests, real training, or PostgreSQL server mutations performed.
