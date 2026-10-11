# Real Exchange Reconciliation Design

**Status:** Approved design; implementation plan pending.
**Date:** 2026-10-11

## Outcome

Implement authoritative spot-order and fill reconciliation for Binance, Kraken, OKX, and Coinbase Advanced Trade. Recover persisted entry and exit intents only from authenticated, uniquely attributable exchange evidence. Apply recovered fills, position changes, realized PnL, balance settlement, and audit records idempotently and transactionally. Any unavailable, incomplete, stale, or ambiguous exchange state must leave the account blocked from new live exposure.

This closes the readiness gap where the connector trades through one private REST implementation while a second, mostly stubbed adapter is registered with the reconciliation engine. It also fixes the Coinbase Advanced Trade request/authentication mismatch found during API documentation review.

## Scope and constraints

- Support the four account-trading venues already exposed by the connector: Binance Spot, Kraken Spot, OKX Spot, and Coinbase Advanced Trade spot products.
- Preserve the custom REST integration and signing for Binance, Kraken, and OKX while adding the account reads and durable client-order correlation needed for recovery.
- Align Coinbase Advanced Trade authentication and order payloads with the current documented API while adding order/fill/account reads.
- Exclude derivatives, margin borrowing, and short positions. Live short entries must be denied for these spot adapters. Paper/shadow behavior remains available.
- Account balances alone do not identify bot-owned positions. A bot position is reconstructed from matched bot order fills; unrelated manual activity creates an incident and must not be silently adopted.
- Do not store API secrets or raw credentials in persistence or logs.
- Do not send automatic compensating orders or automatically retry an uncertain order submission.
- Existing intents that predate client-order IDs can be recovered automatically only by an exact unique order/fill match. An absent or ambiguous match remains unresolved for an operator.

## Architecture

Replace the separate `ExchangeConnector.ExecutionAdapter` and `BaseExchangeAdapter` roles with one typed account execution interface, implemented per venue and shared by order submission, account reads, and reconciliation. The interface exposes capabilities, authenticated account identity, order placement with a persisted client ID, lookup by client/exchange order ID, paginated open and historical orders, paginated fills, and spot balances. Canonical responses include venue-native order ID, client order ID, symbol, side, requested quantity, cumulative filled quantity, average fill price, normalized status, fill IDs, fee amount/currency, and exchange timestamps.

Each connector instance operates against one configured venue/account. Persist a stable non-secret account ID with every live intent and trade association. An explicit `EXCHANGE_ACCOUNT_ID` may name the logical account; otherwise derive a one-way fingerprint from venue, environment, and API key. Never use the secret as account identity. Account switching must select a different account scope. A reconciliation cycle is serialized per account.

The existing reconciliation engine becomes the orchestrator for the shared interface. It reads a complete venue snapshot and outstanding local intents, ingests fills idempotently, updates incident state, and blocks live entries when the account is not reconciled. Reconciliation will not equate a missing result from a failed request with an empty result.

## Venue API mapping

| Venue | Persisted client correlation | Authenticated recovery evidence |
| --- | --- | --- |
| Binance Spot | `newClientOrderId` | Query order/open orders, account trade list, and balances; normalize `tradeId`, executed quantity, quote quantity, commission, and commission asset. |
| Kraken Spot | `cl_ord_id` | Query open/closed/order details and trade history; normalize `txid`, trade IDs, executed volume, cost, and fee. Do not rely on non-unique `userref`. |
| OKX Spot | `clOrdId` | Query order details, open/history orders, fills history, and account balances; normalize `ordId`, `tradeId`, cumulative fill size, average price, fee, and fee currency. Keep the locally assigned identifier unique even though venue history lookup behavior is not a permanent uniqueness guarantee. |
| Coinbase Advanced Trade | `client_order_id` | Use current Advanced Trade JWT authentication and documented order-create payload; query historical orders, individual order detail, fills, and accounts. Normalize `order_id`, `entry_id`, `trade_id`, filled size/price, commission, and product ID. |

Venue-specific symbol translation, pagination, timestamp interpretation, rate limits, authentication, and error handling remain inside each adapter. A result is authoritative only after every required page for the requested reconciliation window has been read successfully. Keep a persisted per-account fill cursor/checkpoint and overlap the prior window so delayed venue updates are re-read safely. Respect each venue's history retention; old unresolved intents outside the authoritative query window require operator resolution.

## Persistence

Add a forward-only migration, with matching SQLite and PostgreSQL definitions, to:

- scope execution intents by venue and account;
- persist a stable local client-order ID, order purpose (`entry`/`exit`), and parent trade ID;
- store canonical cumulative fill state and last authoritative observation without overloading an entry order with its exit order;
- add an immutable fill ledger with a unique key on `(venue, account_id, exchange_order_id, exchange_fill_id)`;
- add durable account reconciliation state/checkpoints and unresolved incidents with timestamps, type, evidence references, status, and operator resolution metadata.

Preserve `shadow_trades` as the user-facing trade record, adding only fields needed to represent remaining quantity and accumulated realized PnL. Keep entry and exit intents separate and retain their exchange IDs. A forward migration must leave historical records intact. Legacy records without venue/account scope must not be assigned to an active account by assumption.

## State transitions and transactional settlement

Before any live submission, atomically claim an intent containing the client ID and scope. Send that exact client ID to the venue. On a response, store its exchange order ID and normalized state. On timeout or an indeterminate response, leave the intent unresolved and block same-account live exposure until authenticated lookup resolves it.

Process fills by stable exchange fill ID, not by repeatedly applying a cumulative order total. Insert each fill once and, in the same database transaction, update the intent, the trade's filled/remaining quantity and realized PnL, bot balance/principal reservation, and audit trail. A repeated or overlapping read therefore cannot settle the same fill twice. Partial entries reflect only filled quantity; remaining open order quantity remains explicit. Partial exits reduce remaining quantity and settle only the filled amount. A fully closed trade is marked closed only when authoritative fills account for its remaining quantity.

Only uniquely matched intent fills may automatically recover a local trade or update accounting. Unknown venue orders/fills, conflicting IDs, unexplained balance/quantity deltas, and ambiguous legacy matches create durable unresolved incidents. They never create synthetic bot trades or trigger orders automatically.

## Failure behavior and operator controls

- Authentication errors, pagination failures, rate limiting beyond bounded retry, malformed responses, stale snapshots, and venue outages invalidate that cycle. Do not advance checkpoints or clear blocks.
- Retry transient read failures with bounded backoff. Use venue-aware limits and prevent overlapping cycles for an account.
- Any unresolved account incident blocks new live entries for that account across risk modes. Existing confirmed positions may be monitored and risk-reducing behavior may continue only when the position and order state are authoritative; do not submit duplicate exits for unresolved exit intents.
- Add an authenticated, audited operator interface to list incident evidence and resolve an incident with a required resolution reason. A manual resolution changes incident/block state; it must not fabricate exchange fills or mutate balances without recorded evidence.
- Expose adapter capability health so a venue without complete authenticated reads cannot report live execution readiness. Live execution must fail closed when its configured venue cannot reconcile.

## Verification

- Unit-test each adapter's signing, required credentials, client ID propagation, status/fill/fee normalization, symbol mapping, pagination, rate-limit/transient errors, and malformed/error responses using mocked HTTP.
- Test the canonical engine for timeout-after-fill recovery, order-ID/client-ID matching, duplicate fills, partial entry/exit, restart replay, ambiguous/legacy intent handling, external unmatched activity, read failure, stale or incomplete snapshots, account isolation, and non-overlapping cycles.
- Test SQLite/PostgreSQL migrations, unique fill constraints, and transaction rollback when any settlement or audit operation fails.
- Test the authenticated operator API, role enforcement, required resolution reason, audit record, and account-specific live-entry blocking.
- Run focused exchange/recovery/balance tests, lint, and the full serial Node 22 suite. Testnet or sandbox smoke checks are separate, credential-gated operational checks and are not a substitute for deterministic tests.
- Completion requires all four configured spot venues to either provide authoritative reads and recover supported intents or refuse live execution with explicit capability errors; no unknown state may unblock exposure.

## Official API references

- Binance Spot REST security, request ordering, data sources, and rate-limit behavior: <https://developers.binance.com/en/docs/products/spot/rest-api>
- Binance client order ID semantics: <https://developers.binance.com/en/docs/products/spot/faqs/spot_glossary>
- Kraken Add Order (`cl_ord_id`), authenticated query order, and trade history: <https://docs.kraken.com/api-reference/trading/add-order>, <https://docs.kraken.com/api-reference/account-data/query-orders-info>, <https://docs.kraken.com/api-reference/account-data/get-trades-history>
- OKX order details, client order ID semantics, order/fill history: <https://my.okx.com/docs-v5/en/>
- Coinbase Advanced Trade Create Order, List Orders, and List Fills: <https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/create-order>, <https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/list-orders>, <https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/list-fills>

## Design decisions

- Implement the four adapters in this architectural phase rather than declaring one venue complete while the others remain stubs.
- Keep venue REST implementations and normalize them behind a single interface instead of introducing a new exchange SDK dependency.
- Use durable incidents for mismatches; never attempt automatic exchange-side compensation.
- Reconcile fills as immutable idempotent events and settle them transactionally.
- Treat spot balances as account-level context only, not ownership evidence for local trades.
