---
type: Risk
title: Trade loop reads shared state once per iteration
description: A single current price is applied to all trades and balance is checked against a stale snapshot taken before the exchange call.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/shadow/shadow_trader.ts#L456
tags:
  - p1
  - concurrency
  - accounting
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-027, G-029.

# Affected code

* `backend/shadow/shadow_trader.ts:456` — `updatePositions(currentPrice: number, ...)`.
* `backend/shadow/shadow_trader.ts:127` — balances snapshot.
* `backend/shadow/shadow_trader.ts:244-267` — check at :246, deduction at :266 after `placeOrder` at :253.

# Why it matters

Any multi-symbol portfolio prices every open trade with one symbol's price, so PnL, stops and targets are
evaluated against the wrong market for all but one position. The balance check-to-deduct window spans a
network call, creating a time-of-check/time-of-use gap; non-active shadow modes have no balance guard at
all.

# Verification status

**CONFIRMED** (G-027); **PARTIAL** (G-029) — a pre-check does exist, so the accurate description is a
TOCTOU race rather than a total absence of reservation.
