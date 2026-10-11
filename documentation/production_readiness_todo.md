# Production Readiness Todo

Created: 2026-06-10 | Updated: 2026-10-11

## Current verified gate state (October 11 readiness phases)

- Access-control phase: paper REST and `/symbol` require trader role; invalid API tokens no longer bypass CSRF; paper WebSocket consumers are activated only after authentication; null pre-auth WebSocket JSON is rejected without throwing; Vite source-deny blocks `/@fs/`, encoded protected paths, traversal and SQLite files.
- Focused access-control tests: **17/17 pass**.
- Focused trade-safety, stop, pair-price and existing deterministic regression suites: **87/87 pass**.
- Exchange reconciliation phase: the fail-closed foundation is merged, but is **not a live-trading release gate**. Native-fixture coverage verifies Kraken cursor pagination, Coinbase fill IDs and incomplete order/fill page rejection, OKX three-month order history, and Binance order/fill cursor pagination across the app's supported Spot symbols (BTC/USDT, ETH/USDT, SOL/USDT). Base- and quote-currency fees/rebates now settle using the fill price and inventory quantity; third-asset fees remain unvalued and block readiness. Binance activity outside the app allowlist and sandbox validation remain outstanding. Live execution capabilities remain disabled. No live or testnet exchange credentials or orders were used.
- Balance mutation and audit transactionality: **complete**. SQLite and PostgreSQL transaction adapters are covered for commit/rollback, serialization/client pinning and failure cleanup; balance snapshots, conditional update and audit insert now share one transaction. Focused database/balance/shadow tests pass. PostgreSQL verification uses a mocked pool client; no live PostgreSQL server was available for integration testing.
- Paper-accounting phase: **52/52 relevant tests pass, 1 skipped**; positions use the order ID and actual fill quantity/price, pending orders do not create positions, P&L uses full notional movement, profitable positions are not liquidated, and closes/liquidations preserve realized P&L and exit reason.
- Root lint and production frontend build: **pass**; complexity gate: **pass** (max 50).
- Full serial Node 22 test suite on the merged `main` tree: **586 tests / 585 passed / 0 failed / 1 skipped**.
- Production dependency audit (`npm audit --omit=dev`): **pass**, 0 vulnerabilities after the October 11 dependency remediation. The full dependency graph still reports 14 development-dependency advisories (0 critical, 5 high, 5 moderate, 4 low); those are outside this production-only remediation and remain to be triaged.
- Dependency advisory snapshots are archived in [production](audits/2026-10-11/npm-audit-production.json) and [full graph](audits/2026-10-11/npm-audit-full.json) reports.
- Full legacy readiness audit below remains active: unknown-symbol Binance recovery, exchange testnet/sandbox validation, deployment validation, and development-dependency remediation remain outstanding. These phases do not authorize live funds or untrusted network exposure.

## Baseline verified gate state (October 10 audit)

- Root lint/build/complexity: **pass** on October 10.
- Serial isolated Node 22 tests: **pass**, 518 tests / 517 passed / 0 failed or cancelled / 1 skipped. Whole skipped suites remain; do not infer complete coverage from that counter.
- Coverage checker: **pass**, lines 56.97%, branches 74.68% (thresholds 50% / 65%).
- Additional root ML tests: **28/28 pass**; omitted by normal shell glob.
- Isolated production Chromium checks: **2/2 pass**, mocked API/WebSocket.
- CLI-specific TypeScript project: **fail**, TS6059 rootDir/import boundary.
- Production dependency audit: **fail**, 12 affected packages (1 critical, 2 high, 9 moderate), with exposure qualified in the report.
- Existing service on port 3000: no listener verified. Native SQLite installed for Node 22 fails under default Node 24.

## Current release blockers and next actions

**Not ready for live funds or untrusted network exposure.** The [October 10 full audit](full_system_audit_2026-10-10.md) supersedes the historical gate/readiness assessments below. The October 11 access-control, paper-accounting, and transactional balance audit phases are complete. Close, pair-price, stop/kill, balance concurrency and audit rollback fixes have focused verification; real reconciliation remains blocked on authoritative venue pagination, native payload coverage, complete order/fill consistency checks, and exchange sandbox validation.

- [x] Secure paper REST and symbol mutations with trader role checks; require valid API tokens for CSRF bypass; reject malformed pre-auth WS JSON safely; delay paper WS initialization until auth; deny Vite filesystem aliases and local database files. Focused tests pass 17/17; full production readiness checks remain pending.
- [x] Prevent duplicate live closes with a per-trade lock and durable close intent; leave uncertain closes blocked for reconciliation. Price existing positions and kill-switch exits by each trade's own symbol. Stop waits for the active cycle and cancels entries that have not reached exchange submission. Focused trade-safety regressions pass 87/87.
- [ ] Complete account-scoped order/fill reconciliation for Binance Spot, Kraken Spot, OKX Spot, and Coinbase Advanced Trade. Supported-pair Binance Spot history now sweeps BTC/USDT, ETH/USDT, and SOL/USDT; arbitrary and externally placed Binance symbols, third-asset fee valuation, and sandbox validation remain required before enabling live execution. Ambiguous, unmatched, external, and missing-intent cases must continue to block readiness until resolved with an audit reason.
- [x] Keep the legacy position-only adapter fail-closed; authoritative recovery now uses the account execution adapter rather than treating a missing position implementation as an empty account. Verification: reconciliation tests pass.
- [x] Prevent concurrent balance reservations, releases, allocations and P&L results from overwriting each other with conditional arithmetic updates; await settlement on live and simulated closure. Focused balance tests pass 3/3.
- [x] Repair paper position identity and fill propagation; defer position creation until fill; correct notional P&L, liquidation eligibility and realized exit accounting. Regression and compatibility suites pass (52 pass, 1 skipped).
- [x] Make the balance update and audit record transactional for SQLite and PostgreSQL transaction adapters. Full-suite paper component assertions now reflect full-notional PnL.
- [ ] Activate risk configs atomically, remove LLM risk authority, and repair ML/schema/Freqtrade integration and independent OOS evaluation.
- [ ] Repair Docker runtime imports/Kubernetes volumes, enforce a single engine owner, and verify database-specific backup restoration.
- [x] Upgrade vulnerable production dependencies; `npm audit --omit=dev` reports zero advisories. The full graph still has 14 development-dependency advisories.
- [ ] Repair CLI/test discovery and triage remaining development dependency advisories; prove the audit regression scenarios before a sandbox-exchange release gate.

The remaining sections retain dated implementation history and earlier inventories; they are not current verification claims.

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

> **Update (June 17, 2026)**: `.env.example` was expanded to 87 vars with service-specific env var names (e.g., `BINANCE_API_KEY`, `COINGECKO_API_KEY`). Most "Missing from `.env.example`" items below are now documented. The lists below remain as a cross-reference audit trail.

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
   - Status: **complete October 11, 2026**. Updated OpenTelemetry auto-instrumentations, SDK and OTLP exporter to the 0.223 release line and applied available non-breaking production transitive fixes. Production audit reports 0 vulnerabilities. Full graph still reports development-only advisories (4 low, 5 moderate, 5 high), which require separate review.
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
