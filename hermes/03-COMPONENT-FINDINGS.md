---
title: "ASTS — Component Findings"
programme: ASTS-HARDENING
baseline_sha: "63f1ecc0a2a90b8035cd8773e897e0953577c523"
okf_refs: ["modules/index.md"]
---

# Component Findings

Per-component review. Each section names its OKF module concept, what works, what does not, and the
recommendation. **Read your component's OKF concept before editing** — it carries the anchors.

---

## 1. Indicator engine
**OKF:** [`modules/indicators-engine.md`](okf/modules/indicators-engine.md) · **Gaps:** G-017…G-020, G-056…G-058

**Works:** broad indicator coverage (EMA, RSI, Bollinger, ADX, MACD, ATR, VWAP, WaveTrend, MFI, VPI);
worker-parallel path exists for throughput; a serial path exists that can serve as the reference.

**Does not work:** the parallel path is not equivalent to the serial one. Overlap is appended *after* the
chunk end (`engine.ts:103-112`) so workers after the first lack warm-up context; `mergeResults`
(`:137-151`) merges by array position rather than timestamp, so values from different points in time can
overwrite each other; minimum history differs between paths (`<20` parallel vs `<50` serial); WaveTrend's
`wt2` is derived through a `filter(v => v != null)` that destroys positional alignment with `wt1`.

**Recommendation:** designate the serial path the canonical reference. Rewrite `calculateAllParallel` to
prepend warm-up and merge by timestamp. Add a **parity assertion test** — parallel output must equal serial
output on a fixed corpus. One canonical warm-up constant shared by both. This single rewrite closes the
whole C2 cluster.

---

## 2. Regime detector
**OKF:** [`modules/regime-detector.md`](okf/modules/regime-detector.md) · **Gaps:** G-016, G-021, G-022, G-023

**Works:** three-axis composite classification is a sound design; a legacy classifier remains as fallback.

**Does not work:** it asks for 672-candle (7-day) and 2880-candle (30-day) windows but only ~150 usable
candles ever arrive, so `min(df.length, N)` silently clamps every multi-day feature. Missing RSI is
averaged as zero (`detector.ts:216`), biasing the mean downward. "Confidence" is a hard-coded literal per
branch (95/85/80/70/50), so downstream code treating it as a probability is consuming a constant.

**Recommendation:** fix history first (G-016) — calibration on starved data is meaningless. Then exclude
non-finite values rather than substituting zero, and either rename the field to `score` or calibrate it
against out-of-sample labels. Return `uncertain/insufficient_history` until bootstrap completes, and use
regime stability (hysteresis) in the transition policy.

---

## 3. Signal generation and persistence
**OKF:** [`modules/trading-engine.md`](okf/modules/trading-engine.md) · **Gaps:** G-025, G-026, G-059, G-060

**Works:** signals are persisted with indicator context; the cycle is decomposed into eleven typed stages
after PR #14; broadcast shapes are stable.

**Does not work:** nothing gates on candle closure. With a 10-second cycle on a 15-minute timeframe the
same unfinished candle is evaluated ~90 times; signal IDs are `sig-{timestamp}-{random}` and the
`signals` table has no unique constraint, so repetition is neither prevented nor detectable. Storing full
indicator JSON every cycle will bloat the database.

**Recommendation:** declare each strategy close-only or intrabar. For close-only, process one finalised
candle exactly once via a deterministic idempotency key plus a DB unique constraint. Add retention and
compact feature references.

---

## 4. Risk manager
**OKF:** [`modules/risk-manager.md`](okf/modules/risk-manager.md) · **Gaps:** G-010, G-030…G-036, G-038

**Works:** explicit per-mode configuration, a real circuit-breaker concept, Kelly option, loss-streak
awareness, Degen guard.

**Does not work:** the dollar-risk cap omits leverage (`:44`), so a 3× position is capped at 3× the
intended risk. Kelly floors at 1% on negative edge (`:374`) — sizing up exactly when the edge is worst.
Streak counters are in-memory only (`:199-201`) and reset on restart; `recordWin` zeroes the loss counter
*before* `partialRecovery` reads it (`:273-292`). Drawdown and daily loss both measure from initial
balance rather than high-water/start-of-day equity. Saved config JSON is merged with no validation.

**Recommendation:** one authoritative final pre-trade gate that every submission must pass, applying
scaling → caps → liquidity → exchange rounding in a fixed order and **recomputing worst-case risk after
rounding**. Persist streak and cooldown state. Kelly returns zero on negative edge. Property-test that
final risk never exceeds configured limits.

---

## 5. Shadow trader and live execution
**OKF:** [`modules/shadow-trader.md`](okf/modules/shadow-trader.md) · **Gaps:** G-001, G-002, G-004, G-005, G-006, G-007, G-014, G-027, G-028, G-029, G-068

**This is the highest-risk module in the repository.** Eleven gaps, six of them P0.

**Works:** the six-portfolio concept is genuinely valuable; exit logic is decomposed after PR #14
(`updatePositions` complexity 51 → 14) with precedence preserved.

**Does not work:** every live exchange interaction is a bare `try/catch` that logs and proceeds. On close
the ledger is credited *before* the exchange call and the trade is marked closed regardless of outcome.
On entry the trade is pushed to the portfolio even when the order failed. No close is `reduceOnly`
anywhere in the repo. PnL divides by leverage instead of multiplying. Daily loss is a literal zero. One
price is applied to every open trade regardless of symbol.

**Required order lifecycle:**
```text
INTENT → PENDING → ACCEPTED → PARTIALLY_FILLED → FILLED
                 ↘ REJECTED  ↘ CANCELLED  ↘ UNKNOWN → (reconcile) → resolved
```
`UNKNOWN` is mandatory: a network timeout is neither success nor failure and must never trigger blind
resubmission. Internal `CLOSED` requires confirmed fills or a verified zero exchange position.

**Recommendation:** treat C1 as **one sequenced workstream under a single owner**, not six parallel
tasks — all six gaps live in the same file and would otherwise collide.

---

## 6. Exchange layer and reconciliation
**OKF:** [`modules/exchange-layer.md`](okf/modules/exchange-layer.md) · **Gaps:** G-003, G-015, G-024, G-065

**Works:** five venues behind adapters; connection pooling, backpressure, deduplication, distributed locks,
latency profiling and provider rotation all exist. **A `PositionReconciliationEngine` already exists.**

**Does not work:** that engine is instantiated in `connector.ts:109` but `main.ts` contains **zero**
`reconcil*` references — nothing runs it at startup or on a cadence. The timeframe→ms map is duplicated
four times inside `connector.ts` alone.

**Recommendation:** wire startup reconciliation (open orders, fills since cursor, positions, balances,
protection orders) and a continuous loop. This is integration work on an existing component, not a
from-scratch build — cheaper than the register implies.

---

## 7. Slippage and liquidity
**OKF:** [`modules/slippage-engine.md`](okf/modules/slippage-engine.md) · **Gaps:** G-011, G-043

**Works:** cost estimator, fill calculator, impact simulator and a circuit-breaker concept.

**Does not work:** not proven to fail closed. If liquidity analysis is unavailable or the analyzer was
constructed with a null exchange, live submission can still proceed.

**Recommendation:** for the active live mode, unavailable cost/liquidity data is a **hard block**, not a
warning. Late-bind the analyzer after exchange readiness.

---

## 8. Optimisation and Monte Carlo
**OKF:** [`modules/optimisation-montecarlo.md`](okf/modules/optimisation-montecarlo.md) · **Gaps:** G-013, G-049…G-052, G-054

**Works:** Bayesian optimiser, trial history, a genuine Monte Carlo engine with stress testing,
correlation matrices and risk calculators.

**Does not work:** candidates can reach active configuration without validation; trial scores persist as
zero; one optimum may be applied across all modes, collapsing the risk differentiation the modes exist to
provide; seven-day samples overfit.

**Required promotion workflow:**
```text
optimiser → immutable candidate → replay + walk-forward + Monte Carlo + cost stress
          → shadow canary → human approval → atomic promotion → auto-rollback on degradation
```
No optimiser may write active configuration directly. Ever.

---

## 9. AI governance
**OKF:** [`modules/ai-governance.md`](okf/modules/ai-governance.md) · **Gaps:** G-012, G-047, G-073

**Works:** local model keeps data in-house; rule-based fallbacks were deliberately retained — a good
instinct worth preserving.

**Does not work:** AI output can influence or change risk mode with no deterministic policy gate, and
nondeterministic AI in backtests destroys reproducibility.

**Enterprise policy:** AI is **advisory only**. A deterministic transition matrix decides whether any
recommendation is actionable. Degen is never an automatic output. AI can never override a risk rejection.
Model, prompt, parameters and response metadata are versioned and recorded. For backtests, AI is disabled
unless historical model/context snapshots exist.

---

## 10. State, persistence and database
**OKF:** [`modules/database-layer.md`](okf/modules/database-layer.md) · **Gaps:** G-037…G-040, G-059, G-061, G-072

**Works:** PR #14 added a `schema_migrations` state table with skip-if-applied and fail-fast; application
startup is now the single owner of DDL; the Postgres seed is idempotent.

**Does not work:** **the Postgres path is non-functional.** The application uses SQLite `?` placeholders
everywhere and `database.ts:285-286` routes them straight to the `pg` driver, which requires `$1, $2`.
Every parameterised query fails under `USE_POSTGRES=true`. Authority is also split between Redis and the
relational store.

**Recommendation:** either implement a placeholder-translation layer with an automated placeholder-count
test, or explicitly declare Postgres unsupported until it is fixed. Silently shipping a broken dual-target
is the worst of the three options.

---

## 11. Startup, scheduling and shutdown
**OKF:** [`modules/trading-engine.md`](okf/modules/trading-engine.md) · **Gaps:** G-007, G-009, G-041…G-045, G-053, G-055

**Works:** startup diagnostics exist and distinguish several failure reasons; schedulers are centralised.

**Does not work:** `start()` resets restored portfolios and then auto-allocates the entire main balance.
Risk-init failures are caught at `warn` and the engine proceeds live-capable. Redis failure yields
`redis = null` and a default `moderate` (live-capable) mode. `waitForPendingOperations` contains the
comment *"In a real implementation, we would track pending operations"* and merely sleeps.

**Required startup state machine:**
```text
BOOT → LOAD_CONFIG → VERIFY_DEPS → RECONCILE_EXCHANGE → ARM_CHECK
     → READY(paper) → [explicit operator arming] → READY(live)
```
Any failed dependency pins the system at `READY(paper)`. Live arming is always an explicit operator action,
never a default.

---

## 12. Backtesting
**OKF:** [`modules/backtest-replay.md`](okf/modules/backtest-replay.md) · **Gaps:** G-046…G-048, G-051, G-052

**Works:** a working skeleton with a walk-forward analysis module and an overfitting detector already in
`tests/`.

**Does not work:** it does not share the production decision/execution/ledger path, so results describe a
different system. Same-candle execution and nondeterministic AI introduce look-ahead.

**Required event order:**
```text
candle close → compute features → decide → NEXT eligible event → simulate fill
             → apply costs → post to ledger → update risk state
```

**Recommendation:** replay must import the *same* signal, risk, OMS, fill and ledger modules production
uses. Version all data and strategy inputs; emit reproducible run manifests with checksums.
