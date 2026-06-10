# Current State & Recommendations (2026-06-10)

## Executive Summary

- **Overall health:** Functional core trading platform with substantial implementation coverage, but the repository is **not full-CI-green** because the coverage gate still fails while build, lint, and tests pass.
- **Primary strengths:** Multi-mode shadow trading, lifecycle-hardened trading engine, role-protected API, Freqtrade sidecar integration, React dashboard, backtest/slippage/ML scaffolding, and targeted deterministic lifecycle tests.
- **Primary risks:** Coverage/complexity/audit gates remain unverified, historical QA reports are stale, and several planning documents still describe work that has already been implemented.

## Verified Current State

### Commands run in this audit

- `npm run build`: **passes**. Vite builds successfully with only a large-chunk warning.
- `npm run lint`: **passes**.
- `npm test` (TAP): **passes** in serial spec mode with `# tests 397`, `# suites 148`, `# pass 396`, `# fail 0`, `# skipped 1`.
- `npm test -- --test-reporter=spec --test-concurrency=1 --test-timeout=120000`: **passes** in serial spec mode.
- `npx tsx --test tests/deep-deterministic/deep_deterministic_main.test.ts`: **passes** with `# tests 33 / pass 33 / fail 0 / skipped 0`.
- `npm run quality:coverage`: **fails** the coverage gate; current totals are lines=44.14% (min 50%), branches=73.24% (min 65%).

### Implemented feature surface

- **Trading engine lifecycle:** `runCycle()` is overlap-guarded with `cycleInProgress` and `cycleAbortToken`; `stopSchedulers()` aborts stale work, clears intervals/timers, and closes queues; `stop()`, `killBot()`, and `setTimeframe()` are awaited by callers/routes.
- **Shadow trading:** 6 risk modes (`ultra_conservative`, `conservative`, `moderate`, `aggressive`, `degen`, `ai_enhanced`) with circuit breakers, runner/early-exit logic, liquidation handling, slippage-aware fills, and performance aggregation.
- **Regime/signal pipeline:** v2 regime detection, WaveTrend/MFI/VPI/RR-RSI indicators, divergence guard, live confidence, and non-blocking Ollama Gemma signal confirmation with fallback.
- **Risk management:** consecutive-loss circuit breaker, degen dollar cap/quarantine, live-mode guard, configurable risk configs.
- **API:** Express REST API with admin/trader/public route separation, request validation, correlation IDs, diagnostics, market data, positions, balances, backtest, slippage, ML, and Freqtrade endpoints.
- **Frontend:** React dashboard with charts, risk-mode controls, settings, Freqtrade panel, ML dashboard, and polling/cache behavior.
- **Freqtrade integration:** Python venv sidecar, bridge, data/backtest/validate workers, migrations, REST API, CLI commands, and React panel are implemented.
- **ML/research scaffolding:** ML model health/status endpoints, trained-model inventory UI, entry-predictor scaffold, Bayesian analytics, and isolated HMM research module.
- **Infrastructure:** SQLite/Postgres migration path, Redis optional/degraded-safe, BullMQ workers, Docker/Kubernetes manifests, structured logging, Prometheus metrics, and OpenTelemetry instrumentation.

### Current blockers

- `npm run lint` passes.
- Full test execution is verified green in serial spec mode. The previous hang was isolated to a test that left a BullMQ queue open; closing queues at file teardown fixes it.
- `npm run quality:coverage` still fails because line coverage is below threshold: 44.14% lines vs 50% minimum and 73.24% branches vs 65% minimum.

## Recommended Next Steps

1. **Fix remaining local CI parity work.** Prioritize coverage, complexity, and audit gates after the build/lint/test gates now pass.
2. **Archive stale reports.** Keep historical reports, but label them as historical and remove claims that they represent current state.
3. **Refresh active docs.** `AGENTS.md`, `CLAUDE.md`, `README.md`, and this file should remain the current-state source of truth; planning docs should be marked archived or superseded.
4. **Add production smoke test.** Start server on `PORT=3000`, hit public probes (`/api/health/live`, `/api/health/quick`, `/api/status`), and verify no background timers leak on stop.
