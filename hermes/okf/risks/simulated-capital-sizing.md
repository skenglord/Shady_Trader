---
type: Risk
title: Position sizing and allocation run off simulated capital
description: Balances default to a simulated 100000 and the entire main balance is auto-allocated to the bot at startup with no cap or operator approval.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/main.ts#L697-L700
tags:
  - p0
  - capital
  - money-path
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-005, G-009.

# Affected code

* `backend/balance/manager.ts:52` — `mainBalance: row.main_balance ?? 100000`.
* `backend/shadow/shadow_trader.ts:79` — `reset()` hard-codes 100000 for every mode.
* `backend/main.ts:697-700` — unconditional `allocateToBot(balances.mainBalance)`.

# Why it matters

The active mode can size orders from a simulated portfolio rather than verified live equity and free
collateral, so real exposure need not correspond to real funds. The auto-allocation immediately commits
the whole main balance without an explicit limit or operator action.

# Verification status

**CONFIRMED** — both defects sit in the same ten-line block of `start()`, alongside G-007.
