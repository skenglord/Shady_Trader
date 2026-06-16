# Revised Audit Fix Plan

Created: 2026-06-16
Revised: 2026-06-17
Status: implementation completed; revision remains the planning document and source of truth for scope boundaries.
Supersedes: the original “Shady_Trader Audit Fixes” implementation plan and the 2026-06-16 version of this plan.

## Executive decision

The original audit-fix plan should **not** be implemented as written. It mixes verified correctness defects, stale items, already-completed schema work, and high-risk structural refactors.

This revised plan now reflects the current repository state:

1. **DB schema/index migration work is already implemented** and should be treated as verification-only.
2. **Remaining correctness defects are still actionable.**
3. **Performance/hygiene work should stay narrow and test-backed.**
4. **Structural refactors remain deferred and should not be bundled into audit remediation.**

## Recent changes accounted for

- `backend/migrations/0005_shadow_trades_close_reason_and_indexes.ts` now exists and is wired by `backend/migrations/runner.ts:5-16`.
- `backend/database.ts` now includes:
  - `close_reason TEXT DEFAULT NULL` on `shadow_trades`.
  - `idx_trades_status`, `idx_shadow_trades_status`, and `idx_signals_symbol`.
  - `PRAGMA wal_autocheckpoint = 1000`.
  - `PRAGMA busy_timeout = ${QUERY_TIMEOUT_MS}`.
- `backend/database_postgres.ts` now includes:
  - `SET statement_timeout = ${QUERY_TIMEOUT_MS}` during initialization and query execution.
  - `close_reason TEXT DEFAULT NULL` on `shadow_trades`.
  - `idx_trades_status` and `idx_shadow_trades_status`.
- `AGENTS.md` now records the existence of `documentation/revised_audit_fix_plan.md`.
- No code implementation was performed as part of this plan revision.

## Current verified context

### Implementation completed

- Removed the duplicate signal-only persistence block from `backend/main.ts`; `runCycle()` now records signals once per cycle and keeps the existing every-cycle signal recording path.
- Fixed `TRADER_TOKEN_PLACEHOLDER` initialization order in `src/App.tsx` so the frontend can evaluate without `VITE_TRADER_TOKEN`.
- Replaced request middleware `console.log` calls in `server.ts` with structured `logger.debug` calls that include request ID, method, and URL.
- Added artifact ignores for `*.webm`, `coverage/tmp/`, `playwright-results.json`, `test-results/`, and `*.pyc`.
- Verified the `shadow_trades` schema, indexes, WAL autocheckpoint, and query-timeout policy without reopening schema edits.
- Added `.unref()` to missing exchange/backpressure and cache cleanup intervals.
- Optimized backtest exit lookup with a candle-time-to-index map while preserving skip-ahead behavior.
- Reused the first `/api/balances` balance snapshot for historical PnL and response construction.
- Pruned `SELECT *` from the stable high-volume endpoints listed in section 2.7 and added route/source tests for response-shape stability.

### Still actionable

- `backend/main.ts:1044-1083` already records signal/no-signal data every cycle.
- `backend/main.ts:1085-1127` still duplicates signal recording only when `signal` exists.
- `src/App.tsx:22-24` still references `TRADER_TOKEN_PLACEHOLDER` before declaration.
- `server.ts:269-272` and `server.ts:332-335` still use direct `console.log`.
- `.gitignore` still lacks the planned artifact entries for `*.webm`, `coverage/tmp/`, `playwright-results.json`, `test-results/`, and `*.pyc`.
- `backend/exchange/backpressure.ts:26` and `backend/exchange/cache.ts:26` still use intervals without `.unref()`.
- `backend/main.ts:1338` still uses `df.findIndex(c => c.time === exitTime)` inside the backtest loop.
- `backend/api/routes.ts:1211-1247` still calls `engine.balanceManager.getBalances()` twice in `/api/balances`.
- `backend/api/routes.ts` still uses broad `SELECT *` on several API endpoints.
- `src/App.tsx:429-447` still uses `balances` from the initial render inside a `setInterval` callback, creating stale closure risk.

### Already resolved or stale

- `backend/freqtrade/workers/validateWorker.ts:13` already imports `../validation.js`; the planned import fix is stale.
- `tests/monte-carlo/monte-carlo-engine.test.ts:35-39` already uses `express()`, not `Router()`; the planned test type fix is stale.
- `backend/backup.ts:9-19` already implements async backup; the original plan pointed at stale/unused `TradingEngine.backupDatabase()` in `backend/main.ts:515-534`.
- `backend/exchange/connector.ts:128-140` already calls `.unref()` on its interval.
- `backend/database.ts`, `backend/database_postgres.ts`, and `backend/migrations/0005_shadow_trades_close_reason_and_indexes.ts` now address the `shadow_trades` schema drift and missing indexes.

## Phase 0 — Pre-flight verification

**Goal:** confirm the working tree and test environment before code changes.

1. Run `git status --short` and record uncommitted files.
2. Run `git diff --check`.
3. Run available quality gates in a Node-enabled shell:
   - `npm run lint`
   - `npm test -- --test-reporter=spec --test-concurrency=1 --test-timeout=120000`
   - `npm run build`
   - `npm run quality:coverage`, if Node/npm are available
4. If any gate is red before work starts, do not attribute it to this plan unless the failing file/route is touched.

**Definition of done:** baseline command results are recorded in this document or the session summary.

## Phase 1 — Correctness fixes to implement now

### 1.1 Remove duplicate signal recording

**Files:** `backend/main.ts`

**Change:**

- Delete the second signal-only recording block currently at `backend/main.ts:1085-1127`.
- Keep the existing every-cycle recording block at `backend/main.ts:1044-1083`.
- Preserve the existing logic that uses `signal.side` when a signal exists and `liveConfidence.side` when no signal exists.

**Why:** prevents duplicate `signals` rows and duplicate frontend `signal_record` events on signal cycles.

**Risk:** low.

**Tests:** add or update a deterministic test around `runCycle()` signal persistence to assert exactly one `signals` row per cycle when a signal exists.

### 1.2 Verify `shadow_trades` schema migration

**Files:** `backend/database.ts`, `backend/database_postgres.ts`, `backend/migrations/0005_shadow_trades_close_reason_and_indexes.ts`, `backend/migrations/runner.ts`

**Change:** no new schema edits unless verification fails.

**Verification:**

- Confirm `close_reason` exists on new SQLite and Postgres schemas.
- Confirm migration 0005 adds `close_reason` to existing SQLite databases only when missing.
- Confirm `idx_trades_status`, `idx_shadow_trades_status`, and `idx_signals_symbol` are created in SQLite and relevant Postgres schema paths.
- Confirm migration 0005 is registered in `backend/migrations/runner.ts`.

**Why:** this work is already implemented; the remaining task is verification.

**Risk:** low for verification; medium only if schema edits are reopened.

**Tests:** schema initialization/migration test.

### 1.3 Fix `TRADER_TOKEN_PLACEHOLDER` temporal dead zone

**File:** `src/App.tsx`

**Change:**

- Move `TRADER_TOKEN_PLACEHOLDER` above `TRADER_TOKEN` so it is initialized before use.
- Keep the existing placeholder check: token headers are only attached when the token is present and not a placeholder.

**Why:** prevents a frontend startup `ReferenceError` when `VITE_TRADER_TOKEN` is absent.

**Risk:** low.

**Tests:** add a small frontend/unit test or static verification that `TRADER_TOKEN` can be evaluated without `VITE_TRADER_TOKEN`.

### 1.4 Replace request middleware `console.log` with structured logger

**File:** `server.ts`

**Change:**

- Replace `console.log('Request:', ...)` at `server.ts:269-272` with `logger.debug(...)`.
- Replace `console.log('API route hit:', ...)` at `server.ts:332-335` with `logger.debug(...)`.
- Include request ID, method, and URL where available.

**Why:** avoids noisy request logs and keeps structured logging consistent.

**Risk:** low.

**Tests:** smoke test server startup; optional test that logger debug calls do not throw.

### 1.5 Add missing `.gitignore` entries

**File:** `.gitignore`

**Change:**

- Add:
  - `*.webm`
  - `coverage/tmp/`
  - `playwright-results.json`
  - `test-results/`
  - `*.pyc`

**Why:** prevents binary/test artifacts from polluting history.

**Risk:** very low.

**Tests:** none required beyond `git status --ignored --short` if desired.

## Phase 2 — Low-risk performance and hygiene fixes

### 2.1 Add `.unref()` to missing intervals

**Files:** `backend/exchange/backpressure.ts`, `backend/exchange/cache.ts`

**Change:**

- Add `.unref()` to the interval in `backend/exchange/backpressure.ts:26`.
- Add `.unref()` to the interval in `backend/exchange/cache.ts:26`.
- Do not change intervals that already call `.unref()` or are intentionally owned by shutdown logic unless tests prove they leak.

**Why:** reduces event-loop pinning during clean process exit.

**Risk:** low.

**Tests:** process-exit or deterministic test that creates these managers and verifies no unexpected open handles remain.

### 2.2 Verify DB indexes

**Files:** `backend/database.ts`, `backend/database_postgres.ts`, `backend/migrations/0005_shadow_trades_close_reason_and_indexes.ts`

**Change:** no new index edits unless verification fails.

**Verification:**

- Confirm SQLite schema includes `idx_trades_status`, `idx_shadow_trades_status`, and `idx_signals_symbol`.
- Confirm Postgres schema includes equivalent indexes where supported.
- Confirm migration 0005 is idempotent.

**Why:** this work is already implemented; the remaining task is verification.

**Risk:** low for verification.

**Tests:** schema/migration test.

### 2.3 Optimize backtest exit lookup

**File:** `backend/main.ts`

**Change:**

- Before the backtest loop, build a `Map<number, number>` from candle `time` to index.
- Replace `df.findIndex(c => c.time === exitTime)` at `backend/main.ts:1338` with a map lookup.
- Keep the existing skip-ahead behavior unchanged.

**Why:** removes an O(n²) lookup pattern from backtest simulation.

**Risk:** low.

**Tests:** add deterministic backtest test asserting identical trades/metrics before and after optimization on a known candle set.

### 2.4 Remove duplicate balance query

**File:** `backend/api/routes.ts`

**Change:**

- Store the first `engine.balanceManager.getBalances()` result in `/api/balances`.
- Reuse it for historical PnL and response construction.

**Why:** removes redundant DB/service call.

**Risk:** low.

**Tests:** existing `/api/balances` route test should assert identical response shape and values.

### 2.5 Verify SQLite WAL checkpoint management

**File:** `backend/database.ts`

**Change:** no new SQLite pragma edits unless verification fails.

**Verification:**

- Confirm `PRAGMA wal_autocheckpoint = 1000` is applied after WAL setup.
- Confirm `busy_timeout` remains intentionally configured.
- Confirm the documented timeout policy matches operational expectations.

**Why:** this work is already implemented; the remaining task is verification.

**Risk:** low for verification.

**Tests:** database initialization test or manual SQLite pragma inspection.

### 2.6 Verify query timeout policy

**Files:** `backend/database.ts`, `backend/database_postgres.ts`

**Change:** no new timeout edits unless verification fails.

**Verification:**

- SQLite uses `PRAGMA busy_timeout = ${QUERY_TIMEOUT_MS}`.
- Postgres uses `SET statement_timeout = ${QUERY_TIMEOUT_MS}` during initialization and query execution.
- The current 30-second policy is intentional and documented. If the operational target remains 5 seconds, adjust both SQLite and Postgres together rather than only one path.

**Why:** this work is already implemented; the remaining task is policy verification.

**Risk:** low for verification; medium if timeout values are changed.

**Tests:** mocked DB client tests or controlled timeout tests.

### 2.7 Prune `SELECT *` from high-volume API endpoints

**File:** `backend/api/routes.ts`

**Change:**

- Replace broad selects only on endpoints where response fields are known and stable:
  - `/api/trades`
  - `/api/shadow-trades/closed`
  - `/api/shadow-trades/all`
  - `/api/signals`
  - `/api/trades/closed`
  - `/api/history/regime`
  - `/api/slippage/history`
- Preserve response field names. For `slippage_history`, keep mapping from snake_case DB columns to camelCase response fields.

**Why:** reduces over-fetch and API fragility.

**Risk:** medium, because response shape regressions can break the frontend.

**Tests:** route response tests for all affected endpoints.

## Phase 3 — Defer or split into separate workstreams

These items are valid engineering improvements but should not be bundled into the audit-fix workstream.

### 3.1 Async log rotation

**File:** `backend/logging/rotation.ts`

**Recommendation:** defer until sync callers are audited.

**Reason:** converting `needsRotation`, `rotate`, and `checkAndRotate` to async changes method contracts and callers.

### 3.2 CSV import cleanup

**File:** `backend/api/routes.ts`

**Recommendation:** defer or handle as a focused route hardening task.

**Reason:** the current stream callback can double-send responses on error. Async cleanup is worthwhile but needs route-level tests.

### 3.3 Reduce JSON body limit

**File:** `server.ts`

**Recommendation:** defer until maximum payload sizes are measured.

**Reason:** 1 MB may break legitimate CSV imports, Freqtrade payloads, or settings imports.

### 3.4 Lazy-load React panels

**File:** `src/App.tsx`

**Recommendation:** defer until after correctness fixes.

**Reason:** useful bundle optimization, but not audit remediation.

### 3.5 Split `App.tsx` monolith

**Recommendation:** defer to a frontend refactor milestone.

**Reason:** high churn in a 3000+ line file; do not combine with audit fixes.

### 3.6 Rewrite git history

**Recommendation:** defer unless binary artifacts are confirmed in history.

**Reason:** history rewrite requires coordination and coordinated force-push. Use BFG or `git filter-repo`, not casual `filter-branch`.

### 3.7 Add ESLint and commitlint/husky

**Recommendation:** defer to tooling/hygiene milestone.

**Reason:** useful but separate from production safety fixes.

### 3.8 Bundle-size optimization

**Recommendation:** defer.

**Reason:** Recharts individual imports are low-risk, but replacing charting libraries is not audit remediation.

### 3.9 Consolidate Redis connections

**Recommendation:** defer.

**Reason:** current Redis clients have different roles: engine state, API idempotency, and job queues. Consolidation could change fail-open/fail-closed behavior.

### 3.10 Complete `.env.example`

**Recommendation:** keep as separate documentation/configuration task from `documentation/production_readiness_todo.md`.

**Reason:** safe and important, but not a code audit fix.

## Execution order

1. Phase 0 baseline.
2. Phase 1 correctness fixes: 1.1, 1.3, 1.4, 1.5.
3. Phase 1 verification: 1.2.
4. Phase 2 low-risk fixes: 2.1, 2.3, 2.4, 2.7.
5. Phase 2 verification: 2.2, 2.5, 2.6.
6. Phase 3 items only as separate tickets/milestones.

## Verification matrix

| Area | Required verification |
|---|---|
| Signal recording | One signal row per cycle when signal exists; no duplicate `signal_record` broadcast. |
| `shadow_trades` schema | Single table definition; `close_reason` present on new and existing DBs; migration 0005 idempotent. |
| Frontend token placeholder | App starts without `VITE_TRADER_TOKEN`; auth headers remain disabled for placeholder token. |
| Request logging | Startup smoke test passes; no direct request middleware `console.log`. |
| Intervals | Managers can be constructed without leaving preventable handles. |
| DB indexes | Schema/migration test confirms indexes exist. |
| Backtest optimization | Same trades/metrics on deterministic input before and after change. |
| Balances API | Response shape and values unchanged. |
| SQLite WAL | `wal_autocheckpoint` pragma is applied. |
| Query timeout | SQLite busy timeout and Postgres statement timeout are testable and intentionally aligned. |
| Pruned selects | All affected API endpoint response shapes remain stable. |

## Rollback guidance

- Keep the duplicate-signal fix separate from schema verification work.
- Do not revert migration 0005 unless the team explicitly rejects `close_reason` and the new indexes.
- For DB schema changes, keep a rollback SQL path that drops only newly added indexes and removes `close_reason` only on disposable/test DBs.
- Do not rewrite git history unless all collaborators are available for coordinated force-push.
- If `/api/balances`, `/api/signals`, or `/api/shadow-trades/*` response shape changes, revert the select-pruning change first.
