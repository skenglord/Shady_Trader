# Revised Audit Fix Plan

Created: 2026-06-16  
Supersedes: `documentation/production_readiness_todo.md` audit-fix notes and the original “Shady_Trader Audit Fixes” implementation plan.

## Executive decision

The original audit-fix plan should **not** be implemented as written. It mixes low-risk correctness fixes with stale items and high-risk structural refactors. This revised plan separates the work into:

1. **Correctness fixes that are safe to apply now.**
2. **Low-risk performance/hygiene fixes that need targeted tests.**
3. **Deferred engineering-debt work that should not be bundled into audit remediation.**

The primary goal is to remove verified correctness defects without introducing regression risk in trading, API, database, or frontend state paths.

## Current verified context

- `backend/main.ts:1044-1083` already records signal/no-signal data every cycle.
- `backend/main.ts:1085-1127` duplicates signal recording only when `signal` exists.
- `backend/database.ts:54-69` creates `shadow_trades` once, then `backend/database.ts:206-222` recreates it later in the same schema block.
- `backend/freqtrade/workers/validateWorker.ts:13` already imports `../validation.js`; the planned import fix is stale.
- `tests/monte-carlo/monte-carlo-engine.test.ts:35-39` already uses `express()`, not `Router()`; the planned test type fix is stale.
- `src/App.tsx:22-24` references `TRADER_TOKEN_PLACEHOLDER` before declaration.
- `server.ts:269-272` and `server.ts:332-335` still use direct `console.log`.
- `backend/backup.ts:9-19` already implements async backup; the original plan points at stale/unused `TradingEngine.backupDatabase()` in `backend/main.ts:515-534`.
- `backend/exchange/connector.ts:128-140` already calls `.unref()` on its interval.
- `src/App.tsx:429-447` uses `balances` from the initial render inside a `setInterval` callback, creating stale closure risk.

## Phase 0 — Pre-flight verification

**Goal:** confirm the working tree and test environment before changes.

1. Run `git status --short` and record uncommitted files.
2. Run `git diff --check`.
3. Run available quality gates:
   - `npm run lint`
   - `npm test -- --test-reporter=spec --test-concurrency=1 --test-timeout=120000`
   - `npm run build`
   - `npm run quality:coverage`, if Node/npm are available
4. If any gate is red before work starts, do not treat that as caused by this plan unless the failing file/route is touched.

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

### 1.2 Fix `shadow_trades` schema duplication and `close_reason`

**Files:** `backend/database.ts`, database migrations if present.

**Change:**

- Add `close_reason TEXT DEFAULT NULL` to the first `shadow_trades` table definition at `backend/database.ts:54-69`.
- Delete the duplicate `CREATE TABLE IF NOT EXISTS shadow_trades` block at `backend/database.ts:206-222`.
- Add an explicit migration/compatibility path for existing SQLite databases:
  - `ALTER TABLE shadow_trades ADD COLUMN close_reason TEXT DEFAULT NULL` only if the column is missing.
- Apply the same schema decision to the Postgres schema if live Postgres mode is intended to support `close_reason`.

**Why:** removes schema drift and makes the intended table shape explicit.

**Risk:** medium, because existing DBs may already have rows and the duplicate `IF NOT EXISTS` currently masks the issue.

**Tests:** add schema initialization test asserting one `shadow_trades` table definition and one `close_reason` column.

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

### 2.2 Add missing DB indexes

**File:** `backend/database.ts`

**Change:** add the following indexes near the existing schema initialization indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_shadow_trades_status ON shadow_trades(status);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
```

**Also consider:**

- `idx_signals_symbol_timestamp` for chart marker queries.
- `idx_shadow_trades_timestamp_status` for trade history filtering.
- Postgres equivalents if Postgres mode is supported.

**Why:** improves common endpoint queries without changing API behavior.

**Risk:** low to medium.

**Tests:** schema test asserting indexes exist; API route tests for `/api/trades`, `/api/shadow-trades/*`, and `/api/signals`.

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

### 2.5 Add SQLite WAL checkpoint management

**File:** `backend/database.ts`

**Change:**

- After `PRAGMA journal_mode = WAL`, add:
  - `PRAGMA wal_autocheckpoint = 1000;`
- Keep the existing `busy_timeout = 5000` unless Phase 2.6 changes it.

**Why:** reduces unbounded WAL growth risk.

**Risk:** low for SQLite.

**Tests:** database initialization test or manual SQLite pragma inspection.

### 2.6 Enforce query timeout pragmatically

**Files:** `backend/database.ts`, `backend/database_postgres.ts`

**Change:**

- SQLite:
  - Replace or align `QUERY_TIMEOUT_MS` usage with `PRAGMA busy_timeout = 30000`.
  - Do not attempt to cancel synchronous `better-sqlite3` queries with `AbortController`; it will not cancel an in-flight sync call.
- Postgres:
  - Add `statement_timeout` at connection/query level using `QUERY_TIMEOUT_MS` or a Postgres-specific timeout.
  - Ensure the client is released in all paths.

**Why:** the current `QUERY_TIMEOUT_MS` constant is defined but not enforced.

**Risk:** medium.

**Tests:** timeout behavior should be tested with mocked DB clients or controlled slow queries.

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
2. Phase 1: 1.1, 1.2, 1.3, 1.4, 1.5.
3. Phase 2: 2.1, 2.2, 2.3, 2.4, 2.5.
4. Phase 2 only if tests are added: 2.6, 2.7.
5. Phase 3 items only as separate tickets/milestones.

## Verification matrix

| Area | Required verification |
|---|---|
| Signal recording | One signal row per cycle when signal exists; no duplicate `signal_record` broadcast. |
| `shadow_trades` schema | Single table definition; `close_reason` present on new and existing DBs. |
| Frontend token placeholder | App starts without `VITE_TRADER_TOKEN`; auth headers remain disabled for placeholder token. |
| Request logging | Startup smoke test passes; no direct request middleware `console.log`. |
| Intervals | Managers can be constructed without leaving preventable handles. |
| DB indexes | Schema test confirms indexes. |
| Backtest optimization | Same trades/metrics on deterministic input before and after change. |
| Balances API | Response shape and values unchanged. |
| SQLite WAL | `wal_autocheckpoint` pragma is applied. |
| Query timeout | SQLite busy timeout and Postgres statement timeout are testable or explicitly documented. |
| Pruned selects | All affected API endpoint response shapes remain stable. |

## Rollback guidance

- Keep the schema changes in one commit and the signal-recording change in another commit.
- For DB schema changes, keep a rollback SQL path that drops only newly added indexes and removes `close_reason` only on disposable/test DBs.
- Do not rewrite git history unless all collaborators are available for coordinated force-push.
- If `/api/balances`, `/api/signals`, or `/api/shadow-trades/*` response shape changes, revert the select-pruning change first.
