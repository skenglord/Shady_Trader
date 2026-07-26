---
title: "ASTS — Verified Gap Register (G-001..G-076)"
programme: ASTS-HARDENING
baseline_sha: "63f1ecc0a2a90b8035cd8773e897e0953577c523"
total_gaps: 76
verified: 35
okf_refs: ["risks/index.md"]
---

# Verified Gap Register

76 gaps: the original G-001…G-075 plus **G-076** (new, found during verification). Every row carries a
verification status. **Anchors marked CONFIRMED were read from source at baseline `63f1ecc0a2a90b8035cd8773e897e0953577c523`.**

## How to read this

| Status | Meaning | What you must do |
|---|---|---|
| **CONFIRMED** | Read from source; anchor is exact | Use the anchor directly |
| **PARTIAL** | Real, but differently shaped than described | Read the note — the fix differs from the original wording |
| **CLOSED** | Fixed by PR #14 | **Do not create a task.** See [`risks/closed-by-pr14.md`](okf/risks/closed-by-pr14.md) |
| **UNVERIFIED** | Plausible, not individually checked | **Verify first**, record the anchor, then fix. If absent → block |

> ⚠ **Never fabricate a line range.** If a gap says UNVERIFIED and you cannot find the defect, block with
> `clarification-required:`. A wrong anchor sends an automated agent to edit the wrong code.

## Root-cause clusters — the actual planning unit

The 35 verified gaps collapse into **six root causes**. This is the most important insight in this
document: the flat 76-row list implies 76 independent tasks, but many gaps are the *same defect observed
from different angles*. Assigning them as separate parallel tasks would produce competing partial patches
to the same file and guarantee edit conflicts.

| Cluster | Gaps | Single owner | OKF concept |
|---|---|---|---|
| **C1 — Exchange as side effect** | G-001, G-002, G-004, G-014, G-028, G-068 | `execution-oms` | [`exchange-as-side-effect`](okf/risks/exchange-as-side-effect.md) |
| **C2 — Parallel indicator pipeline** | G-017, G-018, G-019, G-020 | `indicator-validation` | [`parallel-indicator-pipeline`](okf/risks/parallel-indicator-pipeline.md) |
| **C3 — Starved history chokepoint** | G-016, G-021, G-022 | `market-data` → `regime-research` | [`starved-history`](okf/risks/starved-history.md) |
| **C4 — No safe-fail init** | G-007, G-033, G-041, G-042 | `architecture` → `database` | [`init-fails-open`](okf/risks/init-fails-open.md) |
| **C5 — Database abstraction leak** | G-037, G-038, G-039, G-040 | `database` | [`database-abstraction-leak`](okf/risks/database-abstraction-leak.md) |
| **C6 — Stale shared state** | G-026, G-027, G-029 | `execution-oms` | [`shared-state-races`](okf/risks/shared-state-races.md) |

**Ordering constraint inside clusters:** C3 must fix G-016 *first* — calibrating regimes (G-021, G-022) on
starved history is meaningless. C1 must be one sequenced workstream, not six parallel edits to
`shadow_trader.ts`.

---

## P0 — Live-blocking (15)

| ID | Status | Gap | Verified anchor | Remediation |
|---|---|---|---|---|
| G-001 | **CONFIRMED** ⚠*worse* | Internal close succeeds when exchange close fails | `backend/shadow/shadow_trader.ts:419-436` | Ledger is credited at :420 *before* the exchange call; failure at :427 only logged; falls through to `status='closed'`. Confirm fill or zero position **before** any ledger write |
| G-002 | **CONFIRMED** | Live entry failure leaves active shadow-like trade | `backend/shadow/shadow_trader.ts:251-263` | Catch says "continue with the shadow trade"; `openTrades.push` unconditional. Separate `shadow`/`live_pending`/`live_open`/`live_failed` |
| G-003 | **CONFIRMED** *(nuanced)* | No authoritative reconciliation loop | `backend/exchange/reconciliation.ts:15`; `connector.ts:109`; **zero** `reconcil*` in `main.ts` | Engine class exists but is never wired to lifecycle. Add startup + continuous reconciliation |
| G-004 | **CONFIRMED** ⚠*worse* | Leveraged PnL understated | `backend/shadow/shadow_trader.ts:470-483` | `pnl=(amount×Δprice)/leverage` — divided, not multiplied. 9× understatement at 3×. Contract-correct formula + fixtures |
| G-005 | **CONFIRMED** | Sizing from simulated portfolio | `backend/balance/manager.ts:52`; `shadow_trader.ts:79` | `?? 100000` default; `reset()` hard-codes 100000. Size from verified live equity |
| G-006 | **CONFIRMED** | Daily loss passed as zero | `backend/shadow/shadow_trader.ts:136-137` | Literal `const dailyLoss = 0`. Breaker at `risk/manager.ts:456` is dead code. Compute from ledger |
| G-007 | **CONFIRMED** | Restored trades reset at startup | `backend/main.ts:692`; `shadow_trader.ts:75-81` | `start()` calls `reset()` after `loadState()`. Remove from startup; admin-only |
| G-008 | UNVERIFIED | Kill path clears state even if closes fail | `backend/main.ts` *(kill path)* | Reduce-only close, fill confirmation, retries. **Verify first** |
| G-009 | **CONFIRMED** | Entire main balance auto-allocated | `backend/main.ts:697-700` | Unconditional `allocateToBot(mainBalance)`. Explicit cap + operator approval |
| G-010 | **CONFIRMED** *(architectural)* | Final effective-risk cap not applied to every order | `backend/risk/manager.ts:44, 383` | No stored `RiskDecision` referenced at submission. Centralise the gate |
| G-011 | UNVERIFIED | Live trading continues without slippage controls | `backend/slippage/` | Must fail closed for active mode. **Verify first** |
| G-012 | UNVERIFIED | AI can increase risk mode / select Degen | `backend/ml/gemma_adjuster.ts` | Advisory-only + deterministic transition matrix. **Verify first** |
| G-013 | UNVERIFIED | Candidate config saved before validation | `backend/optimization/` | Validate + canary before atomic promotion. **Verify first** |
| G-014 | **CONFIRMED** | Partial exit updates shadow without live reduction | repo-wide: no `reduceOnly` | Submit and confirm reduce-only partial first |
| G-015 | UNVERIFIED | No exchange-native stop/target | `backend/exchange/adapter.ts` | Verified protective orders or redundant watchdog. **Verify first** |

## P1 — Quality and correctness (40)

| ID | Status | Gap | Verified anchor | Remediation |
|---|---|---|---|---|
| G-016 | **CONFIRMED** | 200 candles fetched for 672/2880-candle features | `backend/main.ts:918`; `regime/detector.ts:199-200` | Timeframe-aware minimum history. **Fix before G-021/G-022** |
| G-017 | **CONFIRMED** | Worker warm-up overlap on wrong side | `backend/indicators/engine.ts:103-112` | Prepend historical warm-up, then trim |
| G-018 | **CONFIRMED** | Parallel merge ignores global offsets | `backend/indicators/engine.ts:137-151` | Merge by candle timestamp |
| G-019 | **CONFIRMED** | Serial and parallel minimums differ | `engine.ts:98` vs `:155`, `:265` | One canonical warm-up contract |
| G-020 | **CONFIRMED** | WaveTrend denominator / alignment | `backend/indicators/engine.ts:22-26` | Clamp denominator; preserve offset for `wt1`/`wt2` |
| G-021 | **CONFIRMED** | Missing RSI treated as zero | `backend/regime/detector.ts:216` | `(row.rsi_14 \|\| 0)` — average finite values only |
| G-022 | **CONFIRMED** | Confidence uncalibrated | `backend/regime/detector.ts:248-294` | Literals 95/85/80/70/50. Rename to score, or calibrate OOS |
| G-023 | UNVERIFIED | Volatility override ordering weak | `backend/regime/detector.ts` | Apply volatility to confidence/sizing explicitly |
| G-024 | **CONFIRMED** | Timeframe durations hard-coded | `connector.ts:407,584,665,693`; `main.ts:1380` | Central timeframe registry |
| G-025 | **CONFIRMED** | Same unfinished candle → repeated trades | `main.ts:1173-1178`; `database.ts:226-240` | Closed-candle gate + DB unique key |
| G-026 | **CONFIRMED** | Symbol-only lock insufficient | `backend/execution/executionLock.ts:42` | `trade_lock:${symbol}` → candle/strategy/idempotency lease |
| G-027 | **CONFIRMED** | One price applied to all trades | `backend/shadow/shadow_trader.ts:456` | Route symbol-specific prices; lock position mutation |
| G-028 | **CONFIRMED** | Fees/funding/slippage not applied | `backend/shadow/shadow_trader.ts:479-483` | Fields stored but never subtracted. Central fill-based ledger |
| G-029 | **PARTIAL** | Collateral not reserved | `backend/shadow/shadow_trader.ts:244-267` | Check exists at :246 vs snapshot from :127; deduct at :266 *after* `placeOrder` → **TOCTOU**, not absence |
| G-030 | **PARTIAL** | Stop loss `4.0` vs `0.04` semantics | `risk/manager.ts:154, 383`; `shadow_trader.ts:206` | Consumer divides correctly. Real defect: `calculatePositionSize` takes an absolute-price `stopLoss` and **ignores** it |
| G-031 | **CONFIRMED** | Degen dollar-risk cap omits leverage | `backend/risk/manager.ts:44` | `equity*finalSize*stopDistanceFrac`; 3× under-count |
| G-032 | **CONFIRMED** | Prior loss count reset before read | `backend/risk/manager.ts:273-292` | `recordWin` zeroes at :274, `partialRecovery` reads at :292 |
| G-033 | **CONFIRMED** | Loss streaks vanish on restart | `backend/risk/manager.ts:199-201` | In-memory records only. Persist or reconstruct |
| G-034 | **CONFIRMED** | Negative edge gets positive Kelly floor | `backend/risk/manager.ts:374` | `Math.max(0.01, …)` → `Math.max(0, …)` |
| G-035 | **CONFIRMED** | Drawdown from initial balance | `backend/risk/manager.ts:449` | Persist high-water equity |
| G-036 | **CONFIRMED** | Daily limit from initial balance | `backend/risk/manager.ts:456` | Start-of-day snapshot + UTC reset |
| G-037 | **CONFIRMED** ⚠*worse* | SQL placeholder mismatches | `database.ts:285-286`; `database_postgres.ts:593-599` | `?` routed to `pg` (needs `$1`). **Every** parameterised query fails under Postgres |
| G-038 | **CONFIRMED** | Config merged without validation | `backend/risk/manager.ts:237-239` | `JSON.parse` spread unvalidated. Zod schema + migration |
| G-039 | UNVERIFIED | Redis and SQLite can disagree | `backend/main.ts:116` | Single versioned authority |
| G-040 | UNVERIFIED | Fire-and-forget setters reorder | `backend/main.ts` | Awaited CAS/versioned updates |
| G-041 | **CONFIRMED** | Risk init fails open | `backend/main.ts:562-567` | Caught at `warn`; engine proceeds live-capable. Disarm live |
| G-042 | **CONFIRMED** | Redis failure loads live-capable defaults | `server.ts:195-197, 384`; `main.ts:109` | `redis=null` → `_activeMode='moderate'`. Paper-only degraded mode |
| G-043 | UNVERIFIED | Liquidity analyzer receives null exchange | `backend/slippage/` | Late-bind after exchange readiness |
| G-044 | **CONFIRMED** | Pending operations not tracked | `backend/main.ts:414-422` | Comment admits it; only sleeps. In-flight registry |
| G-045 | UNVERIFIED | No live-position handoff policy | `backend/main.ts` | Reconcile, protect, flatten or transfer |
| G-046 | UNVERIFIED | Signal executes on decision candle | `backend/backtest/service.ts` | Next-event execution semantics |
| G-047 | UNVERIFIED | AI/news nondeterministic in backtest | `backend/backtest/service.ts` | Versioned historical context or disable |
| G-048 | UNVERIFIED | No realistic fill/fee/funding model | `backend/backtest/service.ts` | Shared execution simulator |
| G-049 | UNVERIFIED | Same optimum applied to every mode | `backend/optimization/` | Optimise by mode and regime |
| G-050 | UNVERIFIED | Trial score persisted as zero | `backend/optimization/` | Store actual objective |
| G-051 | UNVERIFIED | Objective does not replay parameter effects | `backend/optimization/` | Full event replay |
| G-052 | UNVERIFIED | Seven-day sample overfits | `backend/optimization/` | Walk-forward + minimum sample policy |
| G-053 | **CONFIRMED** | Hourly job vs 15-minute trading | `main.ts:445` vs `:108`, `:746` | `60*60*1000` job, 10 s cycle. Timeframe-derived schedule |
| G-054 | UNVERIFIED | Repeat optimisation uses stale regime | `backend/optimization/` | Resolve regime at execution time |
| G-055 | UNVERIFIED | Long timeframe sleep exceeds timeout | `backend/main.ts:746` | Abortable sleep |

## P2 — Maintainability and hardening (16)

| ID | Status | Gap | Anchor / note |
|---|---|---|---|
| G-056 | UNVERIFIED | Cumulative VWAP anchor undefined | `backend/indicators/engine.ts` |
| G-057 | UNVERIFIED | Indicator redundancy double-counts momentum | `backend/indicators/` |
| G-058 | UNVERIFIED | Divergence heuristic permissive | `backend/indicators/` |
| G-059 | UNVERIFIED | Every-cycle indicator JSON bloats DB | `backend/database.ts` |
| G-060 | UNVERIFIED | Timestamp/random IDs not robust | `backend/main.ts:1173` — related to **G-025** |
| G-061 | UNVERIFIED | Raw SQLite copy misses WAL | `backend/backup.ts` |
| G-062 | **PARTIAL / CLOSED** | `main.ts` orchestration monolith | `runCycle` 88→9 and frontend resolved by PR #14; **backend file-level monolith remains** |
| G-063 | UNVERIFIED | Extensive `any` weakens safety | repo-wide |
| G-064 | UNVERIFIED | Mixed console and structured logging | `backend/logging/logger.ts` |
| G-065 | UNVERIFIED | Provider and exchange readiness conflated | `backend/main.ts` |
| G-066 | UNVERIFIED | Paper WS path substring matching | `backend/api/websocket.ts` — improved by PR #14 |
| G-067 | UNVERIFIED | Exchange permission / IP allowlist unproven | operational |
| G-068 | **CONFIRMED** | Close orders not `reduceOnly` | repo-wide: **zero** occurrences |
| G-069 | UNVERIFIED | Strategy docs and code drift | `backend/strategy/` |
| G-070 | UNVERIFIED | No property/replay/chaos suite | `tests/` |
| G-071 | UNVERIFIED | No divergence SLOs | `backend/observability/` |

## P3 — Scale and future (4)

| ID | Status | Gap |
|---|---|---|
| G-072 | UNVERIFIED | SQLite / process-local components limit HA |
| G-073 | UNVERIFIED | No model/config registry |
| G-074 | UNVERIFIED | Engine centred on one active symbol — compounds **G-027** |
| G-075 | UNVERIFIED | Liquidation model simplified |

## G-076 — NEW: CI red on main

| ID | Status | Gap | Evidence |
|---|---|---|---|
| **G-076** | **CONFIRMED** | `test` and `quality` CI jobs fail on `main` | Fail on `main` @ `942dc974` *and* every PR #14 commit → **pre-existing, not a regression**. Logs expired; root cause unknown |

**Why this matters enough to add a gap ID:** QG-1 and QG-2 take a green pipeline as their evidence source.
While CI is red, every "tests pass" claim rests on local runs rather than reproducible CI, so the two
foundational gates have no independent backing. First platform task: re-run CI, capture fresh logs,
triage. See [`risks/ci-red-on-main.md`](okf/risks/ci-red-on-main.md).

## Closed by PR #14 — do not create tasks

*(These were open at the superseded pre-merge baseline `942dc974`; all are resolved at the current baseline.)*

Committed API key · frontend bundle secrets · WS query-string token · `App.tsx` monolith · unreachable
MLDashboard · missing migration-state table · k8s selector/label bugs · committed Redis dumps · committed
16.1 MB `helm.tar.gz`.

**Still outstanding:** the four exposed credentials persist in **pre-baseline git history**. Rotation
requires a human-approved history rewrite and is *not* closed by the merge.

## Provenance note

The original register was derived from screenshots, not a repository audit — its own evidence boundary
said so. Verification found **0 fabricated gaps** and **3 understatements** (G-001, G-004, G-037). The
register earned its credibility, but the 41 UNVERIFIED rows have not yet been individually checked and
must not be treated as anchored.
