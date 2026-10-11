# Real Exchange Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver authoritative spot order/fill reconciliation and idempotent recovery for Binance, Kraken, OKX, and Coinbase Advanced Trade.

**Architecture:** Extend the existing signed REST execution paths behind one typed account-execution contract, persist account-scoped intents and immutable fills, and reconcile them through a fail-closed engine. Apply confirmed fill effects transactionally; expose unresolved incidents through admin-authenticated and audited controls.

**Tech Stack:** TypeScript, Node.js test runner via `tsx`, SQLite and PostgreSQL, Express, Axios, existing database transaction helpers.

**Spec:** [2026-10-11-real-exchange-reconciliation-design.md](../specs/2026-10-11-real-exchange-reconciliation-design.md)

## Global Constraints

- Support Binance Spot, Kraken Spot, OKX Spot, and Coinbase Advanced Trade spot products.
- Exclude derivatives, margin borrowing, and short positions. Live short entries must be denied for these spot adapters.
- Account balances alone do not identify bot-owned positions.
- Do not store API secrets or raw credentials in persistence or logs.
- Do not send automatic compensating orders or automatically retry an uncertain order submission.
- Any unavailable, incomplete, stale, or ambiguous exchange state must leave the account blocked from new live exposure.
- Automatically recover only uniquely matched intent fills; unresolved cases require operator resolution.

## Review Focus

- Incomplete pagination can look like a clean account snapshot; tests must prove the cycle fails and does not advance its checkpoint (Task 4).
- Client IDs and exchange IDs may be missing, reused, or ambiguous in legacy/history data; tests must prove ambiguity remains unresolved (Tasks 2 and 4).
- Spot fees may be charged in base, quote, or a third asset; tests must preserve fee currency without changing fill quantity (Task 2).
- A fill can be replayed after restart or overlap; tests must prove it affects trade/balance/audit exactly once (Task 3).
- One exchange may be used with multiple credentials/environments; tests must prove account isolation and account-scoped live-entry blocking (Tasks 1 and 5).

---

## File Map

- Create `backend/exchange/account-execution-adapter.ts` for canonical order/fill/account types and the shared adapter contract.
- Modify `backend/exchange/connector.ts` to pass persisted client IDs, implement authenticated reads, correct Coinbase Advanced Trade auth/payloads, and register its execution adapter with reconciliation.
- Retire `getPositions()` from the reconciliation contract in `backend/exchange/adapter.ts`; keep unrelated order-book/OCO responsibilities intact unless they can be removed without changing callers.
- Modify `backend/exchange/reconciliation.ts` to serialize account cycles, page complete snapshots, recover intents, and maintain durable incidents/checkpoints.
- Create `backend/exchange/fill-settlement.ts` to apply normalized fills through one database transaction.
- Create `backend/migrations/0007_exchange_reconciliation.ts` and register it in `backend/migrations/runner.ts`.
- Modify `backend/shadow/shadow_trader.ts` and `backend/balance/manager.ts` for account-scoped entry gating, recovered open trades, partial quantities, and transaction-scoped PnL/balance settlement.
- Modify `backend/api/routes.ts` for admin-only incident listing/resolution.
- Add focused tests under `tests/exchange/`, `tests/shadow/`, `tests/balance/`, `tests/migrations/`, and `tests/api/`.

## Task 1: Canonical Contracts, Account Scope, and Persistence

**Files:**
- Create: `backend/exchange/account-execution-adapter.ts`
- Create: `backend/migrations/0007_exchange_reconciliation.ts`
- Modify: `backend/migrations/runner.ts`
- Test: `tests/migrations/migrations.test.ts`
- Test: `tests/exchange/account_execution_adapter.test.ts`

**Interfaces:**
- Produce `ExchangeOrderStatus = 'pending' | 'open' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired' | 'unknown'`.
- Produce `NormalizedExchangeOrder` with `exchangeOrderId`, `clientOrderId`, `symbol`, `side`, `requestedQuantity`, `filledQuantity`, `averageFillPrice`, `status`, and `updatedAt`.
- Produce `NormalizedExchangeFill` with `exchangeOrderId`, `exchangeFillId`, `symbol`, `side`, `quantity`, `price`, `fee`, `feeCurrency`, and `timestamp`.
- Produce `AccountExecutionAdapter` methods `placeOrder(request)`, `getOrder(query)`, `listOpenOrders()`, `listOrders(since, cursor?)`, `listFills(since, cursor?)`, and `getBalances()`. `getOrder` returns `null` only for a definitive venue “not found”; network/auth/parse errors reject.
- Produce account scoping helper `getExchangeAccountId(exchange, environment, apiKey, configuredId?)`, returning an explicit configured ID or a one-way venue/environment/key fingerprint. Do not accept or persist the API secret.
- Add schema for venue/account fields on `execution_intents` and `shadow_trades`, intent purpose/parent trade/client ID, canonical intent state, unique immutable `exchange_fills`, `exchange_reconciliation_state`, and `exchange_reconciliation_incidents` with operator resolution fields.

- [ ] **Step 1: Write failing contract and migration tests.** Assert canonical status types compile; a duplicate `(exchange, account_id, exchange_order_id, exchange_fill_id)` is rejected; incidents and cursors are isolated by account; a missing legacy account ID remains null; and the account ID helper returns the same value for the same inputs but different values for a different venue, environment, or key.
- [ ] **Step 2: Run the focused tests and confirm they fail** because the contract, helper, migration, or schema is absent.
- [ ] **Step 3: Implement the contract, account helper, forward-only SQLite/PostgreSQL-compatible migration, and migration registration.** Leave existing trade/intent data intact; do not guess a venue/account for historical rows.
- [ ] **Step 4: Run `NODE_OPTIONS= PATH=/home/creekz/.nvm/versions/node/v22.23.3/bin:$PATH node node_modules/tsx/dist/cli.mjs --test tests/migrations/migrations.test.ts tests/exchange/account_execution_adapter.test.ts` and confirm all migration and contract tests pass.**
- [ ] **Step 5: Commit** as `feat: add exchange reconciliation persistence`.

## Task 2: Authenticated Venue Adapters and Correlation IDs

**Files:**
- Modify: `backend/exchange/connector.ts`
- Modify: `backend/exchange/adapter.ts`
- Modify: `backend/exchange/account-execution-adapter.ts`
- Test: `tests/exchange/exchange_connector.test.ts`
- Test: `tests/exchange/exchange_reconciliation_adapters.test.ts`

**Interfaces:**
- Implement `AccountExecutionAdapter` for each supported venue and expose it from `ExchangeConnector` as `accountExecutionAdapter`.
- Change internal `placeOrder` to accept `clientOrderId` and return `NormalizedExchangeOrder`; preserve the public connector method signatures used by callers.
- Implement `getOrder`, `listOpenOrders`, `listOrders`, `listFills`, and `getBalances` with venue-specific pagination and symbol mappings.
- Ensure unsupported or malformed responses reject with a typed adapter error; never map them to empty arrays or zero balances.

- [ ] **Step 1: Write failing HTTP-mock tests for all four venues.** Assert Binance `newClientOrderId`, Kraken `cl_ord_id`, OKX `clOrdId`, and Coinbase `client_order_id` are sent unchanged; test each native response’s order/fill/fee/status normalization, pagination, and explicit API error behavior. Assert Coinbase uses the documented Advanced Trade JWT authorization and `order_configuration` body.
- [ ] **Step 2: Run `NODE_OPTIONS= PATH=/home/creekz/.nvm/versions/node/v22.23.3/bin:$PATH node node_modules/tsx/dist/cli.mjs --test tests/exchange/exchange_reconciliation_adapters.test.ts` and confirm each venue test fails before implementation.**
- [ ] **Step 3: Extend the existing connector execution adapter objects to satisfy `AccountExecutionAdapter`, preserving Binance/Kraken/OKX REST signing and correcting Coinbase Advanced Trade credentials, request schema, and response parsing.**
- [ ] **Step 4: Run the adapter suite plus `tests/exchange/exchange_connector.test.ts`; confirm request signing, client ID propagation, pagination, normalizers, and failure cases pass.**
- [ ] **Step 5: Commit** as `feat: add authenticated exchange recovery reads`.

## Task 3: Idempotent Fill Settlement and Partial Trade Accounting

**Files:**
- Create: `backend/exchange/fill-settlement.ts`
- Modify: `backend/balance/manager.ts`
- Modify: `backend/shadow/shadow_trader.ts`
- Test: `tests/exchange/fill_settlement.test.ts`
- Test: `tests/balance/atomic_balance_settlement.test.ts`
- Test: `tests/shadow/live-execution-safety.test.ts`

**Interfaces:**
- Produce `applyExchangeFill(fill: NormalizedExchangeFill, scope: { exchange: string; accountId: string }, balanceManager: BalanceManager): Promise<'applied' | 'duplicate' | 'unmatched'>`.
- Produce `BalanceManager.recordTradeResultInTransaction(query: TransactionQuery, pnl: number, tradeValue: number, metadata?: unknown): Promise<void>`; keep `recordTradeResult(pnl, tradeValue)` as a wrapper using `withDatabaseTransaction`.
- Entry fills increase actual filled quantity and cost basis only once. Exit fills reduce remaining quantity and add realized PnL only once; terminal close occurs only when remaining quantity reaches zero.
- One active exit intent per trade is allowed. A terminal partially filled exit may be followed by a new uniquely keyed exit attempt; an open or uncertain exit may not.

- [ ] **Step 1: Write failing fill-settlement tests.** Verify a new entry fill creates/updates the trade to actual filled quantity; a partial exit updates remaining quantity and realized PnL; replaying the same fill returns `duplicate` and changes no balance/trade/audit rows; a new exit attempt is allowed only after the previous attempt is terminal; and an audit/balance failure rolls back the fill insert and trade update.
- [ ] **Step 2: Run `NODE_OPTIONS= PATH=/home/creekz/.nvm/versions/node/v22.23.3/bin:$PATH node node_modules/tsx/dist/cli.mjs --test tests/exchange/fill_settlement.test.ts tests/balance/atomic_balance_settlement.test.ts` and confirm failures expose missing idempotent settlement.
- [ ] **Step 3: Implement `applyExchangeFill` using `withDatabaseTransaction`; insert the fill under its unique key, update the matching scoped intent and trade, and write balance/audit changes using the transaction-scoped balance method.**
- [ ] **Step 4: Run the focused settlement, balance, and live-execution safety tests; confirm duplicate, partial, close-lock, and rollback behavior passes.**
- [ ] **Step 5: Commit** as `feat: settle exchange fills transactionally`.

## Task 4: Reconciliation Engine, Recovery, and Durable Incidents

**Files:**
- Modify: `backend/exchange/reconciliation.ts`
- Modify: `backend/exchange/connector.ts`
- Create: `backend/exchange/reconciliation_incidents.ts` if incident persistence does not fit cleanly in the engine
- Test: `tests/exchange/reconciliation_safety.test.ts`
- Test: `tests/exchange/reconciliation_recovery.test.ts`

**Interfaces:**
- Change `registerAdapter(adapter: AccountExecutionAdapter): void`; key adapters by `(venue, accountId)`.
- Produce `reconcileAccount(adapter: AccountExecutionAdapter): Promise<ReconciliationResult>` and serialize it per account.
- Produce incident operations `listIncidents(scope?, status?)`, `resolveIncident(id, actor, reason)`, `hasUnresolvedIncidents(scope)`, and `getAccountReadiness(scope)`.
- Recovery uses exchange order ID first, then client order ID; legacy matching requires exactly one order with matching symbol, side, quantity, and bounded timestamp. Zero or multiple matches produce an unresolved incident.
- Advance a fill checkpoint only after all pages have been read and every fill has been durably applied or recorded as unresolved.

- [ ] **Step 1: Write failing engine tests** for timeout-after-fill, replay after restart, exact/ambiguous legacy matching, duplicate fills, an external unmatched fill, incomplete pagination, stale snapshot, read/auth failure, account isolation, and concurrent cycles. Assert failed cycles do not clear incidents or advance checkpoints.
- [ ] **Step 2: Run `NODE_OPTIONS= PATH=/home/creekz/.nvm/versions/node/v22.23.3/bin:$PATH node node_modules/tsx/dist/cli.mjs --test tests/exchange/reconciliation_recovery.test.ts tests/exchange/reconciliation_safety.test.ts` and confirm failures.
- [ ] **Step 3: Implement account-scoped cycle serialization, authenticated order/fill recovery, durable incidents, bounded retry for transient reads, overlap pagination, stale/incomplete snapshot rejection, checkpoint advancement, and account readiness.**
- [ ] **Step 4: Register the actual connector execution adapter with reconciliation; stop registering the separate position stub as an authoritative source.**
- [ ] **Step 5: Run both reconciliation suites and confirm unresolved cases remain blocked while uniquely confirmed fills settle exactly once.**
- [ ] **Step 6: Commit** as `feat: reconcile exchange intents and incidents`.

## Task 5: Live Entry/Exit Integration and Operator Controls

**Files:**
- Modify: `backend/shadow/shadow_trader.ts`
- Modify: `backend/exchange/connector.ts`
- Modify: `backend/api/routes.ts`
- Test: `tests/shadow/live-execution-safety.test.ts`
- Test: `tests/api/reconciliation_admin.test.ts`
- Test: `tests/integration/e2e.test.ts`

**Interfaces:**
- Add `GET /api/reconciliation/incidents?exchange=&accountId=&status=` (admin-authenticated) and `POST /api/reconciliation/incidents/:incidentId/resolve` with `{ reason: string }` (admin-authenticated, audited).
- Add `ExchangeConnector.isAccountReadyForLiveTrading(): Promise<boolean>` backed by persisted reconciliation readiness and adapter capabilities.
- Entry and close intent rows carry venue/account/client ID before the REST order call. All live risk modes on the same account consult the same readiness gate.
- On startup, load confirmed open trades from scoped fills and retain pending/partial/uncertain intents as blockers. Do not discard persisted state on read errors.

- [ ] **Step 1: Write failing tests** for trader access denial/admin access, required resolution reason, audit evidence, unresolved account blocking across risk modes, unavailable adapter refusal, startup recovery of confirmed partial fills, pending intent blocking, and spot short rejection.
- [ ] **Step 2: Run the focused live-safety, admin-route, and integration tests and confirm they fail before wiring.**
- [ ] **Step 3: Wire `processSignal`, close-intent creation, startup load, and connector readiness to the account-scoped state machine. Do not resubmit an existing open/uncertain client ID.**
- [ ] **Step 4: Add the admin incident routes to `adminRoutes`; validate input; persist the actor, reason, and resolution timestamp; never let manual resolution create fill or balance records.**
- [ ] **Step 5: Run `NODE_OPTIONS= PATH=/home/creekz/.nvm/versions/node/v22.23.3/bin:$PATH node node_modules/tsx/dist/cli.mjs --test tests/shadow/live-execution-safety.test.ts tests/api/reconciliation_admin.test.ts tests/integration/e2e.test.ts`; confirm live and operator flows pass.**
- [ ] **Step 6: Commit** as `feat: gate live trading on reconciliation state`.

## Task 6: Full Verification and Readiness Documentation

**Files:**
- Modify: `documentation/production_readiness_todo.md`
- Modify: `documentation/operational_gameplan.md`
- Test: `tests/exchange/`, `tests/shadow/`, `tests/balance/`, `tests/migrations/`, and `tests/api/` changed in earlier tasks

- [ ] **Step 1: Run focused exchange/reconciliation/balance/API tests and lint.** Expected: all focused tests pass and `npm run lint` exits zero.
- [ ] **Step 2: Run the full serial Node 22 suite** with the repository’s established environment and coverage command; expected: zero failures, with any intentional skips called out.
- [ ] **Step 3: Review all adapter network paths and logs** to confirm secrets are not persisted/logged, failures are not converted to empty snapshots, and live trading is denied for incomplete capabilities or spot shorts.
- [ ] **Step 4: Update production readiness docs** to report exactly which exchange adapters have authoritative reads, which cases still require operator intervention, and any testnet/sandbox checks not run.
- [ ] **Step 5: Run `git diff --check`, commit** as `docs: record real exchange reconciliation readiness`, and request an independent whole-branch review before integration.
