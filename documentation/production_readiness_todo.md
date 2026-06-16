# Production Readiness Todo

Created: 2026-06-10

## Current verified gate state

- `npm run lint`: pass.
- `npm run build`: pass; Vite reports only the existing large-chunk warning.
- `npm test -- --test-reporter=spec --test-concurrency=1`: pass; 397 tests, 396 pass, 0 fail, 1 skipped.
- `npx tsx --test --test-reporter=spec tests/deep-deterministic/deep_deterministic_main.test.ts`: pass; 33 tests, 33 pass, 0 fail, 0 skipped.
- `git diff --check`: pass.
- `npm run quality:coverage`: fail; lines=44.14% (min 50%), branches=73.24% (min 65%).
- `npm run quality:complexity`: fail; `backend/main.ts :: runCycle => 88` and `backend/shadow/shadow_trader.ts :: updatePositions => 51` exceed max 50.
- `npm run security:audit`: fail; `npm audit --omit=dev --audit-level=high` reports 28 vulnerabilities: 4 critical, 21 high, 3 moderate.
- `npm run test:coverage`: not rerun in this shell because `npm` is unavailable (`/bin/bash: npm: command not found`).

## Phase 1 coverage-test expansion (June 15, 2026)

Added focused Node test coverage for the lowest-coverage backend areas identified in the production-readiness plan:

- Monte Carlo:
  - `tests/monte-carlo/monte-carlo-engine.test.ts`
  - Covers path generation, VaR/CVaR, covariance/stress correlations, lightweight simulation, stress scenario math, and Monte Carlo API health/validation routes.
- Paper trading:
  - `tests/paper-trading/paper-trading-components.test.ts`
  - Covers state machine lifecycle, position PnL/liquidation, order book matching, and WebSocket initial data/subscription/error handling.
- ML advisory path:
  - `tests/ml/ml-entry-and-ensemble.test.ts`
  - Covers A/B entry filtering, promotion gates, ensemble scoring, fallback ML health, and disabled prediction behavior.
- WFA validation:
  - `tests/validation/wfa-components.test.ts`
  - Covers anchored/rolling/regime-aware partitioning, overfitting diagnostics, statistical validation, and checkpoint save/load/list/stats/delete.
- Exchange utilities:
  - `tests/exchange/exchange-utilities.test.ts`
  - Covers Redis Bloom filter success/failure paths, deduplication reset, and zero-copy buffer behavior.
- Deprecated helper:
  - `tests/_deprecated/stochrsi.test.ts`
  - Covers the legacy StochRSI calculation returning finite values.

Verification caveat:
- `git diff --check` passes.
- A targeted test run reported two assertion mismatches in the newly added Phase 1 tests:
  - `tests/exchange/exchange-utilities.test.ts` exposed that `ZeroCopyBuffer.read()` returned a live subarray view, so `copyWithin()` overwrote the returned bytes before the caller saw them. The implementation now copies the requested slice before shifting remaining bytes.
  - `tests/ml/ml-entry-and-ensemble.test.ts` used the literal signal id `treatment`, which hashes to the control group; switched to a known treatment hash (`signal-100`).
- A BacktestService integration test exposed a trade-shape mismatch: `runBacktestStandalone()` returns `time`, while the integration assertion expects `timestamp`. The service now includes both `time` and `timestamp` on virtual trades.
- `npm run test:coverage` could not be executed in this environment because the Node/npm toolchain is missing. Run `npm run quality:coverage` in a Node-enabled shell to confirm the line/branch coverage gate.

## Phase 2 API controller ownership + Freqtrade runtime hardening (June 15, 2026)

Resolved the unreachable controller gap by making route ownership explicit, then tightened the Freqtrade sidecar runtime path:

- Monte Carlo is retained and mounted at `/api/mc` through `backend/monte-carlo/api/monte-carlo.controller.js`:
  - `POST /api/mc/simulate` — admin-only mutation route.
  - `GET /api/mc/status/:jobId` — trader/admin read route.
  - `POST /api/mc/stress` — admin-only mutation route.
  - `POST /api/mc/validate` — admin-only mutation route with bounded input size.
  - `GET /api/mc/health` — trader/admin health route.
- WFA is retired as an HTTP API because the existing controller was Fastify-style while the app uses Express. The old Fastify-style controller is no longer mounted; `/api/wfa/*` now returns `410 Gone` with guidance to use the tested WFA component modules for offline analysis.
- Freqtrade jobs now require bounded timeranges through shared validation in `backend/freqtrade/validation.ts` with a 365-day maximum.
- Freqtrade validation tolerance is normalized to the `0..1` range and rejected outside that range.
- Freqtrade API credentials fail closed: `backend/freqtrade/bridge.ts` and `backend/freqtrade/start_server.sh` require `FREQTRADE_API_USER`/`FREQTRADE_API_PASS` or nested `FREQTRADE__API_SERVER__USERNAME`/`PASSWORD`.
- `.env.example` no longer documents predictable Freqtrade defaults.
- The Freqtrade UI polls `queued` jobs and fetches completed results from `/api/freqtrade/jobs/:id` instead of relying on bulky inline `result_json`.
- The frontend admin auth path now covers `/freqtrade/` and `/mc/`.
- Added route/component tests for Monte Carlo caps, Freqtrade validation helpers, Freqtrade route validation, paper liquidation, and `ZeroCopyBuffer.readView()`.
- Added route-ownership tests:
  - Monte Carlo auth/mount test in `tests/monte-carlo/monte-carlo-engine.test.ts`.
  - WFA retirement test in `tests/validation/wfa-components.test.ts`.

Verification caveat:
- `git diff --check` passes.
- Targeted tests could not be executed in this shell because the Node/npm toolchain is missing (`node`, `npm`, and `npx` are unavailable).

## Environment variable inventory (June 15, 2026)

Source scan found **68 environment variables** referenced by backend, CLI, frontend, and server code. The largest setup gaps are:

### Missing from `.env.example`
These variables are referenced by source code but not documented in `.env.example`:

- `API_AUTH_TOKEN`
- `ATR_PERCENTILE_BOOTSTRAP_MIN`
- `BOT_URL`
- `FREQTRADE_DEFAULT_PAIRS`
- `FREQTRADE_JWT_SECRET_KEY`
- `FREQTRADE_QUEUE_CONCURRENCY`
- `FREQTRADE_TRADING_MODE`
- `FREQTRADE__API_SERVER__PASSWORD`
- `FREQTRADE__API_SERVER__USERNAME`
- `GEMMA_ENABLED`
- `GEMMA_MIN_CONF_SCORE`
- `GEMMA_TIMEOUT_MS`
- `HOST`
- `LOG_DIR`
- `ML_CONFIDENCE_THRESHOLD`
- `ML_EXIT_CHECKPOINTS`
- `ML_EXIT_CLOSE_ON_GREEN_AT`
- `ML_EXIT_FORCE_CLOSE_AT`
- `ML_MIN_TRAINING_ROWS`
- `ML_MODELS_DIR`
- `ML_PYTHON_BIN`
- `OLLAMA_BASE_URL`
- `OTLP_ENDPOINT`
- `POSTGRES_DB`, `POSTGRES_HOST`, `POSTGRES_MAX_CONNECTIONS`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, `POSTGRES_USER`
- `RATCHET_CALIBRATED`
- `REDIS_HOST`, `REDIS_PASSWORD`, `REDIS_PORT`
- `SLIPPAGE_BASE_FRAC`
- `SLIPPAGE_SKIP_THRESHOLD`
- `TAKER_FEE_RATE`
- `TRADE_LOCK_TTL_MS`
- `USE_POSTGRES`

### Present in `.env.example` but absent from `backend/config/validation.ts`
These are currently not validated by the Zod env schema:

- `BINANCE_API_KEY`, `BINANCE_SECRET_KEY`
- `FREQTRADE_API_PASS`, `FREQTRADE_API_USER`, `FREQTRADE_ENABLED`, `FREQTRADE_LISTEN_PORT`, `FREQTRADE_VALIDATE_TOLERANCE`
- `FREQTRADE__API_SERVER__JWT_SECRET_KEY`, `FREQTRADE__EXCHANGE__KEY`, `FREQTRADE__EXCHANGE__NAME`, `FREQTRADE__EXCHANGE__PASSWORD`, `FREQTRADE__EXCHANGE__SECRET`
- `KRAKEN_API_KEY`, `KRAKEN_PRIVATE_KEY`
- `SESSION_SECRET`

### Present in validation but absent from `.env.example`
These are validated at runtime but not shown in the example env file:

- `ATR_PERCENTILE_LOOKBACK`
- `FIXED_SLIPPAGE_FALLBACK`
- `MAKER_FEE_RATE`
- `ML_ENTRY_FILTER_THRESHOLD`
- `REGIME_STABILITY_GATING`

### Setup notes
- API keys entered in the settings UI are intentionally not persisted through `/api/settings` because `backend/api/routes.ts` blocks `apiKey`, `apiSecret`, `apiPassword`, `apiProviders`, and `exchange` in the settings payload. Configure exchange/market-data credentials in `.env` instead.
- Redis is optional/degraded-safe, but `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASSWORD` should be documented for BullMQ/idempotency/session setup.
- Postgres is wired through `USE_POSTGRES` and `POSTGRES_*` vars, but `.env.example` and validation do not fully document it.
- Freqtrade nested env vars (`FREQTRADE__*`) are now documented together with the bridge's fallback vars (`FREQTRADE_API_USER`, `FREQTRADE_API_PASS`, `FREQTRADE_JWT_SECRET_KEY`).

### Official service setup links
- CoinGecko API docs: https://docs.coingecko.com/reference/introduction
- CoinMarketCap API docs: https://coinmarketcap.com/api/documentation/v1/
- OKX API docs: https://www.okx.com/docs-v5/en/
- Coinbase Advanced Trade docs: https://docs.cdp.coinbase.com/advanced-trade/docs/welcome/
- Ollama API docs: https://github.com/ollama/ollama/blob/main/docs/api.md
- Redis install docs: https://redis.io/docs/latest/operate/oss_and_stack/install/install-redis/
- Freqtrade install: https://www.freqtrade.io/en/stable/installation/
- Freqtrade data download: https://www.freqtrade.io/en/stable/data-download/
- Freqtrade backtesting: https://www.freqtrade.io/en/stable/backtesting/
- Freqtrade REST API: https://www.freqtrade.io/en/stable/rest-api/
- Freqtrade hyperopt: https://www.freqtrade.io/en/stable/hyperopt/
- Alternative.me Fear & Greed API: https://alternative.me/crypto/fear-and-greed-index/#apicharts

## API endpoint inventory (June 15, 2026)

### Mounted Express API routes
- Main API router mounts direct `/api/*` routes in `backend/api/routes.ts`, including health/status, diagnostics, ML, engine lifecycle, settings, market data, risk configs, backtest, balances, positions, slippage, Monte Carlo, WFA deprecation, and Freqtrade endpoints.
- `backend/monte-carlo/api/monte-carlo.controller.ts` is mounted at `/api/mc`:
  - `POST /api/mc/simulate` (admin)
  - `GET /api/mc/status/:jobId` (trader/admin)
  - `POST /api/mc/stress` (admin)
  - `POST /api/mc/validate` (admin)
  - `GET /api/mc/health` (trader/admin)
- `backend/validation/wfa/wfa-deprecated-controller.ts` is mounted at `/api/wfa` and returns `410 Gone` for retired WFA HTTP endpoints.
- `backend/paper-trading/paper-trading.controller.ts` is mounted at `/api/paper`:
  - `POST /api/paper/order`
  - `PUT /api/paper/order/:id/cancel`
  - `GET /api/paper/positions`
  - `GET /api/paper/positions/:id`
  - `GET /api/paper/summary`
  - `GET /api/paper/orderbook/:symbol`

### Unmounted or incomplete controllers
- `backend/monte-carlo/api/monte-carlo-websocket.ts` still exists but is not wired into the WebSocket server. Monte Carlo REST endpoints are mounted; Monte Carlo WebSocket progress streaming remains optional future work.
- `backend/validation/wfa/wfa-controller.ts` remains present for offline/reference use but is no longer mounted as an HTTP API. The Fastify-style controller was retired to avoid exposing stale `/api/wfa/*` behavior.

### Incomplete endpoint behavior
- `POST /api/slippage/backtest` returns simplified mock results rather than exercising the full slippage backtest framework.
- `GET /api/freqtrade/pairs` returns local candles-table pairs/timeframes as a proxy instead of Freqtrade `list-data` output.
- `POST /api/freqtrade/ingest` spawns the Python ingest script synchronously and does not create a cancellable queued job with progress reporting.
- `POST /api/risk-configs/ai-recommend` parses LLM JSON without the strict Zod validation/retry guardrails documented for AI outputs.
- Settings API blocks API-key persistence, so provider keys shown in the UI must be configured via environment variables.

## New step todo list (June 15, 2026)

### Task 1 — Normalize environment configuration
Goal: make `.env.example`, `backend/config/validation.ts`, and source usage agree, so local/dev/prod setup is reproducible.

1. **Sub-task: Reconcile missing and unused env vars**
   - Instructions: Use the inventory above as the source of truth. Add missing source-used vars to `.env.example`, add missing runtime vars to `backend/config/validation.ts`, and remove stale example vars that no longer have runtime behavior.
   - Recommendations: Group vars by category: auth, database, Redis/BullMQ, exchange, market data, Freqtrade, AI/ML, slippage, observability, and runtime host settings.
   - Definition of done: Every source-used env var is either documented or intentionally deprecated; every validation schema var is documented or explicitly removed.

2. **Sub-task: Add validation defaults and safe fallbacks**
   - Instructions: Review each new schema field and decide whether it should be required, optional, or defaulted. Avoid making local development fail because an optional provider is absent.
   - Recommendations: Use optional Zod fields for provider-specific credentials and strict required fields for process-critical settings such as auth tokens when production auth is enabled.
   - Definition of done: `npm run lint` and a small config-validation test pass for both minimal local config and production-like config.

3. **Sub-task: Document provider credential policy**
   - Instructions: Update setup docs to state that API keys are not persisted through `/api/settings` and must be configured in `.env`.
   - Recommendations: Add a short warning near settings docs and Freqtrade docs, because the UI exposes provider credential fields that are not saved by the backend.
   - Definition of done: Users can configure CoinGecko, CoinMarketCap, OKX, Coinbase, Redis, Postgres, Ollama/Gemma, and Freqtrade from one env reference.

### Task 2 — Decide and implement API controller ownership (completed June 15, 2026)
Goal: remove unreachable `/api/mc/*` and `/api/wfa/*` behavior by either mounting, rewriting, or retiring controllers.

Decision recorded:
- Keep Monte Carlo REST API at `/api/mc` because the existing controller is Express-compatible and already has engine/controller tests.
- Retire WFA as an HTTP API because the existing controller is Fastify-style and no active REST client depends on it. Keep the component modules for offline validation and return `410 Gone` from `/api/wfa/*`.

1. **Sub-task: Choose route ownership**
   - Status: done.
   - Evidence: route decision recorded above and in `documentation/current_state_and_recommendations.md`.

2. **Sub-task: Mount or rewrite Monte Carlo routes**
   - Status: done.
   - Evidence: `backend/api/routes.ts` mounts `backend/monte-carlo/api/monte-carlo.controller.ts` at `/api/mc`, protects mutation routes with admin auth, read routes with trader/auth, and route tests assert mounted behavior.

3. **Sub-task: Mount or rewrite WFA routes**
   - Status: done.
   - Evidence: `backend/validation/wfa/wfa-deprecated-controller.ts` is mounted at `/api/wfa` and returns `410 Gone`; route tests assert stale WFA endpoints no longer behave as active endpoints.

4. **Sub-task: Wire Monte Carlo WebSocket if retained**
   - Status: deferred.
   - Reason: Monte Carlo REST jobs complete synchronously in the current engine, so WebSocket progress streaming is not required for Phase 2. `backend/monte-carlo/api/monte-carlo-websocket.ts` remains unmounted future work.

### Task 3 — Complete incomplete endpoint behavior
Goal: replace mock/proxy/synchronous behavior with production-grade behavior or clearly label experimental endpoints.

1. **Sub-task: Replace slippage backtest mock**
   - Instructions: Implement `POST /api/slippage/backtest` using the slippage engine, cost estimator, liquidity analyzer, or a documented bounded backtest path.
   - Recommendations: If full slippage backtest is too large, return `202 Accepted` with a queued job instead of fake results.
   - Definition of done: Response shape is validated, tests assert non-mock behavior, and docs mark the endpoint as experimental if still incomplete.

2. **Sub-task: Replace Freqtrade pairs proxy**
   - Instructions: Change `GET /api/freqtrade/pairs` to call Freqtrade `list-data` or clearly document that it returns local candle inventory.
   - Recommendations: Keep the local fallback for Redis/Freqtrade downtime, but label the source in the response.
   - Definition of done: Response includes `source`, `pairs`, `timeframes`, and `updatedAt`; tests cover Freqtrade success and fallback.

3. **Sub-task: Queue Freqtrade ingest**
   - Instructions: Replace synchronous `POST /api/freqtrade/ingest` subprocess execution with a BullMQ job that exposes progress, cancellation, and result status.
   - Recommendations: Reuse the existing Freqtrade job model and cancellation pattern from download/backtest/validate.
   - Definition of done: Ingest job appears in `GET /api/freqtrade/jobs`, can be cancelled, and updates DB status.

4. **Sub-task: Harden AI risk-config recommendation**
   - Instructions: Add strict Zod schema validation, retry handling, neutral fallback, and output bounds for `POST /api/risk-configs/ai-recommend`.
   - Recommendations: Keep LLM output advisory only; risk limits and circuit-breaker decisions must remain deterministic backend policy.
   - Definition of done: Bad/missing AI output cannot crash the route and returns a safe fallback response.

### Task 4 — Close quality gates
Goal: make the repository pass the existing production quality gates without manual exceptions.

1. **Sub-task: Raise coverage to threshold**
   - Instructions: Add focused tests for low-coverage areas identified in the current gate report, especially database worker, Monte Carlo modules, WFA modules, paper-trading WebSocket handler, exchange connector, ML bridge/retrain paths, and legacy/deprecated files.
   - Recommendations: Prefer tests around behavior and regression cases over generic stubs.
   - Definition of done: `npm run quality:coverage` passes with at least 50% lines and 65% branches.

2. **Sub-task: Reduce high complexity**
   - Instructions: Refactor `backend/main.ts :: runCycle` and `backend/shadow/shadow_trader.ts :: updatePositions` into smaller helpers.
   - Recommendations: Extract exchange/candle validation, signal generation, trade execution, state updates, and position-specific update logic into named functions.
   - Definition of done: `npm run quality:complexity` passes with all reported functions below 50.

3. **Sub-task: Resolve production audit vulnerabilities**
   - Instructions: Address `npm audit --omit=dev --audit-level=high` findings by upgrading, replacing, or removing vulnerable production dependencies.
   - Recommendations: Prioritize critical/high findings first. Do not suppress audit findings unless a documented exception is attached.
   - Definition of done: `npm run security:audit` passes.

4. **Sub-task: Run CI parity**
   - Instructions: After coverage, complexity, and audit pass, run `npm run quality:ci`.
   - Recommendations: If CI fails, capture exact workflow/job/logs and open a focused follow-up task.
   - Definition of done: `npm run quality:ci` passes locally.

### Task 5 — Verify runtime and lifecycle behavior
Goal: confirm the app starts, stops, and degrades safely under realistic local configuration.

1. **Sub-task: Add local production smoke test**
   - Instructions: Start the server on `PORT=3000` with production-like config and verify public probes: `/api/health/live`, `/api/health/quick`, and `/api/status`.
   - Recommendations: Keep Redis optional for degraded-safe startup, but verify Redis-online and Redis-offline paths separately.
   - Definition of done: Smoke test script or documented manual procedure passes.

2. **Sub-task: Add lifecycle leak test**
   - Instructions: Add an automated test that starts/stops the engine and asserts no open scheduler timers, queues, or process listeners remain.
   - Recommendations: Build on the existing deep-deterministic lifecycle tests.
   - Definition of done: Repeated start/stop cycles do not leave timers, queues, or signal handlers.

3. **Sub-task: Verify external-service setup paths**
   - Instructions: Validate setup docs for CoinGecko, CoinMarketCap, OKX, Coinbase, Ollama/Gemma, Redis, and Freqtrade using the official links already listed.
   - Recommendations: Keep secrets out of docs and examples; use placeholder tokens only.
   - Definition of done: A clean local environment can follow the docs without guessing required vars.

### Task 6 — Documentation and release hygiene
Goal: keep active docs aligned with the current codebase and avoid committing generated artifacts.

1. **Sub-task: Update active docs after each implementation phase**
   - Instructions: After completing Tasks 1–5, update `AGENTS.md`, `documentation/current_state_and_recommendations.md`, and relevant upgrade docs.
   - Recommendations: Move completed work into the recently completed section and keep only actionable gaps in the todo section.
   - Definition of done: Active docs accurately describe current gate state and known gaps.

2. **Sub-task: Archive stale reports**
   - Instructions: Label historical QA/playwright reports as historical or superseded.
   - Recommendations: Do not delete history, but prevent stale pass claims from being read as current state.
   - Definition of done: No active doc claims an unverified historical pass count as current.

3. **Sub-task: Clean generated artifacts**
   - Instructions: Confirm `.gitignore` keeps `coverage/`, SQLite WAL/SHM files, logs, backups, and Freqtrade runtime artifacts out of the repository.
   - Recommendations: Run `git status --short` before finalizing any release branch.
   - Definition of done: No generated artifacts are committed.
