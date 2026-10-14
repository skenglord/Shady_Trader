# Full system usability repair plan

> **For agentic workers:** Use systematic debugging and test-driven development for the independent repair domains; the primary agent integrates and verifies the complete branch.

**Goal:** Make the existing local system usable for real-data paper trading and research by repairing all eleven findings in the October 12 live review and validating complete workflows.

**Architecture:** Retain the current engine, connectors, shadow portfolios and paper service. Establish durable trade ownership, validated market data, one paper service instance and truthful responsive operator views. Keep live execution disabled until existing credentialed venue release gates are met.

**Tech Stack:** Node 22, TypeScript, SQLite, Express, WebSocket, React, Redis/BullMQ, Python/Freqtrade.

**Spec:** `documentation/live_system_review_2026-10-12.md`, findings 1–11 and their acceptance criteria. User explicitly requested rapid repair of all usability gaps after receiving that report.

## Global constraints

- Work in `/tmp/shady-trader-usability`, branch `codex/full-system-usability`.
- Preserve the human-test database and secrets; fixture databases must be isolated.
- Agents edit only assigned files and do not commit shared state. Primary performs integration and documentation.
- Evidence must distinguish observed working flows from unavailable optional capabilities.
- Baseline at `3b3e5c5`: fresh publication run 617 tests, 616 passed, zero failed, one skipped; root lint/build passed. Repeat after changes.

## Review focus

- Partial settlement followed by same-cycle closure and process restart must conserve cash and quantity.
- Changing mode with existing positions must not change reservation ownership.
- Missing, stale or wrong-symbol market data must not become an executable trading mark.
- Repeated/partial paper fills and simultaneous clients must observe a single consistent account.
- Provider outages, feature absence and narrow screens must remain understandable and operable.

## Task 1 — Shadow accounting and risk (accounting agent)

Files: `backend/shadow/*`, `backend/balance/manager.ts`, `backend/risk/manager.ts`, necessary migrations and focused tests.

- [x] Convert archived runner, mode-switch and daily-loss reproductions into failing assertions.
- [x] Settle only the remaining quantity after partial realization; persist runner quantity/stop and realized state for restart.
- [x] Persist reservation ownership and reject excess release; verify mode-switch flat closure retains initial wallet total.
- [x] Resolve daily marks by each trade's symbol; reject unavailable/nonfinite marks.
- [x] Run focused regressions and report interfaces requiring integration.

## Task 2 — Market data contract (market-data agent)

Files: `backend/exchange/connector.ts`, `provider-rotator.ts`, `backend/api/marketDataService.ts`, candle portions of `backend/api/routes.ts`, `backend/indicators/engine.ts`, focused tests.

- [x] Add failing assertions for finalized-candle updates, stale fallback, 4h interval, SOL fallback, absent volume and news publication metadata.
- [x] Upsert mutable bars, enforce symbol/timeframe/quote/freshness validation, use real provider data or explicit unavailability.
- [x] Key candle API reads by explicit symbol/timeframe and remove hour-long caching of mutable data.
- [x] Preserve news publisher/publication time and bound network requests.
- [x] Verify supported pair/timeframe fixtures, outage/recovery, historical vs live use and existing connector tests.

## Task 3 — Paper execution and account ownership (paper agent)

Files: `backend/paper-trading/*` and focused tests. Primary coordinates `backend/main.ts` initialization.

- [x] Assert a limit-100 buy cannot fill at 110; assert 10x long at 99 retains equity and is not liquidated.
- [x] Enforce limit/time-in-force and shared depth; implement consistent margin/equity liquidation.
- [x] Make REST and WebSocket use the engine-owned service via an explicit service registration/accessor; report exact initializer for primary.
- [x] Verify actual REST create/fill/close/summary and idempotent requests with isolated depth fixtures.

## Task 4 — Dashboard and runtime integration (primary)

Files: `backend/main.ts`, frontend `src/`, launcher/runtime scripts, feature status and browser tests.

- [x] Reproduce empty WS performance frames and fix awaiting/caching; verify rejection and cycles.
- [x] Request candles with explicit pair/timeframe; show active source, age and degraded capabilities.
- [x] Correct layout at 390px/tablet/desktop, contain tables and charts, retain reachable controls.
- [x] Inspect and start local Redis/Freqtrade/ML capabilities where available; make setup and unavailable states actionable.
- [x] Fix uncovered CLI/test-discovery/runtime gaps needed to execute user workflows.

## Task 5 — Integration and verification (primary)

- [x] Review all changes against the audit acceptance criteria and focused test evidence.
- [x] Run complete discovered Node test suite, lint, build and relevant browser checks.
- [x] Launch revised app with isolated real-data paper state, exercise authenticated charts, portfolios, paper lifecycle, research flows and feature status.
- [x] Re-run public-provider comparisons and verify correct finalized/stale behavior.
- [x] Update AGENTS and readiness report with verified outcomes and any external blockers.
- [x] Commit verified work, integrate into main and preserve the human-test app for the user.

Implementation also repaired Redis readiness/restart, Freqtrade CLI/result formats, closed-history schema mismatch, manual entry after stop and chart-stream time units. ML dependency installation is verified; trained-model and deployment/live-funds gates remain explicitly open in the readiness report.
