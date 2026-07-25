---
type: Module
title: Risk Manager
description: Central risk configuration, position sizing, Kelly, circuit breakers, loss-streak tracking and drawdown.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/risk/manager.ts
tags:
  - risk
  - money-path
  - p0
  - security-relevant
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/risk/manager.ts` (18.1 KB) holds `DEFAULT_RISK_CONFIGS` for the six modes and implements sizing,
Kelly, circuit breakers and streak tracking. Controls exist but several are not conclusively enforced,
and all streak state is in-memory only.

# Files that matter

* `backend/risk/manager.ts:44` — `dollarRisk` omits the leverage multiplier.
* `backend/risk/manager.ts:154` — `stopLoss` stored as percent (4.0) in defaults.
* `backend/risk/manager.ts:199-201` — `consecutiveLosses` / `consecutiveWins` declared as in-memory records.
* `backend/risk/manager.ts:237-239` — saved JSON config spread in with no schema validation.
* `backend/risk/manager.ts:273-292` — `recordWin` zeroes the loss count before `partialRecovery` reads it.
* `backend/risk/manager.ts:374` — Kelly floor `Math.max(0.01, ...)` on negative edge.
* `backend/risk/manager.ts:383` — `calculatePositionSize` accepts and ignores an absolute-price `stopLoss`.
* `backend/risk/manager.ts:446-458` — `checkCircuitBreakers`; daily-loss test against `initialBalance`.
* `backend/risk/manager.ts:449` — drawdown measured from initial balance, not a high-water mark.

# Risks

* [No enforced final pre-trade risk gate](/risks/final-risk-gate-missing.md) — G-010, G-031, G-034
* [Risk state lost on restart](/risks/risk-state-not-persisted.md) — G-032, G-033
* [Drawdown and daily limits use the wrong baseline](/risks/wrong-equity-baseline.md) — G-035, G-036
* [Unvalidated configuration merge](/risks/database-abstraction-leak.md) — G-038
* [Inert daily-loss circuit breaker](/risks/inert-daily-loss-breaker.md) — G-006
