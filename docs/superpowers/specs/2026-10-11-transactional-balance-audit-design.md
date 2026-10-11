# Transactional Balance Settlement Design

## Status and scope

This design addresses the production-readiness finding that balance mutations can commit even when their corresponding `audit_balances` write fails. It covers the shared database execution layer and `BalanceManager` operations that currently use `applyAtomicMutation`. It does not change balance formulas, the audit schema, external exchange settlement, or the legacy `updateBalances` API.

## Goals

- A successful balance mutation and its audit row commit together.
- A failed conditional balance update produces no audit row and leaves balances unchanged.
- An audit insert failure rolls back the balance mutation and propagates an error to the caller.
- The guarantee applies to both SQLite and PostgreSQL.
- Existing arithmetic SQL, validation, method signatures, and audit contents remain compatible.

## Design

Add a transaction-scoped query interface to `backend/database.ts`. It accepts an async callback and supplies a `query(sql, params, type)` function bound to one database connection for the callback's lifetime. PostgreSQL acquires one pool client, begins a transaction, runs every scoped query on that client, commits on success, rolls back on any thrown error, and always releases the client. SQLite uses the initialized `better-sqlite3` connection with explicit transaction boundaries and a process-local serialization gate so unrelated `runQuery` calls cannot interleave between `BEGIN` and `COMMIT`; transaction-scoped calls use the pinned connection directly. The transaction API must not silently fall back to independent queries when the database is unavailable.

Refactor `BalanceManager.applyAtomicMutation` to perform its before snapshot, conditional arithmetic update, after snapshot, and audit insert through that transaction-scoped query function. It will throw the existing failure message when the update reports zero affected rows. `logAuditBalance` will use the scoped query function and stop swallowing insert failures. Other non-transactional consumers of `logAuditBalance` do not exist; keep the helper private to the transaction path.

The before/after snapshots contain the three balance columns currently recorded by `audit_balances`; total P&L fields remain omitted from the audit schema. No read outside the transaction may be used to construct an audit row.

## Error behavior

- Validation errors continue to reject before opening a transaction.
- A conditional update that affects zero rows throws the operation-specific error and rolls back the transaction.
- A database error during either snapshot, update, audit insert, or commit rejects the operation. If the audit insert fails, the balance update is rolled back.
- Rollback errors are logged alongside the original failure; the original failure remains the thrown error.
- If commit outcome is ambiguous due to a connection failure, the caller receives an error. This work does not add idempotency for balance mutations; reconciliation of ambiguous commit outcomes remains a separate concern.

## Compatibility and concurrency

The arithmetic `UPDATE` statements remain the concurrency authority and are not replaced with read-modify-write logic. Audit snapshots are transactionally consistent with each mutation. PostgreSQL row updates serialize competing mutations on the balance row. SQLite transactions serialize writes, while the process-local gate prevents query interleaving on its single connection. Separate application processes continue to rely on the database's transaction and locking semantics.

The public `runQuery` signature remains unchanged. The new scoped transaction API is additive. Existing tests that inject `setMockRunQuery` will need a transaction-aware mock hook or focused database-level tests; tests must prove rollback rather than merely asserting that an audit statement was attempted.

## Verification

Focused tests must prove: successful mutation creates one matching audit row; insufficient balance creates no audit row and changes no balance; injected audit failure leaves the balance unchanged and rejects; concurrent settlements retain their arithmetic results and each has an audit row; transaction-scoped queries use one connection and issue commit/rollback correctly for each supported backend. Run focused balance/database tests, root TypeScript lint, and the full Node 22 suite before merging.

## Risks

The SQLite serialization gate must be reentrant for transaction-scoped calls and must release after every failure path. Existing application code can issue many concurrent database calls, so the implementation must keep the critical section limited to transactions and must not queue ordinary queries behind a transaction indefinitely. PostgreSQL rollback and client release must both happen if any callback operation fails. The current balance audit table is an operational audit record, not an immutable compliance ledger; this design only guarantees atomic persistence.
