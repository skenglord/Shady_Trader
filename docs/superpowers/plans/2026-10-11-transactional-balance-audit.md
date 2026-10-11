# Transactional Balance Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make each `BalanceManager` balance mutation and its `audit_balances` row commit or roll back as one database transaction in SQLite and PostgreSQL.

**Architecture:** Add a transaction-scoped async query callback that pins all statements to one driver connection. SQLite transactions use the initialized `better-sqlite3` connection and serialize ordinary queries around the transaction; PostgreSQL uses one checked-out pool client. Refactor `applyAtomicMutation` to read before/after values, apply the current conditional arithmetic update, and insert the audit row inside that callback.

**Tech Stack:** TypeScript, Node.js test runner, better-sqlite3, node-postgres (`pg`), existing `runQuery` abstraction.

**Spec:** `docs/superpowers/specs/2026-10-11-transactional-balance-audit-design.md`

## Global Constraints

- Keep the public `runQuery(sql, params, type)` signature unchanged.
- Keep current balance formulas, conditional arithmetic SQL, validation, audit schema, and audit contents unchanged.
- A failed conditional update must not write an audit row.
- Any snapshot, update, audit, or commit failure must reject; audit failure must roll back the balance update.
- Apply the same transaction guarantee to SQLite and PostgreSQL.
- Do not change legacy `updateBalances`, external exchange settlement, or add balance mutation idempotency in this phase.

## Review Focus

- Audit insert fails after a successful update: balance remains unchanged and the original audit error is returned.
- Conditional update changes zero rows: no audit record is written and the operation-specific error is preserved.
- Another query arrives while a SQLite transaction awaits work: it cannot execute inside that transaction.
- PostgreSQL callback fails after a query: rollback occurs on the checked-out client and the client is released.
- SQLite rollback fails: the original operation failure remains the thrown error and rollback failure is logged.

---

### Task 1: Add transaction-scoped database execution

**Files:**
- Modify: `backend/database.ts`
- Modify: `backend/database_postgres.ts`
- Test: `tests/database/database_transactions.test.ts`

**Interfaces:**
- Produces `TransactionQuery = (sql: string, params?: any[], type?: 'run' | 'all') => Promise<any>`.
- Produces `withDatabaseTransaction<T>(work: (query: TransactionQuery) => Promise<T>): Promise<T>`.
- PostgreSQL helper pins work to one acquired `PoolClient`; SQLite pins work to the initialized `better-sqlite3` connection.
- Existing `runQuery` remains the non-transactional query API.

- [x] **Step 1: Write transaction adapter tests**

Add tests named `commits scoped SQLite work on success`, `rolls back scoped SQLite work on failure`, `serializes unrelated SQLite queries during an async transaction`, `preserves the original SQLite error when rollback fails`, `uses one PostgreSQL client for all scoped queries`, and `rolls back and releases PostgreSQL client when work fails`. Assert persisted SQLite values after commit/rollback; verify an unrelated SQLite query runs only after transaction completion; assert the original error is rethrown after rollback failure; and assert exact PostgreSQL client query order (`SET statement_timeout = 30000`, `BEGIN`, callback statements, then `COMMIT` or `ROLLBACK`) plus one release.

- [x] **Step 2: Run the adapter tests and verify they fail**

Run: `NODE_OPTIONS= PATH=/home/creekz/.nvm/versions/node/v22.23.3/bin:$PATH node node_modules/tsx/dist/cli.mjs --test tests/database/database_transactions.test.ts`

Expected: FAIL because the transaction API and driver helpers are not implemented.

- [x] **Step 3: Implement `withPostgresTransaction` in `backend/database_postgres.ts`**

Acquire one client, set the existing statement timeout, issue `BEGIN`, invoke the callback with a query function using `toPostgresSql`, then `COMMIT`. On error, attempt `ROLLBACK`, log rollback failure without replacing the original error, rethrow the original error, and release the client in `finally`. Keep the helper's pool dependency injectable for deterministic client lifecycle tests.

- [x] **Step 4: Implement `withDatabaseTransaction` in `backend/database.ts`**

Promote the initialized SQLite connection to module scope. Add a process-local async serialization gate used by normal SQLite `runQuery` calls and transaction entry. Inside the gate, issue `BEGIN IMMEDIATE`, give the callback a query function bound directly to the connection, then commit or roll back. Add a transaction mock hook for tests using `setMockRunQuery`; it must be reset by `clearMockRunQuery` or a corresponding clear helper.

- [x] **Step 5: Run the adapter tests and verify they pass**

Run the command from Step 2. Expected: all transaction adapter tests pass; SQLite data persists after commit and is unchanged after rollback, and PostgreSQL statements share one acquired client.

- [x] **Step 6: Commit the database transaction layer**

```bash
git add backend/database.ts backend/database_postgres.ts tests/database/database_transactions.test.ts
git commit -m "feat: add scoped database transactions"
```

### Task 2: Make balance mutations and audit rows atomic

**Files:**
- Modify: `backend/balance/manager.ts`
- Modify: `tests/balance/atomic_balance_settlement.test.ts`
- Modify: `tests/shadow/trade.test.ts`
- Modify: `tests/deep-deterministic/deep_deterministic_main.test.ts`
- Modify: `tests/integration/e2e.test.ts`
- Modify: `tests/paper-trading/paper-trading-components.test.ts`

**Interfaces:**
- Consumes `withDatabaseTransaction` and `TransactionQuery` from Task 1.
- `BalanceManager` public mutation method signatures and return behavior remain unchanged.

- [x] **Step 1: Add failing balance transaction tests**

Add tests named `writes one audit record for a committed balance mutation`, `does not audit an insufficient-balance mutation`, and `rolls back a balance mutation when its audit insert fails`. Use a transaction-aware store that snapshots and restores balance/audit state on rollback. Assert final balances and exact audit record count/content.

- [x] **Step 2: Run the focused balance tests and verify the audit-failure test fails**

Run: `NODE_OPTIONS= PATH=/home/creekz/.nvm/versions/node/v22.23.3/bin:$PATH node node_modules/tsx/dist/cli.mjs --test tests/balance/atomic_balance_settlement.test.ts`

Expected: the audit failure is swallowed or leaves the balance mutation applied, demonstrating the defect.

- [x] **Step 3: Refactor `BalanceManager.applyAtomicMutation`**

Run the before snapshot, unchanged conditional update SQL, after snapshot, and audit insert through `withDatabaseTransaction`. Pass the scoped query function into `getBalances` and `logAuditBalance`, or create private query-parameterized helpers so neither snapshot escapes the transaction. Preserve operation-specific zero-row errors. Remove the audit helper's catch-and-swallow behavior; propagate insert errors so the transaction wrapper rolls back.

- [x] **Step 4: Run focused balance and database tests**

Run: `NODE_OPTIONS= PATH=/home/creekz/.nvm/versions/node/v22.23.3/bin:$PATH node node_modules/tsx/dist/cli.mjs --test tests/balance/atomic_balance_settlement.test.ts tests/database/database_transactions.test.ts`

Expected: all tests pass, including concurrent settlements, zero-row rejection, and audit failure rollback.

- [x] **Step 5: Commit the atomic balance audit change**

```bash
git add backend/balance/manager.ts tests/balance/atomic_balance_settlement.test.ts tests/shadow/trade.test.ts
git commit -m "fix: commit balance updates with audit records"
```

- [x] **Step 6: Configure existing balance-manager fixtures for scoped transactions**

Install the transaction mock alongside query mocks in the deterministic engine and full-system integration fixtures. Reset the transaction mock whenever a new query mock is installed so stale transaction callbacks cannot leak across tests.

Run: `NODE_ENV=test REDIS_PORT=6399 ML_ENABLED=false GEMMA_ENABLED=false FREQTRADE_ENABLED=false LIVE_TRADING_ENABLED=false USE_POSTGRES=false LOG_DIR=/tmp/shady-audit-logs NODE_OPTIONS= PATH=/home/creekz/.nvm/versions/node/v22.23.3/bin:$PATH node node_modules/tsx/dist/cli.mjs --test tests/integration/e2e.test.ts tests/deep-deterministic/deep_deterministic_main.test.ts`

Expected: both suites pass without a “transaction execution unavailable” error.

- [x] **Step 7: Commit transaction-aware test fixture compatibility**

```bash
git add backend/database.ts tests/deep-deterministic/deep_deterministic_main.test.ts tests/integration/e2e.test.ts
git commit -m "test: configure transaction-aware balance fixtures"
```

### Task 3: Verify the readiness phase and update status

**Files:**
- Modify: `documentation/production_readiness_todo.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes the transaction API and balance behavior from Tasks 1 and 2.

- [x] **Step 1: Run the regression and project checks**

Run the focused balance/database tests, `NODE_OPTIONS= npm run lint`, and the complete Node 22 test suite:

```bash
NODE_ENV=test REDIS_PORT=6399 ML_ENABLED=false GEMMA_ENABLED=false FREQTRADE_ENABLED=false LIVE_TRADING_ENABLED=false USE_POSTGRES=false LOG_DIR=/tmp/shady-audit-logs node_modules/.bin/c8 --reports-dir=coverage-node22 --reporter=text --reporter=json-summary node_modules/.bin/tsx --test --test-concurrency=1 --test-timeout=120000 tests/**/*.test.ts
```

Also run the separately discovered ML suite: `node_modules/.bin/tsx --test --test-timeout=120000 tests/ml.test.ts`.

Expected: focused transaction tests and lint pass; full suite passes with documented skips. Align the legacy paper component assertions with established full-notional PnL results (10 for a +10 move on quantity 1; 20 for a +10 move on quantity 2).

- [x] **Step 2: Update current readiness status**

Mark balance update plus audit transactionality complete only if both drivers' transaction behavior and audit-failure rollback tests pass. Retain real exchange reconciliation, dependency advisories, deployment validation, and all other audit blockers as outstanding.

- [x] **Step 3: Commit readiness status**

```bash
git add AGENTS.md documentation/production_readiness_todo.md
git commit -m "docs: record transactional balance readiness"
```

- [x] **Step 4: Verify the branch before merge**

Run: `git diff --check` and `git status -sb`.

Expected: no whitespace errors and a clean worktree after commits. Fast-forward merge to `main` only after the verification above passes.
