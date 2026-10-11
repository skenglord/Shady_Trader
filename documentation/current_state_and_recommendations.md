# Current State & Recommendations (2026-10-10)

**Shady Trader is not ready for live funds or untrusted network exposure.** The [full system audit](full_system_audit_2026-10-10.md) records current evidence, findings and remediation. It supersedes prior June readiness claims. This audit changed documentation only; no production fixes or deployment were performed.

## Fresh verification

| Check | October 10 result |
| --- | --- |
| Root TypeScript, frontend build, complexity | Pass |
| Serial Node 22 tests | 518 tests: 517 passed, 0 failed/cancelled, 1 skipped |
| Backend coverage gate | Pass: 56.97% lines, 74.68% branches |
| Root ML tests excluded by normal glob | 28/28 pass when explicitly selected |
| Isolated Chromium frontend checks | 2/2 pass with mocked APIs/WebSocket |
| CLI-specific TypeScript project | Fails TS6059 rootDir/import boundary |
| Production npm audit | 12 affected packages: 1 critical, 2 high, 9 moderate |
| Existing localhost service | No listener at port 3000; runtime health unverified |

Tests ran in a clean Git snapshot with optional ML/Gemma/Freqtrade/live trading disabled and no operator database or `.env`. Existing installed dependencies were reused. Node 24 could not load the installed SQLite native addon; Node 22 resolved that mismatch. TAP includes 38 skip records, including entire quarantined suites, so the final one-skipped-test counter does not imply all suites ran. Coverage excludes frontend/Python. Details and artifacts are in the full report.

## Release blockers

- **Security:** malformed unauthenticated WebSocket input can terminate the process; paper REST/WebSocket and symbol mutation miss authorization; development file serving bypasses source restrictions and exposes root data files.
- **Execution:** close retries/concurrency can duplicate orders and P&L; entries can continue after stop; pair switching prices old positions using the new symbol; registered reconciliation adapters return empty stubs and cannot recover uncertain orders.
- **Accounting:** balance updates lose concurrent reservations; runner partial exits are not durably executed/recorded; the paper service mismatches order/position IDs, retains zero market-entry prices, divides P&L by leverage and can liquidate winners while recording no loss.
- **Risk/research:** failed optimisation can mutate live risk parameters; optional synchronous LLM calls select risk mode; ML/database/Freqtrade contracts are inconsistent; WFA/ML evaluation reuses tuning/training data.
- **Operations:** production image omits the imported seed module; application Kubernetes mounts reference undefined volumes; HPA conflicts with single-engine ownership; SQLite file copies do not capture WAL state and do not back up PostgreSQL.

## Recommended sequence

1. Close access-control, malformed-input and development-file exposure defects, with route/frame/path regression tests.
2. Implement one durable exchange execution/reconciliation lifecycle with per-symbol/venue ownership, transactional accounting and safe stop/kill behavior. Prove partial-fill, timeout-after-fill, concurrent-close, DB-failure and restart cases.
3. Repair paper accounting and risk activation, remove LLM risk authority, fix research integration and reserve untouched evaluation data.
4. Repair image/manifests/backups, upgrade vulnerable dependencies, correct CLI/test discovery and verify sandbox-exchange plus real PostgreSQL/Freqtrade/browser integration before live release.

Implementation presence is not readiness: the system has substantial backend/frontend functionality, and current compilation checks pass, but the audit reproduces failures outside those tests. Advisory severities are inventory results; the full report separately assesses reachability and does not claim every dependency advisory is exploitable here.
