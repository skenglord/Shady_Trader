---
type: Module
title: Slippage, cost and liquidity
description: Cost estimator, fill calculator, impact simulator, liquidity analysis and the slippage circuit breaker.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/slippage
tags:
  - execution-cost
  - liquidity
  - p0
timestamp: 2026-07-26T00:00:00Z
---

# Overview

Seven files under `backend/slippage/`. Cost controls exist but are not proven to fail closed for the
active live mode.

# Files that matter

* `backend/slippage/engine.ts` — slippage engine.
* `backend/slippage/cost-estimator.ts` — cost estimation.
* `backend/slippage/fillCalculator.ts` — simulated fills.
* `backend/slippage/impact-simulator.ts` — market-impact model.

# Risks

* [Protection does not fail closed](/risks/protection-not-fail-closed.md) — G-011
