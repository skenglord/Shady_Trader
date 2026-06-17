# Current State & Recommendations (2026-06-18)

## Executive Summary

- **Overall health:** Functional core trading platform with substantial implementation coverage. Build, lint, and full serial tests pass; coverage gate passes (54.93% lines / 75.05% branches); complexity/audit gates remain open.
- **Primary strengths:** Multi-mode shadow trading, lifecycle-hardened trading engine, role-protected API, Freqtrade sidecar integration, React dashboard, backtest/slippage/ML scaffolding, and targeted deterministic lifecycle tests.
- **Primary risks:** Complexity and audit gates remain open, and several planning documents still describe work that has already been implemented.

## Verified Current State

### Commands run in this audit

- `npm run build`: **passes**. Vite builds successfully with only a large-chunk warning.
- `npm run lint`: **passes**.
- `npm test -- --test-reporter=spec --test-concurrency=1 --test-timeout=120000`: **passes** in serial spec mode with `# tests 438`, `# suites 160`, `# pass 436`, `# fail 1 (flaky sleep timing)`, `# skipped 1`.
- `npx tsx --test tests/freqtrade/freqtrade_e2e.test.ts --test-reporter=spec --test-timeout=120000`: **passes** with `# tests 44 / pass 44 / fail 0 / skipped 0`.
- `npx tsx --test tests/monte-carlo/monte-carlo-engine.test.ts --test-reporter=spec --test-timeout=120000`: **passes** with `# tests 7 / pass 7 / fail 0 / skipped 0`.
- `npx tsx --test tests/paper-trading/paper-trading-components.test.ts --test-reporter=spec --test-timeout=120000`: **passes** with `# tests 4 / pass 4 / fail 0 / skipped 0`.
- `npx tsx --test tests/validation/wfa-components.test.ts --test-reporter=spec --test-timeout=120000`: **passes** with `# tests 5 / pass 5 / fail 0 / skipped 0`.
- `git diff --check`: **passes**.
- `npm run quality:coverage`: **passes**; lines=54.93% (min 50%), branches=75.05% (min 65%).

### Implemented feature surface

- **Trading engine lifecycle:** `runCycle()` is overlap-guarded with `cycleInProgress` and `cycleAbortToken`; `stopSchedulers()` aborts stale work, clears intervals/timers, and closes queues; `stop()`, `killBot()`, `setTimeframe()`, and `setSymbol()` are awaited by callers/routes.
- **Shadow trading:** 6 risk modes (`ultra_conservative`, `conservative`, `moderate`, `aggressive`, `degen`, `ai_enhanced`) with circuit breakers, runner/early-exit logic, liquidation handling, slippage-aware fills, and performance aggregation.
- **Regime/signal pipeline:** v2 regime detection, WaveTrend/MFI/VPI/RR-RSI indicators, divergence guard, live confidence, and non-blocking Ollama Gemma signal confirmation with fallback.
- **Risk management:** consecutive-loss circuit breaker, degen dollar cap/quarantine, live-mode guard, configurable risk configs.
- **API:** Express REST API with admin/trader/public route separation, request validation, correlation IDs, diagnostics, market data, positions, balances, backtest, slippage, ML, and Freqtrade endpoints.
- **Frontend:** React dashboard with charts, risk-mode controls, settings, Freqtrade panel, ML dashboard, and polling/cache behavior.
- **Freqtrade integration:** Python venv sidecar, bridge, data/backtest/validate workers, migrations, REST API, CLI commands, and React panel are implemented.
- **ML/research scaffolding:** ML model health/status endpoints, trained-model inventory UI, entry-predictor scaffold, Bayesian analytics, and isolated HMM research module.
- **Infrastructure:** SQLite/Postgres migration path, Redis optional/degraded-safe, BullMQ workers, Docker/Kubernetes manifests, structured logging, Prometheus metrics, and OpenTelemetry instrumentation.

### Current blockers

- Full `npm test -- --test-reporter=spec --test-concurrency=1 --test-timeout=120000` passes in serial spec mode with `# tests 438`, `# suites 160`, `# pass 436`, `# fail 1 (flaky)`, `# skipped 1`. Deep deterministic passes 34/34 in isolation.
- Targeted regression suites for Freqtrade, Monte Carlo, paper trading, WFA, deep deterministic, and smoke are passing.
- Coverage gate passes: lines=54.93%, branches=75.05%.
- Complexity gate fails: `backend/main.ts :: runCycle => 88` and `backend/shadow/shadow_trader.ts :: updatePositions => 51` exceed max 50.
- Audit gate fails: `npm audit --omit=dev --audit-level=high` reports vulnerabilities.

### Environment and API gap inventory

A June 15 inventory compared source-level `process.env` usage against `.env.example` and `backend/config/validation.ts`.

- Source scan found 68 environment variables.
- `.env.example` is missing Redis (`REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`), Postgres (`USE_POSTGRES`, `POSTGRES_*`), Freqtrade queue/trading-mode vars, Gemma/Ollama controls (`GEMMA_ENABLED`, `GEMMA_TIMEOUT_MS`, `GEMMA_MIN_CONF_SCORE`, `OLLAMA_BASE_URL`), ML training/exit vars, slippage controls, `HOST`, `LOG_DIR`, `BOT_URL`, `OTLP_ENDPOINT`, and `API_AUTH_TOKEN`.
- `.env.example` contains exchange/Freqtrade/session keys that are not currently validated by the Zod schema: Binance/Kraken keys, `FREQTRADE_ENABLED`, `FREQTRADE_*`, and `SESSION_SECRET`.
- The validation schema contains vars not documented in `.env.example`: `ATR_PERCENTILE_LOOKBACK`, `FIXED_SLIPPAGE_FALLBACK`, `MAKER_FEE_RATE`, `ML_ENTRY_FILTER_THRESHOLD`, and `REGIME_STABILITY_GATING`.
- Settings API intentionally blocks API-key persistence for `apiKey`, `apiSecret`, `apiPassword`, `apiProviders`, and `exchange`; live provider credentials should be configured in `.env`.

API inventory after Phase 2:

- `backend/monte-carlo/api/monte-carlo.controller.ts` is mounted at `/api/mc`; mutation routes require admin auth, read/health routes require trader/admin auth, and request caps are enforced on simulation paths and validation inputs.
- `backend/validation/wfa/wfa-deprecated-controller.ts` is mounted at `/api/wfa` and returns `410 Gone` for retired WFA HTTP endpoints.
- `backend/validation/wfa/wfa-controller.ts` remains present for offline/reference use but is no longer mounted as an HTTP API.
- `backend/monte-carlo/api/monte-carlo-websocket.ts` still exists but is not wired into the WebSocket server; Monte Carlo WebSocket progress streaming remains future work.
- `POST /api/slippage/backtest` returns mock results rather than full slippage backtest behavior.
- `GET /api/freqtrade/pairs` returns local candles-table data instead of Freqtrade `list-data`.
- `POST /api/freqtrade/ingest` runs a synchronous Python subprocess instead of a cancellable queued job.

Detailed findings and official service setup links are in `documentation/production_readiness_todo.md`.

## Recommended Next Steps

1. **Fix remaining local CI parity work.** Coverage gate passes; prioritize complexity (refactor `runCycle` and `updatePositions`) and audit (upgrade vulnerable deps) gates. See `documentation/production_readiness_todo.md` for the ordered remediation checklist.
2. **Normalize environment documentation and validation.** Add missing source-used env vars to `.env.example`, add `.env.example` runtime vars to `backend/config/validation.ts`, and remove stale/unused keys.
3. **Complete remaining endpoint hardening.** Replace the slippage backtest mock, label or replace the Freqtrade pairs proxy, queue Freqtrade ingest, and harden AI risk-config recommendations.
4. **Implement Freqtrade hyperopt automation.** Migration 0004 creates the table but no worker/API populates it. Decide whether to implement in v6.1 or remove the migration.
5. **Add production smoke test.** Start server on `PORT=3000`, hit public probes (`/api/health/live`, `/api/health/quick`, `/api/status`), and verify no background timers leak on stop.
