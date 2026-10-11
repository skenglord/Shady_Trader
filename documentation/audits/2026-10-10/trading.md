# Shady Trader core trading audit — confirmed findings

Read-only source audit of current checkout, 2026-10-10. Paths below are relative to `/home/creekz/Shady_Trader`. No repository source edits, live database mutations, or live orders. Tests used database query mocks, fake trades, and fake exchanges. Full suite belongs to parent audit.

## P1: Closing live positions can submit duplicate full orders and book P&L twice

Evidence: `backend/shadow/shadow_trader.ts:541-556` submits automatic close and returns false on any error, retaining the full position for next cycle. `:667-681` does the same for manual close; `:689-708` books P&L before an unconditional database update, and `:725` removes position only at the end. Manual route `backend/api/routes.ts:1112-1122` calls this method without a per-trade lock. The entry lock in `backend/main.ts:1273-1291` does not cover `updatePositions` at `:1297` or manual/kill closure. Kill repeats the same pattern at `backend/main.ts:850-889`.

Trigger: exchange fills close but response times out; next automatic cycle/manual retry sends the same full amount again. Also two simultaneous manual close requests both observe the open trade before either removes it. A partial fill likewise leaves the full original quantity for retry.

Impact: duplicate sell/buy, unintended inventory change or reverse exposure, double loss/profit booking, and balance corruption. Successful exchange fill followed by DB write failure is another retry window.

Isolated reproduction `/tmp/shady-core-audit.ts`: two timeout retries each submitted a 1 BTC close, with zero `execution_intents` writes. Two concurrent successful manual closes submitted two full 1 BTC orders and applied the loss twice. Both assertions passed.

Recommendation: durable per-trade close intent and unique exchange client order ID; atomically claim closing state and serialize all close entry points; query existing order on uncertain response, track remaining quantity, persist exactly one fill/accounting transition. Do not retry uncertain close blindly.

## P1: Pair switching values and closes every old position at the new pair's price

Evidence: `backend/main.ts:922-930` allows symbol switch without clearing/guarding old positions. `:1296-1297` passes the currently selected pair's price into `ShadowTrader.updatePositions`. `backend/shadow/shadow_trader.ts:602-626` iterates every mode/every trade with that same price; `:636-649` decides stop/close from it and `:548` submits a real order for the old trade's own symbol. Manual kill also applies one selected-symbol price across trades at `backend/main.ts:832-851`. Risk P&L repeats the cross-symbol error in `backend/risk/manager.ts:79-91`, selecting no symbol and using a single price.

Trigger: keep BTC/USDT buy position open, switch selected pair to ETH/USDT. ETH at $3,000 is compared to BTC entry $50,000 and stop $49,000.

Impact: erroneous live BTC stop/closure, wrong realized/unrealized P&L and risk halts. Can affect old simulated trades too.

Isolated reproduction: `updatePositions(3000,...,{symbol:'ETH/USDT'})` with an open live BTC position submitted a BTC sell and recorded -$47,033.30. Assertion passed.

Recommendation: fetch/use per-trade-symbol quotes and per-symbol candle clocks; restrict pair switching while live positions remain until supported; apply symbol-specific prices in daily P&L and kill.

## P1: Stop/kill cannot cancel an entry already inside async processSignal

Evidence: `backend/main.ts:822-824` stops engine and invalidates cycle token via `:504-506`. `runShadowAndLiveStage` checks token before invoking processSignal at `:1278`, then only after the entire awaited call at `:1288`. Inside `backend/shadow/shadow_trader.ts:242` entry awaits external cost estimation, `:362-376` awaits DB writes, and `:380` sends order without any cancellation token/check. `killBot` immediately starts closing known in-memory positions after `stop()` returns at `backend/main.ts:829-850`; pending/new entries are absent until `shadow_trader.ts:403`.

Trigger: stop/kill while entry is awaiting slippage estimation or intent/trade persistence; that call resumes later.

Impact: live entry can be sent after stop/kill, possibly after kill finished returning funds and reported all positions closed. Stop also sets cycleInProgress false before existing cycle ends, enabling overlapping work on immediate restart.

Isolated `/tmp/shady-lifecycle-audit.ts`: blocked the active mode's cost estimator, marked stop while it awaited, then resumed; fake live exchange received a new entry after stop. Passed. This directly verifies missing internal cancellation; the kill ordering is verified by source.

Recommendation: pass cancellation state into execution, recheck immediately before live order submission/intent claim, retain and await in-flight cycle promise during stop/kill, reconcile outstanding intents before kill result. After submission, finish safe reconciliation/accounting instead of abandoning the result.

## P1: Registered reconciliation adapters never read real positions; uncertain entries have no recovery

Evidence: `backend/exchange/connector.ts:103-115` registers `ExchangeAdapterFactory`'s old BaseExchangeAdapter with the reconciliation engine while using a separate `createExecutionAdapter` to actually trade. Every old adapter has stub `getPositions` returning `[]`: `backend/exchange/adapter.ts:177-180`, `:261-263`, `:331-333`, `:400-402`. Reconciliation compares this invented empty exchange state at `backend/exchange/reconciliation.ts:68-89`, and only logs recommendations `:131-170`. Its local query excludes pending/submitted/uncertain intents at `:120`, and it never updates execution_intents. `backend/shadow/shadow_trader.ts:46-52` globally blocks entries on unresolved intent; `:149-178` reloads open trades only, omitting pending positions.

Trigger: any successful live trade, or accepted order whose fill response/DB update is uncertain.

Impact: false missing-position reports for healthy live positions; exchange-only/pending positions never discovered; uncertain entry can remain unprotected and block all modes forever, including after restart. The process may retain no in-memory position to stop/close.

Reproduction: directly called all four registered adapter implementations with dummy credentials; each immediately returned `[]` with no request. Passed. No actual account positions were inspected.

Recommendation: wire reconciliation to real authenticated order/account reads of the active execution adapter, recover outstanding intents/order IDs, restore confirmed filled positions, expose explicit unresolved state, and only clear block after definitive exchange evidence. Scope local quantities to exchange/account (query currently ignores exchangeName at `reconciliation.ts:114-123`).

## P1: Accepted Kraken orders always fail strict fill confirmation

Evidence: `backend/exchange/connector.ts:776-780` returns `status:'open'` on every accepted Kraken AddOrder response and sets `filled:amount` without querying a fill. `backend/shadow/shadow_trader.ts:26-31` accepts only `filled`/`closed`, so `:380-396` always classifies an accepted Kraken entry uncertain. Live close also rejects that response and retains position, compounding duplicate-close bug. No follow-up order-status reader is in the execution adapter. OKX/Coinbase similarly consume immediate placement response as if it were a fill snapshot; Kraken is independently verified without relying on external API docs.

Trigger: accepted Kraken market order, including otherwise successful fill.

Impact: accepted order exists on exchange but local open position is not admitted; global unresolved-intent halt and missing protective exits. Close may repeatedly submit despite acceptance.

Reproduction: mocked CJS Axios POST to `{error:[], result:{txid:['accepted-order-id']}}`; directly called execution adapter without constructing connector. Result was `open` plus fabricated full quantity; strict status acceptance false. Passed with a hard HTTP/HTTPS request guard.

Recommendation: treat placement as acknowledgement, persist exchange order ID before fill validation, query/poll/subscribe until terminal fill, use actual filled quantity/weighted price/fees, handle partial fills and uncertainty explicitly.

## P1/P2: Runner exits create profit and shrink quantity without an exchange order or durable position update

Evidence: `backend/shadow/shadow_trader.ts:441-469` runner branch calculates partial profit, immediately credits portfolio, subtracts quantity and marks isRunner; no exchange object/order is used and no shadow_trades amount/isRunner/stop update is persisted. `:629-630` invokes this on live trades as well. `:619` calculates full original-quantity P&L before `:630` changes trade.amount, then may use that original P&L for the remainder at `:648-649`, double counting a partial profit if early exit/expiry fires in that same update.

Trigger: runner-enabled buy reaches trigger profit. Default runner modes have leverage >1 and are live-entry blocked; live manifestation requires saved/custom risk config with runnerEnabled and leverage1, or an existing legacy live position. Simulated modes hit this by default.

Impact: live base inventory stays full while local quantity shrinks; eventual close leaves residual real exposure. Restart restores original amount/stop from DB and forgets partial realized P&L; daily loss accounting ignores partial realized results. Even simulation statistics are inconsistent.

Reproduction: runner-enabled live aggressive position with leverage1 and 1 BTC at $50,000, update at $51,000: local amount became 0.4, isRunner true, portfolio profit credited, 0 exchange calls, 0 shadow position UPDATEs. Passed.

Recommendation: implement partial exit through the same durable execution/fill lifecycle as full close; await balance mutation, persist remaining amount, stop, runner state, and realized partial P&L atomically; recompute remainder P&L after mutation.

## P1/P2: Concurrent balance writes lose reservations/results; closure does not await settlement

Evidence: `backend/balance/manager.ts:61-74` reads row then replaces all fields without transaction/version/atomic deltas. addActiveTrade does another read and absolute replacement `:156-167`, as does recordTradeResult `:131-150`. Two async operations can read the same prior balance and overwrite one another. Closure invokes balance settlement without await at `backend/shadow/shadow_trader.ts:452-454`, `:571-574`, `:698-700`, so API/update loop can finish/continue before funds are settled, and rejection escapes closure handling.

Trigger: simultaneous close/withdraw/reserve, parallel API operations, or multiple closes in an update cycle while fire-and-forget settlement is still running.

Impact: missing reservation/P&L, fictitious available balance, stale result in API/broadcast, failed settlement after position is marked closed. Clamping activeTradeBalance to 0 at `balance/manager.ts:135` also masks duplicate settlement rather than enforcing accounting integrity.

Reproduction: Promise.all reservations $1,000 and $2,000 from a $10,000 bot balance with mocked row storage ended bot_balance $8,000 / active_trade_balance $2,000, dropping the $1,000 reservation. Passed.

Recommendation: atomic transactional SQL deltas with funds predicates and unique settlement IDs; couple position state and balance update in same transaction; await all balance mutations.

## P2: Changing symbol/timeframe does not invalidate old work

Evidence: `backend/main.ts:913-931` setters change configuration then call runCycle, without incrementing cycleAbortToken. `:1360-1363` skips the requested fresh cycle while the old one is in progress; all subsequent abort guards accept old token because `:935` only tests isRunning/token. Therefore already generated/fetched old-symbol/old-timeframe work can place a trade after user switched. This contradicts AGENTS description but was checked against source independently.

Reproduction: used TradingEngine prototype with inert state/broadcast/exchange/runCycle stubs; called both setters. cycleAbortToken stayed 0 and `abortCycleIfNeeded(0,'old_cycle')` returned false. Passed.

Recommendation: invalidate configuration generation before changing settings, await safe in-flight completion/cancellation, and schedule fresh work only after old cycle retires. Do not clear overlap guard from an old cycle after a newer cycle starts.

## P2: Loss streak halt cannot recover by trading and is erased by restart

Evidence: `backend/risk/manager.ts:247-255` initializes empty streaks; init/loadConfigs `:273-288` restores config only. `:311-315` updates loss count in memory and reduces size; `:508-513` returns a halt reason at five losses. `backend/shadow/shadow_trader.ts:80-85` treats that reason as reject every new trade, so documented recovery wins cannot occur after portfolio flat. Win recovery `risk/manager.ts:317-346` also zeros losses before partialRecovery reads loss tier. Restart instantiates fresh RiskManager and bypasses streak.

Reproduction: recordLoss five times caused reduced size and non-null halt; newly constructed RiskManager reported zero consecutive losses. Passed. Reconstruction from history is absent by source inspection.

Recommendation: choose/persist intended halt vs reduced-size behavior explicitly, restore loss/recovery state from ordered confirmed closed results or persistent state, provide documented recovery condition, preserve tier while applying recovery.

## Additional source-confirmed limitations to consider

- `/settings` accepts arbitrary non-blocklisted keys (`backend/api/routes.ts:540-549`) and directly calls loadSettings (`:1057-1074`). loadSettings bypasses the `/active-mode` live-position guard (`main.ts:624`, compared with `routes.ts:1375-1376`) and replaces execution exchange at `main.ts:676-683`. Trades persist no owning exchange/account; subsequent exits use this newly selected exchange. This can send old-position closes to the wrong venue/account and leave original exposure open. No API-level reproduction performed.
- Actual fill price/fees are ignored: entry persists simulated computeFill price before submission (`shadow_trader.ts:325-376`); on successful order it updates only statuses/order ID (`:380-388`). Closes likewise compute simulated P&L from candle price rather than returned fill (`:548-581`, `:674-708`). Live accounting will diverge from exchange even with successful fills.
- Current cycle `broadcastCycleStage` omits await for async getPerformance (`main.ts:1333`), caching/spreading a Promise and broadcasting it (`:1334`,`:1343`) as empty JSON data. Cosmetic performance failure, not a primary execution finding.
- maxDailyTrades is configured in each default risk mode (`risk/manager.ts:113` etc.) but validateTrade (`:476-487`) never checks/enforces it. No full-day test performed.

## Verification and isolation record

- `/tmp/shady-core-audit.ts`: 7 independent mocked scenarios passed, exit0 using tsx under temporary escalation needed for CLI IPC socket sandbox restriction. Initial sandbox invocation failed before script ran.
- `/tmp/shady-lifecycle-audit.ts`: 3 scenarios passed, exit0 using Node22 `--import tsx`, `LOG_DIR=/tmp/shady-audit-logs`, fake credentials and HTTP/HTTPS guard. Final run made no HTTP requests.
- Initial core test's logger automatically appended several clearly marked mocked audit messages to existing `logs/trading-system.log` because LOG_DIR was unset. No DB/order/source mutations occurred; later runs direct logs to /tmp. Log lines were not removed to avoid modifying operational history.
- First Kraken mock accidentally patched a different ESM Axios instance; CJS Connector attempted one request with dummy API key/signature to api.kraken.com, which failed DNS (ENOTFOUND) before reaching exchange. No live credentials or orders; corrected to same CJS Axios instance and hard network guard before successful rerun. Treat this as a failed harness attempt, not exchange verification.
- No market/exchange API behavior claims independently browsed; Kraken finding follows adapter's own deterministic status branch. No live account/database inspected, no full suite run, no race/load test against real Redis/exchange.
- AGENTS.md read, including mandatory documentation-update instruction; parent's explicitly read-only scope takes precedence, so no repo documentation changes performed.
