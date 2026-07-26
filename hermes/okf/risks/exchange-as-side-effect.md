---
type: Risk
title: Exchange treated as a fire-and-forget side effect
description: Live order failures are logged and execution proceeds, so internal state can claim positions the exchange does not hold. Root cause behind five P0 gaps.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/shadow/shadow_trader.ts#L419-L436
tags:
  - p0
  - execution
  - money-path
  - security-relevant
  - verified
  - root-cause
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-001, G-002, G-014, G-068 (and G-015 for missing native protection).

# Affected code

* `backend/shadow/shadow_trader.ts:419-436` — close path.
* `backend/shadow/shadow_trader.ts:251-263` — entry path.
* Repo-wide: `reduceOnly` / `reduce_only` occur **zero times**.

# Why it matters

On close, `recordTradeResult(pnl, tradeCost)` runs at line 420 *before* the exchange call; a failure at
line 427 is only `console.error`-ed and execution falls through to `UPDATE shadow_trades SET
status='closed'`. The ledger is credited and the trade marked closed while the exchange position stays
open. On entry, the catch block comments "we'll continue with the shadow trade" and pushes the trade
regardless. Because no close is `reduceOnly`, a retry can open an opposite position instead of reducing
one.

# Verification status

**CONFIRMED** — read from source at baseline 63f1ecc0. More severe than the original register wording,
which did not note that the ledger is credited before the exchange call.
