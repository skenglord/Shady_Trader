# Live system review — 12 October 2026

**Verdict: suitable for supervised defect discovery; not ready for trustworthy paper-performance evaluation or live funds.** Real market prices reach the dashboard, but accounting, candle persistence, risk valuation, order simulation and dashboard updates have reproducible defects. The running configuration also omits parts of the advertised system.

Reviewed commit: `52fdae370fcaa9abfa81956ca30b30ff14155e50`. Source: `/home/creekz/Shady_Trader`; running human-test clone: `/tmp/shady-trader-human-test`; app: `http://127.0.0.1:3000`. Node 22, SQLite, BTC/USDT, 15m, configured provider CoinGecko, live execution disabled. This review changes documentation only.

## Evidence and scope

Live API/public-provider captures were taken on October 11 around 22:19 UTC and October 12 around 11:51 UTC. These are two observation windows, not a continuous overnight soak test. Chromium exercised the actual authenticated desktop dashboard, incoming WebSocket messages, ML/Freqtrade panels and a 390px viewport without API mocks. Trading defects were reproduced separately using production methods with mocked trade persistence and/or in-memory SQLite. No credentialed exchange orders or manual orders in the running app were submitted.

- [Live endpoint snapshots](audits/2026-10-12/live-snapshots.json), including timestamps, URLs and HTTP status.
- [Original candle comparison and database rows](audits/2026-10-12/comparison.json) and [refreshed comparison](audits/2026-10-12/comparison-refreshed.json).
- [Accounting reproduction results](audits/2026-10-12/accounting-repros.json) and [exact harness](audits/2026-10-12/accounting-repros.ts.txt).
- [Browser evidence](audits/2026-10-12/browser-summary.json), [desktop screenshot](audits/2026-10-12/dashboard-desktop.png), [mobile screenshot](audits/2026-10-12/dashboard-mobile.png).
- [Evidence collection instructions and limitations](audits/2026-10-12/README.md).

P1 means a blocker for trusting trading/accounting/data results; P2 means a material workflow or operational defect. “Live” refers to observed app behavior. “Isolated” means a production-method reproduction, not a real trading event. “Source” identifies a code path that was not exercised end to end.

## Findings

### 1. P1 — Runner partial exits credit profit twice in the same cycle

**Isolated reproduction:** one unit bought at 100, marked at 102, using the default aggressive configuration and 2x leverage, with fees/slippage zeroed for transparent arithmetic. Expected total profit: **2.00**. Actual portfolio increase: **3.20**. The partial settlement credits 1.20, then the remaining close credits the original full-position profit of 2.00.

`backend/shadow/shadow_trader.ts:754` computes P&L before `evaluateRatchet` reduces the amount at lines 493–506. The subsequent early-exit closure at lines 782–784 reuses that P&L. The normal runner and early-exit thresholds can both fire on one update. This invalidates comparative returns even when prices are correct.

**Acceptance:** partial plus final realized P&L must equal the total executed quantity's economic result; recompute remaining-position state after a partial fill and cover same-cycle partial/exit ordering. Also persist partial quantity, runner and stop changes: source inspection shows these changes are in memory while `loadState` at lines 195–205 reconstructs them from the original row after restart. Restart behavior was not reproduced here.

### 2. P1 — Switching the active paper mode breaks wallet ownership

**Isolated reproduction with staged entry state:** a 1,000 wallet reserves 100 for an active moderate trade; an aggressive shadow-only trade has not reserved funds. Change the active mode to aggressive and close both flat. Closing the old active trade leaves its 100 reserved. Closing the previously shadow-only trade credits its 200 principal. Final wallet: **1,100 instead of 1,000**, with reported P&L zero.

Entries reserve according to the active mode (`shadow_trader.ts:458`), while closures decide wallet ownership using the mode active at closure (`:675`). `backend/api/routes.ts:1411` prevents switching only when live positions exist. `backend/balance/manager.ts:154` clips insufficient reserved balance to zero while crediting the whole supplied principal. Atomic transactions preserve this incorrect arithmetic; they cannot establish ownership.

**Acceptance:** persist wallet/reservation ownership per trade; settle that reservation once regardless of later mode changes; reject excess releases. Verify mode switches, partial closes and restart with balance conservation. This fixture stages the entry ownership and uses actual close and balance code; it is not an end-to-end entry test.

### 3. P1 — A completed candle was served with an unfinished close and volume

**Live reproduction:** the BTC/USDT 15m candle starting **2026-10-11 22:00 UTC**, complete at 22:15, differed when captured at 22:19:

| Field | App and persisted SQLite | Finalized Binance |
| --- | ---: | ---: |
| High | 83,575.34 | 83,650.01 |
| Close | 83,570.01 | 83,622.01 |
| Volume | 26.18655 | 77.80253 |

Eight other completed bars matched exactly. The original app result contained 986 consecutive 15m candles, with no duplicate timestamps or invalid OHLC envelopes. Validation of shape alone therefore misses this error.

`backend/exchange/connector.ts:860` persists provider candles with `INSERT OR IGNORE`, so an initially unfinished row cannot be corrected by subsequent provider snapshots. Lines 872–899 return stored candles without a freshness/finality gate when providers do not supply enough data. The persisted wrong row is directly observed; the exact fallback branch taken by that individual HTTP request was not instrumented.

**Qualification:** the October 12 sample matched all nine newly compared completed bars, and the previously wrong 22:00 candle was correct in the refreshed API result. The defect is intermittent and storage-related; this is not evidence that all live prices are wrong. No refreshed database dump was taken to claim that the underlying row had repaired itself.

The comparison uses candle open time and the OHLCV fields described in [Binance's market-data reference](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market). Unfinished candles were excluded; Kraken also explicitly identifies its last OHLC entry as an unfinished interval in its [OHLC documentation](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).

**Acceptance:** update unfinished rows through finalization, retain provider/pair/timeframe provenance, reject stale data for trading, and compare stored finalized candles against provider truth after an outage and restart.

### 4. P1 — Daily-loss checks value every open symbol at the selected symbol's price

**Isolated reproduction:** one unchanged BTC long of one unit entered at 50,000 is evaluated with the selected ETH price of 3,000. Expected unrealized loss: **0**. Actual daily loss: **47,000**.

`backend/risk/manager.ts:79` selects all open trades for a mode without selecting their symbols, then values each with one `currentPrice` at lines 89–91. `shadow_trader.ts:62` supplies the entry symbol's price. Earlier per-symbol fixes in position updates do not cover this separate risk gate. Depending on holdings, this can create a false loss or hide a real one.

**Acceptance:** mark each open position with its own fresh symbol price, fail closed on unavailable marks, and verify mixed-symbol portfolios in both loss directions.

### 5. P1 — Paper limit orders can fill beyond their limit

**Isolated reproduction:** asks contain one unit at 100 and one at 110. A buy limit of 100 for two units fills both at average **105**. At most the first unit qualifies at that limit.

`backend/paper-trading/order-book.ts:198` checks whether any level crosses, then calls unrestricted `matchMarketOrder` at line 209. The remaining sweep ignores the limit. Paper execution costs and strategy profitability are consequently unreliable.

**Acceptance:** filter every fill by the order limit, preserve partial quantities and implement the requested time-in-force semantics; verify depth depletion across competing orders. IOC/FOK and shared-depth concerns are source findings, not separate runtime reproductions in this review.

### 6. P1 — Paper liquidation applies leverage twice

**Isolated reproduction:** a one-unit long entered at 100 with 10x leverage is liquidated at 99. Initial margin is 10, loss is 1 and remaining equity is 9. This is far above the model's 0.5% maintenance requirement.

`backend/paper-trading/position-tracker.ts:201` already divides loss by margin, then compares that ratio against `1 / leverage - maintenance` at line 205. The denominator and threshold both apply leverage. The previous profitable-position liquidation fix does not cover premature liquidation of losing positions.

**Acceptance:** compare equity against maintenance on a consistent notional/margin basis. Cover leverage levels, long/short, fees, maintenance boundary and profitable positions. Real venue liquidation rules need separate adapter-specific validation.

### 7. P2 — Paper REST uses a service disconnected from market depth

**Live observation:** authenticated `GET /api/paper/orderbook/BTC%2FUSDT` returns 404, “Symbol not found,” while market candles work. **Isolated reproduction:** a trade on the controller's default service construction throws “Live market depth is unavailable; paper order was not accepted.”

`backend/paper-trading/paper-trading.controller.ts:8` creates `new PaperTradingService()` with no exchange getter. `backend/main.ts:301` creates a different instance with `() => this.exchange`. `paper-trading-service.ts:199` rejects creation without that getter. REST and the connected engine service do not share the same paper account.

**Acceptance:** inject one owned service into REST and WebSocket consumers, then verify orders, fills, positions and summaries agree through both interfaces. No running-app POST order was needed for this finding.

### 8. P2 — WebSocket updates erase the dashboard's portfolio performance

**Live reproduction:** REST returns all six portfolios, each with its 100,000 starting balance. Three received WebSocket frames contain `{"type":"performance","data":{}}`. The dashboard then displays “No performance data yet” with no portfolio rows.

`backend/main.ts:1313` does not await async `getPerformance()`. Its Promise serializes to an empty object when broadcast at line 1323. `src/App.tsx:207` replaces the populated state with that object. The try/catch also cannot handle an asynchronous rejection in the intended way.

**Acceptance:** resolve the snapshot before caching/broadcasting, handle rejection, and verify multiple actual cycles preserve the REST-visible portfolios.

### 9. P1 — Fallback candles can silently change symbol or resolution

**Source findings, not live provider-switch reproductions:**

- `backend/exchange/provider-rotator.ts:331` maps unlisted intervals, including the UI's 4h interval, to 1h for Binance; the CoinAPI map does the same.
- `backend/exchange/connector.ts:630` passes minute-sized aggregation values to CryptoCompare's `histoday` endpoint.
- `backend/api/routes.ts:40` maps SOL/USDT to Bitcoin in its CoinGecko fallback. Lines 70–76 return provider candles without resampling to the requested timeframe.
- `provider-rotator.ts:348` returns CoinGecko OHLC with zero volume and unchecked interval spacing. Volume-dependent indicators do not distinguish absent volume from observed zero activity (`backend/indicators/engine.ts:43`, `:191`).

These paths can produce plausible-looking charts and indicators for a different instrument or time horizon. The audited successful Binance BTC/USDT 15m sample does not clear them.

**Acceptance:** validate symbol, quote currency, interval spacing, volume availability and age at the connector boundary. Aggregate only from a suitable finer resolution; return explicit unavailability when the requested series cannot be produced. Add provider-outage tests for every supported symbol/timeframe combination.

### 10. P2 — The UI overstates freshness and has unsafe cache identity

**Live:** provider health reports active Binance while the dashboard labels the feed “API: Coingecko.” On October 12, global market data's `last_updated` was still October 11 22:48:56 UTC, approximately **13 hours old**. The three news entries retained identical October 11 22:03:54 timestamps and included a pharmaceutical headline and placeholder `#` links. The global summary's last-update field is not exposed beside its numbers.

**Source:** `src/App.tsx:271` labels the configured exchange rather than the active source. News normalization at `backend/api/marketDataService.ts:143` discards the already-normalized publisher/timestamp from lines 109–115, substituting generic source and ingestion time for that provider path.

The captured candle response also sets `Cache-Control: public, max-age=3600` (`routes.ts:935`). `ChartPanel.tsx:447` keys its request by history only, while the server uses mutable engine symbol/timeframe. `src/api/client.ts:62` adds a URL-only application cache. Symbol changes at the same timeframe can reuse the same URL; timeframe changes often use different history parameters, so they do not all share one key. Browser reuse after a symbol switch was not exercised in this review.

**Acceptance:** show actual source, data age and degradation; preserve publication timestamps; key candle requests/cache by immutable symbol/timeframe/provider parameters and separate mutable current bars from finalized history.

### 11. P2 — Mobile controls overflow the viewport

**Live reproduction:** a 390px viewport produces a **1,282px document width**. Engine controls extend into a large white area beyond the page's dark background. The [screenshot](audits/2026-10-12/dashboard-mobile.png) shows the practical impact on trading controls and tables.

The header at `src/App.tsx:260` and control row at line 267 use horizontal flex without a mobile layout. Chart controls and tables also require responsive containment.

**Acceptance:** verify 390px and tablet layouts with all controls reachable, no document-level horizontal overflow, and intentional local scrolling where tables require it.

## Operational appraisal

| Capability | Observed result | Interpretation |
| --- | --- | --- |
| Core HTTP/SQLite/engine | Liveness and readiness 200; engine running; 338 stored signals in refreshed response | Core loop is active; signal generation does not prove profitable or correct execution |
| Public market access | October 11: Binance, Kraken, OKX and Coinbase returned 200 | Four public venues were reachable; account/order adapters were not exercised |
| Refreshed public access | October 12: Binance, Kraken and Coinbase 200; OKX connection failure | Do not claim all four venues remained reachable |
| Provider rotation | Binance active; CoinGecko circuit open; refreshed Binance counters 878 successes / 9 failures | Useful fallback behavior; configured and actual provider differ |
| Access control | Three selected protected endpoints returned 401 without credentials; no pre-auth browser API requests | Positive regression evidence, not a complete penetration test |
| Browser runtime | No page errors or failed API responses during authenticated browser capture; WS authenticated | Frontend boot works; performance and mobile workflows still fail |
| Redis | Readiness returns 200 with `redis: degraded` | Queue/distributed-service readiness is not established |
| Freqtrade | `/api/freqtrade/info`: `installed: false` | Freqtrade research/backtest workflow was not operational in this clone |
| ML | Diagnostics: `enabled: false`, `modelsReady: false` | No live ML quality or inference claim is supported |
| Diagnostics latency | Refreshed readiness 5.43s; health diagnostics 8.03s | Slow operational checks need bounded dependency probes |
| Executed performance | No open positions; wallet P&L zero; six REST portfolios show zero trades | No real-world profitability, slippage or fill-quality evidence |

The diagnostics aggregate error rate includes earlier unauthorized requests and is not interpreted as a 95% server outage. Datadog injection/socket warnings belong to the review environment. An intentionally nonexistent `/api/paper/orders` route and an admin endpoint requested with a trader token were excluded from defects.

## Recommended next phase and exit criteria

1. **Repair accounting and risk invariants first:** runner settlement, durable reservation ownership, per-symbol daily marks, limit matching and liquidation. Turn the isolated fixtures into focused assertions, then add persistence/restart cases. Keep live execution disabled.
2. **Repair the data contract:** finalized-candle upserts, stale-data gates, explicit provenance and exact symbol/timeframe fallback behavior. Replay recorded real candles through outage/recovery and compare database, REST and WS values.
3. **Unify paper service ownership and repair visibility:** shared REST/WS account, awaited performance snapshots, correct cache identity and provider/age indicators, responsive operator controls.
4. **Bring up the intended full stack and validate it:** Redis plus queue workers, Freqtrade and explicitly configured ML. Distinguish optional features from required readiness checks. Run real-data paper lifecycle and restart tests before exchange sandbox execution.
5. **Retain the earlier release gates:** native credentialed sandbox reconciliation for each supported exchange, external/unsupported-symbol recovery, third-asset fee valuation, deployment/restore validation and remaining dependency/CLI debt from the [readiness tracker](production_readiness_todo.md).

Earlier green suites are historical checks with missing scenarios, not evidence against these reproductions. The full suite and dependency audit were not rerun for this documentation-only review. No findings above are marked repaired.

Publication verification later on October 12: the serial Node 22 suite reported 617 tests, 616 passed, 0 failed and 1 skipped; whole skipped suites remain. Root lint and production frontend build passed. These checks do not clear the live/isolated findings above, and the dependency audit was not repeated. All local work-branch commits were already included in main before publication.
