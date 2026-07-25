---
type: Module
title: Shadow Trader / execution path
description: Six parallel shadow portfolios plus the single live-execution path. Highest-risk module in the repo: owns entry, exit, PnL and the exchange calls.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/shadow/shadow_trader.ts
tags:
  - execution
  - money-path
  - security-relevant
  - p0
  - high-churn
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/shadow/shadow_trader.ts` (24.8 KB) maintains six mode-keyed portfolios and, for the single
`activeMode`, submits real exchange orders. It is the origin of most P0 findings because it treats the
exchange as a fire-and-forget side effect rather than the source of truth.

# Files that matter

* `backend/shadow/shadow_trader.ts:72-95` — `init()` → `loadState()`; rehydrates open trades from `shadow_trades`.
* `backend/shadow/shadow_trader.ts:75-81` — `reset()`; overwrites every portfolio with a literal 100000 balance.
* `backend/shadow/shadow_trader.ts:136-137` — daily-loss literal zero fed to the circuit breaker.
* `backend/shadow/shadow_trader.ts:244-267` — entry path: balance pre-check, live `placeOrder`, unconditional push.
* `backend/shadow/shadow_trader.ts:419-436` — close path: ledger credited before the exchange call; failure only logged.
* `backend/shadow/shadow_trader.ts:456` — `updatePositions(currentPrice: number, ...)`; one price for all symbols.
* `backend/shadow/shadow_trader.ts:470-483` — leveraged PnL computation.

# Risks

* [Exchange treated as side effect](/risks/exchange-as-side-effect.md) — G-001, G-002, G-014, G-068
* [Leveraged PnL inverted by leverage](/risks/leveraged-pnl-inversion.md) — G-004, G-028
* [Sizing from simulated capital](/risks/simulated-capital-sizing.md) — G-005, G-009
* [Inert daily-loss circuit breaker](/risks/inert-daily-loss-breaker.md) — G-006
* [Startup destroys restored state](/risks/startup-state-destruction.md) — G-007
* [Shared-state races in the trade loop](/risks/shared-state-races.md) — G-027, G-029
