# Operational Readiness Gameplan

**Status:** Local continuation verified October 7, 2026; deployment and live-readiness gates remain.
**Scope:** Make Shady Trader reproducible, safe in paper/testnet operation, deployable, observable, and maintainable. The current code has a live-order path; operators should keep it unconfigured/disabled until the safety criteria below pass.

## Current baseline

- The existing untracked `AUDIT_REPORT.md` was removed at the user's request. No other report-like audit artifact was present in the repository root or under tracked source paths.
- The first `npm test` run failed because Node `v24.21.0` did not match the installed SQLite native binding (Node ABI 127 vs 137). Node `22.23.3` is selected in `.nvmrc`; the latest full suite on Node 22 passed: 516 tests, 515 passed, 0 failed, 1 skipped. The skipped test is the optional Freqtrade bulk-ingest suite because `backend/freqtrade/venv/bin/python3` and its pandas/pyarrow dependencies are absent.
- `npm run lint`, `npm run build`, and `npm run quality:complexity` passed on Node 22. The frontend build reports a large-chunk advisory.
- Existing working-tree change `package-lock.json` (18 removed `libc` fields) was present before this work and has been left untouched.
- Source review found incomplete risk-limit wiring, misleading persistence after live-order failure, possible duplicate execution across replicas, unsafe placeholder Kubernetes credentials, and production image / Kubernetes networking and health-check defects.

## Implementation completed in this pass

- Pinned Node 22 and aligned the production image; moved `tsx` into runtime dependencies so the configured start command exists in production.
- Added strict env validation, per-entry effective-risk and degen dollar caps, UTC realized and open-trade unrealized daily-loss checks, cost-aware P&L, and fail-closed live-order configuration checks. Live spot execution rejects leveraged risk modes.
- Added durable execution intents and candle-based idempotency, preserves uncertain/failed entries and closes for operator reconciliation, and prevents automated exchange orders from reconciliation. The API now blocks risk-mode changes while exchange-backed positions are open.
- Protected provider health details, bounded WebSocket payloads/connections, corrected lock cleanup, and fixed PostgreSQL placeholder/schema SQL handling with portability coverage.
- Updated vulnerable production dependencies within compatible ranges and upgraded `csv-parse` to v7 after checking the app's usage; the production dependency audit now reports zero vulnerabilities.
- Corrected container/Kubernetes host binding, probes, service exposure, ingress paths, replica ownership, and placeholder secret handling. Added deployment secret/TLS/CORS instructions. Live execution remains off by default.
- Configured an actual Freqtrade webserver service and shared runtime/data volumes in Compose, plus an authenticated sidecar and internal service in Kubernetes. Added Python runtime to the image, a Freqtrade install validator, Node 22/Python CI setup, and documented safe dry-run operation. Local Freqtrade dependency installation was interrupted and is not available for runtime validation.
- Removed the old audit report as requested and added this gameplan as the project roadmap artifact.

## Verification results

### October 7 continuation

- Resumed from the uncommitted local launcher and UI audit additions. The launcher now uses dotenv's parser, handles duplicate token placeholders, pins displayed credentials into the child server environment, checks live mode before writing configuration, and enforces Node 22 and a valid port.
- Added regression coverage for quoted/exported credentials, token generation/reuse, file permissions, duplicate definitions, and refusing live mode without modifying `.env`.
- UI audit summaries count successful checks instead of subtracting failures from a fixed total.
- Final full suite on Node 22: **521 tests, 520 passed, 0 failed, 1 skipped**, including all three launcher regression tests. The optional Freqtrade bulk-ingest suite is skipped because its Python dependencies are unavailable. Typecheck and `git diff --check` passed; production build passed with the existing large-chunk advisory.
- No browser session, deployment, exchange order, or existing `.env` change was performed in this continuation. Browser/PWA runtime validation and the deployment gates below remain open.

### September 30 readiness verification

- `npm test` on Node `22.23.3`: **516 tests; 515 passed, 0 failed, 1 skipped**. The skipped Freqtrade suite has an explicit missing-runtime reason.
- Focused route and live execution safeguard tests: **60 passed, 0 failed**.
- `npm run quality:coverage`: passed; **55.80% lines, 75.32% branches**.
- `npm run quality:complexity`: passed (maximum complexity 50).
- `npm run security:audit`: passed with **0 production vulnerabilities** after upgrading `csv-parse` to version 7.
- `npm run quality:ci`: passed end to end on the final clean install.
- `npm run lint`: passed on Node 22.
- `npm run build`: passed on Node 22 with a frontend chunk-size advisory.
- Compose and Kubernetes YAML parse successfully. Container image and Kubernetes validation could not run because Docker, Podman, kubectl, and a configured deployment context are not available in this environment.
- PostgreSQL SQL translation is unit-tested, but no live PostgreSQL deployment/migration was available. No exchange testnet, Kubernetes cluster, production secret, or TLS domain was available for end-to-end validation.

## Work sequence and exit criteria

### Phase 0 — Establish a reproducible toolchain (local implementation and clean install complete)

**Work**

- Choose and document one supported Node version for local development, CI, and container builds; align the native SQLite module with that version.
- Provide a repeatable dependency bootstrap that does not rely on a developer's pre-existing `node_modules` or Freqtrade virtualenv.
- Make Freqtrade-dependent tests detect a missing optional runtime and either provision it through the documented setup or clearly report a setup prerequisite. Do not silently mark integration behavior as passing.

**Exit criteria**

- Clean dependency installation succeeds from the lockfile.
- SQLite opens, migrations run, and the test runner starts without native ABI errors.
- Test output separates environment prerequisites from actual assertions and preserves a complete failure summary.

### Phase 1 — Restore a trustworthy test and quality baseline (local gates complete; quarantined suites remain)

**Work**

- Re-run the full test suite after Phase 0; fix failures in database worker, migrations, and smoke tests.
- Review skipped and legacy-quarantined tests, prioritize trading execution, risk, persistence, exchange adapters, and paper-trading paths, and restore or replace those tests.
- Run type checking, production build, coverage, complexity, and dependency-audit gates; record each result and fix failures before moving on.

**Exit criteria**

- Full test suite is green from a clean environment.
- Critical trading and persistence paths have active tests; every skipped test has an owner, reason, and removal condition.
- Typecheck, build, coverage, complexity, and dependency checks pass in CI.

### Phase 2 — Make trading risk controls authoritative (implemented; testnet scenarios remain)

**Work**

- Enforce the effective-risk and dollar-risk caps on the final order quantity immediately before every live order. Validate configuration values and fail closed on invalid limits.
- Replace hardcoded daily loss with realized plus explicitly defined unrealized P&L from a durable source; make daily-loss and drawdown breakers halt new entries.
- Bind the Degen override guard to the actual selected mode and live-execution configuration, rather than only the startup environment default.
- Add tests for boundary values, missing/invalid data, leverage, stop distance, fee/slippage effects, and each circuit-breaker transition.

**Exit criteria**

- Every live order is rejected when any configured cap, loss limit, or required account state cannot be verified.
- Safety tests prove exact cap behavior and prove that the disabled / invalid-data paths never place an order.
- Paper trading and exchange testnet pass a documented risk scenario set.

### Phase 3 — Make order lifecycle and multi-instance behavior safe (partial; reconciliation recovery remains)

**Work**

- Treat exchange order acceptance as a state transition: do not persist a successful open position after a rejected or indeterminate order; persist the exchange response and reconcile unknown outcomes before retrying.
- Add durable idempotency keys based on signal/candle, symbol, mode, and action. A short-lived distributed lock alone is not duplicate protection.
- Reconcile open positions and balances against the exchange after restarts, timeouts, partial fills, and close failures.
- Define a single active execution owner or a safe multi-replica leader/queue design; separate stateless API scaling from trading-engine ownership.

**Exit criteria**

- Replaying the same signal across replicas produces at most one entry order.
- Restart and network-failure scenarios converge to exchange state without phantom, duplicated, or silently lost positions.
- Failed close orders remain visible and retry/recovery behavior is operator-controlled and tested.

### Phase 4 — Correct database and state behavior for the deployment target (SQL portability addressed; live PostgreSQL/Redis validation remains)

**Work**

- Decide the supported production database topology. Use PostgreSQL for clustered deployments; do not scale SQLite-backed writers across replicas.
- Audit SQL portability, migrations, transaction boundaries, schema constraints, idempotency, and backup/restore behavior on both supported adapters.
- Define Redis availability behavior for locks, queues, sessions, and state. Fail closed for execution when a distributed lock cannot be guaranteed.
- Test migrations from an empty database and each supported prior schema, plus backup restoration and concurrent startup.

**Exit criteria**

- Clean install, upgrade, rollback/recovery, backup, and restore are rehearsed against the selected database.
- Multi-replica behavior is transactionally safe and does not rely on process-local state for execution correctness.

### Phase 5 — Make build and deployment artifacts usable and secure (configuration corrected; cluster deployment validation remains)

**Work**

- Fix the production image launch path so all runtime commands are present in the production dependency set or compiled artifacts.
- Configure the container to listen on its pod interface, use implemented liveness/readiness endpoints, and verify probes reflect actual readiness.
- Replace checked-in placeholder secrets with generated deployment-time secrets; rotate any credentials that may have been used. Set a specific CORS origin allowlist and verify TLS, ingress paths, and WebSocket forwarding.
- Review Kubernetes replica count, resource limits, storage, NetworkPolicies, Pod security, secret handling, ingress annotations, and service exposure.
- Add an image build and a deployment smoke test in CI; verify startup, authenticated API calls, WebSocket handshake, database, Redis, and graceful shutdown.

**Exit criteria**

- Production image builds and starts from a clean environment, and the app is reachable through its Service and Ingress.
- Invalid credentials and unconfigured auth fail closed; no placeholder token or password is deployed.
- Probes accurately distinguish live, ready, and unavailable states.

### Phase 6 — Validate data, backtests, and operational recovery (not complete)

**Work**

- Audit candle normalization, timestamp ordering, duplicate handling, exchange precision, stale-data handling, and provider fallback behavior.
- Validate backtest assumptions for lookahead, intrabar stop/target ordering, fees, slippage, funding, and exchange constraints. Require sufficient trade counts and out-of-sample evidence before strategy promotion.
- Verify kill/stop behavior, graceful shutdown, queue draining, backup schedules, retention, alerts, metrics, logs, and incident runbooks.
- Run extended paper trading and exchange testnet soak tests with restarts, provider outages, Redis/database interruptions, and duplicate messages.

**Exit criteria**

- Backtest and paper-trading results are reproducible and include realistic cost and failure assumptions.
- Operators can detect unhealthy data, failed execution, stale connections, and breached risk limits and can safely stop/recover the system.
- A documented testnet soak passes the agreed duration and scenarios with no unexplained position/balance divergence.

### Phase 7 — Live-trading release gate (blocked until phases 2–6 exit criteria are verified)

Live trading is considered only after Phases 0–6 pass. Require a signed-off risk configuration, least-privilege exchange keys with withdrawals disabled, verified reconciliation, tested emergency stop, monitoring/alerting, and a limited-capital rollout with explicit operator approval. Passing unit tests alone is not sufficient evidence for live operation.

## Remaining operational work

1. Build and deploy the image from a configured Docker/Kubernetes environment; resolve the frontend chunk-size advisory.
2. Complete the Freqtrade virtualenv install and run its CLI/configuration smoke checks in an environment with working package access.
3. Add exchange order-status recovery for accepted/pending orders and explicit operator resolution for durable uncertain intents. Existing adapters do not all provide confirmed full-fill semantics; live trading must stay disabled until supported adapters and recovery are validated.
4. Validate migrations, backups, and restore against the intended PostgreSQL/Redis deployment; choose a concrete cluster/domain, generate secrets outside source control, and verify TLS/CORS/WebSocket ingress.
5. Run paper/testnet scenario and soak tests covering restarts, partial fills, timeouts, closes, stale data, and service interruptions. Review remaining quarantined/skipped suites.
6. Keep `LIVE_TRADING_ENABLED=false` until Phases 2–6 pass with operator sign-off; tests and code changes alone do not authorize a live release.
