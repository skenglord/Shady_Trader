---
type: Module
title: Balance Manager
description: Main/bot balance split, allocation, active-trade accounting and trade-result recording.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/balance/manager.ts
tags:
  - capital
  - accounting
  - money-path
  - p0
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/balance/manager.ts` (5.7 KB) tracks the main and bot balances and records trade results. It
defaults to a simulated 100000 balance and is credited before exchange confirmation.

# Files that matter

* `backend/balance/manager.ts:52` — `mainBalance: row.main_balance ?? 100000`.
* `backend/shadow/shadow_trader.ts:266` — `addActiveTrade` called after the live order attempt.
* `backend/shadow/shadow_trader.ts:420` — `recordTradeResult` called before the exchange close.

# Risks

* [Sizing from simulated capital](/risks/simulated-capital-sizing.md) — G-005, G-009
* [No ledger; fees and funding unaccounted](/risks/leveraged-pnl-inversion.md) — G-028, G-029
