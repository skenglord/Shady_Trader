---
type: Risk
title: Leveraged PnL divided by leverage instead of multiplied
description: PnL is computed as (amount x price-change) / leverage, understating leveraged results quadratically. Fees, funding and exit slippage are never deducted.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/shadow/shadow_trader.ts#L470-L483
tags:
  - p0
  - accounting
  - money-path
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-004, G-028.

# Affected code

* `backend/shadow/shadow_trader.ts:470-483` — margin-based PnL computation.
* `backend/shadow/shadow_trader.ts:479-483` — realised PnL passed on without fee or funding deduction.

# Why it matters

`marginUsed = amount * entry / leverage`, `currentMargin = amount * current / leverage`, and
`pnl = currentMargin - marginUsed`, which reduces algebraically to `(amount x delta-price) / leverage`.
Correct leveraged PnL does not divide by leverage. At 3x Degen leverage the reported result is understated
by a factor of nine, so every downstream control that reads PnL — drawdown, daily loss, Kelly, streaks —
is fed wrong numbers. Separately, `totalFeeFrac` and `entrySlippageFrac` are stored on the trade and in
the database but never subtracted.

# Verification status

**CONFIRMED** — exact mechanism read from source. The original register said "appears understated"; the
formula confirms it and identifies the precise inversion.
