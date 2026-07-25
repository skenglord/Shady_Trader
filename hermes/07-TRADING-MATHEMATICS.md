---
title: "ASTS — Trading and Risk Mathematics"
programme: ASTS-HARDENING
baseline_sha: "63f1ecc0a2a90b8035cd8773e897e0953577c523"
okf_refs: ["modules/risk-manager.md", "risks/leveraged-pnl-inversion.md"]
status: "Design specification — every parameter requires bot-specific validation"
---

# Trading and Risk Mathematics

> **Evidence boundary.** Formulas here are **design candidates**, not approved production parameters. No
> value becomes a default because a paper reported good results. Every parameter must pass this project's
> own replay, walk-forward, cost-stress, Monte Carlo and paper gates — see
> [`08-QUANT-PROTOCOL.md`](08-QUANT-PROTOCOL.md).

## Notation

| Symbol | Meaning |
|---|---|
| `E` | Account equity (verified live equity, **not** simulated) |
| `E_free` | Free collateral after reservations |
| `E_hw` | High-water equity |
| `E_sod` | Start-of-day equity (UTC) |
| `P` | Entry price |
| `P_t` | Current price |
| `Q` | Position quantity (base units) |
| `L` | Leverage multiplier |
| `N` | Notional = `Q × P` |
| `M` | Margin = `N / L` |
| `f_risk` | Fraction of equity risked per trade |
| `d_stop` | Stop distance as a fraction of entry price |
| `σ` | Realised volatility |
| `σ_target` | Target volatility |
| `c` | Round-trip cost fraction (fees + spread + slippage) |
| `p` | Calibrated win probability |
| `R` | Reward-to-risk ratio |

## 1. PnL — corrected

**The current implementation is wrong.** See [`leveraged-pnl-inversion`](okf/risks/leveraged-pnl-inversion.md)
and G-004 (`backend/shadow/shadow_trader.ts:470-483`).

```text
CURRENT (incorrect):
  M       = Q × P / L
  M_t     = Q × P_t / L
  pnl     = M_t − M           =  Q × (P_t − P) / L        ← divided by leverage

CORRECT:
  pnl_gross(long)  = Q × (P_t − P)
  pnl_gross(short) = Q × (P − P_t)
  pnl_net          = pnl_gross − fees_entry − fees_exit − funding − slippage
```

Quantity `Q` already embodies the leverage decision (a larger `Q` is *why* you posted margin `M`).
Dividing by `L` a second time double-counts it in the wrong direction. At `L=3` the reported result is
**one ninth** of reality.

**Mandatory fixtures:** long/short × `L ∈ {1, 1.5, 3}` × {full exit, partial exit, liquidation}, each
asserting `pnl_net` against hand-computed values.

## 2. Net-edge gate

Trade only when expected edge survives realistic cost:

```text
edge_gross = p × R × d_stop − (1 − p) × d_stop
edge_net   = edge_gross − c
GATE:  edge_net > k_min × c        (k_min ≥ 1, i.e. edge must beat cost with margin)
```

`c` must be the **measured** round-trip cost for the venue and symbol, not an assumption. If `p` is
uncalibrated (G-022), this gate is not meaningful — calibration is a prerequisite.

## 3. Risk-based quantity

```text
d_stop     = |P − P_stop| / P
risk_$     = E × f_risk
Q_raw      = risk_$ / (d_stop × P)
Q          = round_to_lot(min(Q_raw, Q_cap_symbol, Q_cap_liquidity))
```

**After rounding, recompute worst-case risk and re-check the cap:**

```text
risk_actual = Q × d_stop × P
ASSERT risk_actual ≤ E × f_risk_max
```

Rounding up to a lot boundary can push a compliant order over the cap — the re-check is not optional.

**Degen dollar cap must include leverage** (G-031, `backend/risk/manager.ts:44`):

```text
CURRENT (wrong):  dollarRisk = E × f_size × d_stop
CORRECT:          dollarRisk = E × f_size × L × d_stop
```

## 4. Volatility targeting

```text
scale = clamp(σ_target / σ_realised, s_min, s_max)
f_risk_adjusted = f_risk × scale
```

Size down in high volatility, up in low — bounded by `s_min`/`s_max` so a quiet regime cannot produce
unbounded leverage.

## 5. Confidence calibration

Current confidence is a hard-coded literal per branch (G-022,
`backend/regime/detector.ts:248-294`). Either rename it `score` and stop treating it as probability, or
calibrate on out-of-sample labels:

```text
p_calibrated = isotonic_or_platt(score)   fitted on OOS data
reliability: bucket predictions, compare predicted vs realised frequency
```

Until calibrated, **do not** multiply position size by "confidence" — that scales capital by a constant
dressed as information.

## 6. ATR-normalised stop

```text
d_stop = clamp(k_atr × ATR_n / P, d_min, d_max)
```

Volatility-proportional stops keep risk consistent across regimes. Clamp both ends: too tight guarantees
noise stop-outs, too wide silently inflates per-trade risk.

## 7. Target and trailing exit

```text
P_target   = P ± R × d_stop × P
trail_stop = max(trail_stop_prev, P_t − k_trail × ATR_n)      (long)
```

Trailing stops ratchet monotonically — never loosen.

## 8. Long/short asymmetry

Crypto exhibits asymmetric behaviour: funding costs differ by side, borrow may be constrained, and
downside moves are typically faster. Model separate cost and slippage assumptions per side. Do not assume
a symmetric strategy is symmetric in execution.

## 9. Kelly

```text
kelly_raw = p − (1 − p) / R
f_kelly   = max(0, kelly_raw) × kelly_scale        (kelly_scale ≤ 0.5, fractional Kelly)
```

**`max(0, …)` — not `max(0.01, …)`.** G-034 (`backend/risk/manager.ts:374`) forces a 1% allocation on
negative edge, sizing up exactly when measured edge is worst. Negative edge means **no allocation**.

Kelly on uncalibrated `p` is meaningless: prerequisite is §5.

## 10. Drawdown throttle

```text
dd_current = (E_hw − E) / E_hw          ← high-water, NOT initial balance
throttle   = clamp(1 − dd_current / dd_max, throttle_min, 1)
f_risk_effective = f_risk × throttle
```

G-035 (`manager.ts:449`) uses `initialBalance`, so after a profitable run the baseline never rises and the
drawdown halt triggers far too late. `E_hw` must be **persisted** — an in-memory high-water mark resets on
restart (the G-033 class).

## 11. Daily loss

```text
loss_today = max(0, E_sod − E_now)      ← including unrealised
HALT when loss_today ≥ E_sod × maxDailyLoss
E_sod snapshotted at UTC midnight and persisted
```

G-006: the current code passes a literal `0` (`shadow_trader.ts:136`), so this halt is dead code.
G-036: the comparison uses `initialBalance`, not `E_sod`.

## 12. Portfolio correlation control

```text
exposure_gross = Σ |N_i| / E
exposure_net   = |Σ N_i| / E
For correlated cluster C:  Σ_{i∈C} risk_i ≤ risk_cluster_max
```

Six shadow portfolios trading correlated majors are **one bet**, not six. Cluster exposure must be capped,
or the mode differentiation is cosmetic.

## 13. Final decision record

Every submission must reference a stored `RiskDecision` (G-010):

```yaml
risk_decision:
  decision_id: <uuid>
  timestamp_ms: <TimestampMs>
  symbol: <string>
  side: buy | sell
  equity_source: live_verified          # never simulated
  E: <Money>
  E_free: <Money>
  E_hw: <Money>
  E_sod: <Money>
  f_risk_requested: <Fraction>
  f_risk_effective: <Fraction>          # after throttle
  d_stop: <Fraction>
  leverage: <Leverage>
  Q_raw: <Quantity>
  Q_final: <Quantity>                   # after rounding
  risk_actual_after_rounding: <Money>
  caps_applied: [per_trade, symbol, cluster, portfolio_leverage]
  breakers_checked: [daily_loss, drawdown, loss_streak, max_positions]
  cost_estimate: <Fraction>
  edge_net: <Fraction>
  verdict: approved | rejected
  rejection_reason: <string|null>
```

**No `RiskDecision`, no order.** This record is what makes risk auditable after the fact, and it is the
single artifact that proves the gate ran.
