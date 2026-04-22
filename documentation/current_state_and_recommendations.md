# Current State & Recommendations (2026-04-22)

## Executive Summary
- **Overall health:** Functional core trading pipeline with passing TypeScript checks and passing test suite (`19/19` tests).  
- **Primary strengths:** Core regime/signal/risk/shadow-trade flow is implemented and test-covered; API surface is broad and operationally useful.  
- **Primary risks:** Core auth/validation has been strengthened, but production hardening still needs continued work (deeper schema coverage, comprehensive route tests, and exchange-provider abstraction).

## System Health Appraisal

### What is working well
1. **Core engine flow is cohesive**
   - TradingEngine -> IndicatorEngine -> RegimeDetector -> SignalGenerator -> ShadowTrader path is present and integrated.
2. **Shadow portfolio mechanics are active**
   - Multi-mode portfolio structure, stop/take-profit handling, and performance aggregation are available.
3. **Operational API coverage is strong**
   - The backend exposes lifecycle, settings, balances, positions, backtest, and history endpoints.
4. **Test and typecheck baseline is green**
   - Lint/typecheck and all current test files are passing in this environment.

### Current technical risk areas
1. **Security coverage is improved but not complete**
   - Role tokens and route-level guards are now present, but more negative-path test coverage is needed.
2. **Validation rigor can still be deepened**
   - Mutating route validation is now present, but richer schema constraints and shared types should be added.
3. **Runtime side effects in constructors**
   - Engine/connector constructors start polling immediately, making deterministic test/runtime control harder.
4. **Exchange abstraction is still narrow**
   - Credentials are now env/settings driven, but implementation still centers around CoinMarketCap behavior.

## Feature Inventory

### Implemented features
- Multi-regime detection and signal generation.
- Six-mode shadow portfolio management (risk-mode segmentation).
- Balance manager and trade accounting paths.
- REST API endpoints for control, data, settings, balances, and history.
- WebSocket status/performance broadcasting hooks.
- Strategy optimization engine scaffold and invocation path.
- CSV import endpoint for historical data ingestion.
- Cross-platform launcher script (`npm run bot:launch`) for one-command startup across desktop Linux/macOS/Windows and mobile shell runtimes.

### Partially implemented / constrained features
- **Live exchange trading:** Connector currently behaves as a CMC-driven data/mocked-order layer rather than full exchange order routing.
- **AI integration:** Gemini hooks exist, but reliability and fallback behavior need hardening for production.
- **Security hardening:** Auth exists, but endpoint-level RBAC and stronger policy controls are not complete.

### Unimplemented / backlog-aligned features
- Real-time news sentiment weighting in regime detection.
- Full quality gates in CI with enforceable thresholds (coverage + complexity + dependency policy).
- Advanced reporting expansion and dashboarding polish for risk-mode comparisons.
- Configurable trailing-stop thresholds (currently effectively fixed behavior in trade update logic).

## Configuration Surface (Current)

### Environment variables in active backend code
- `NODE_ENV`
- `API_ADMIN_TOKEN` / `API_TRADER_TOKEN` (with `API_AUTH_TOKEN` admin fallback)
- `EXCHANGE_NAME`
- `EXCHANGE_API_KEY`
- `EXCHANGE_API_SECRET`
- `EXCHANGE_API_PASSWORD`
- `EXCHANGE_USE_TESTNET`
- `COINGECKO_API_KEY`
- `GEMINI_API_KEY`

### Important note
- Exchange/API provider configuration is now env/settings-driven for credentials, but provider behavior remains CMC-centric and should be generalized.

## Test Appraisal (This Review Pass)

### What was updated
- Expanded `npm test` to execute all `tests/*.test.ts` files.
- Stabilized tests to run without external network/database side effects by mocking DB and market-data dependencies where appropriate.
- Fixed test assumptions around asynchronous engine start/stop and trade-balance movement behavior.

### Current result
- `npm run lint` passes.
- `npm test` passes with **53/53** tests in this environment.
- `npm run test:coverage` currently reports **~61.8% lines / ~70.6% branches** overall.

## Recommended Next Steps (Prioritized)

✅ **Completed in this pass**
1. **Security hardening follow-up**
   - Added route-level authorization tests covering 401/403/503 paths.
   - Adopted Zod schemas for mutating-route payload validation.

2. **Configuration & secrets cleanup follow-up**
   - Extended connector provider support with Binance ticker fallback path.
   - Added startup diagnostics endpoint (`/api/diagnostics/startup`) with non-secret configuration status.

3. **Engine lifecycle refactor**
   - Implemented explicit `startSchedulers()` / `stopSchedulers()` lifecycle controls.
   - Wired scheduler shutdown into `stop()` for cleaner runtime/test behavior.

4. **Quality gate enforcement**
   - Added CI workflow and local quality scripts for lint/test/coverage/complexity/audit.
   - Added coverage and complexity gate scripts and npm command wiring.

5. **Strategy/data resiliency**
   - Added market/news circuit-breaker behavior with cached-data fallback.
   - Added basic operational diagnostics/metrics endpoint (`/api/diagnostics/health`) for observability.

### New Follow-up Recommendations
✅ **Completed in this pass**
1. Raised baseline quality-gate thresholds incrementally (coverage floor increased to 42% lines / 61% branches) while preserving CI stability.
2. Added structured JSON logging with request correlation IDs (`x-request-id`) across API middleware and key runtime paths.
3. Expanded exchange connector provider support (CoinMarketCap + Binance + Kraken public data) and surfaced provider capabilities via startup diagnostics.

### Next Recommendations
✅ **Completed in this pass**
1. Continued coverage ratcheting by increasing the enforced line-coverage floor to **43%**.
2. Added per-request latency and error-rate telemetry in API middleware and surfaced aggregate + slow-route metrics in `/api/diagnostics/health`.
3. Expanded authenticated execution support beyond Binance by introducing a typed execution-adapter layer with Kraken private API paths (`AddOrder`, `Balance`, `CancelOrder`) and capability reporting.

### Additional Completed Recommendations
✅ **Completed in this pass**
1. Implemented real-time news sentiment weighting in `RegimeDetector`, including confidence boosts/penalties and uncertain-regime nudges for strong directional sentiment.
2. Expanded test suite breadth substantially (exchange adapters, risk manager branches, detector sentiment weighting, metrics state reset), raising baseline coverage to ~51% lines and ~68% branches.
3. Removed hardcoded CoinGecko demo API key fallback and tightened market-data secret sourcing to explicit env/constructor input.
4. Refactored optimization flow for better testability/reliability (injected query + AI client dependencies and invalid-JSON handling), and expanded test coverage to ~56% lines / ~69% branches.
5. Added a Prometheus-style diagnostics metrics surface (`/api/diagnostics/metrics`) for API + market-data counters/latency gauges.
6. Expanded indicator and strategy branch tests, raising observed coverage to ~61% lines / ~70% branches.

### Remaining Recommendations
1. Continue incremental coverage/complexity ratcheting toward long-term policy targets as the test suite expands.
   - Added focused utility tests for `TradingEngine` scheduler methods and logger request-id handling, but large files (`backend/main.ts`, `backend/api/routes.ts`, `backend/shadow/shadow_trader.ts`) remain the biggest coverage gaps.
2. Create deterministic route-level harnesses with mocked DB/engine dependencies to unlock major coverage gains on `routes.ts`.
3. Add deeper simulation tests for `TradingEngine.runCycle` and `ShadowTrader` close/update branches to progress toward a 95% stretch target.
4. Add full OpenTelemetry instrumentation and dashboard/alert wiring (current metrics endpoint is Prometheus-text only).
5. Expand authenticated execution adapters to additional providers (e.g., OKX) behind the typed interface.
