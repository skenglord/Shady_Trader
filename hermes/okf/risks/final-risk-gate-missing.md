---
type: Risk
title: No single enforced final pre-trade risk gate
description: Risk caps omit leverage, Kelly floors allocation on negative edge, and no stored RiskDecision is required before submission.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/risk/manager.ts#L44
tags:
  - p0
  - risk
  - money-path
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-010, G-031, G-034.

# Affected code

* `backend/risk/manager.ts:44` — `dollarRisk = equity * finalSize * stopDistanceFrac`; leverage absent.
* `backend/risk/manager.ts:374` — `Math.max(0.01, ...)` Kelly floor.
* `backend/risk/manager.ts:383` — `calculatePositionSize` ignores the `stopLoss` argument it receives.

# Why it matters

Because the dollar-risk cap omits the leverage multiplier, a 3x Degen position is capped at three times
the intended risk. The Kelly floor forces a 1% allocation precisely when measured edge is negative, so the
two defects compound: the system sizes up when the strategy is performing worst.

# Verification status

**CONFIRMED** — G-031 and G-034 anchored. G-010 (every order referencing a stored `RiskDecision`) is an
architectural absence rather than a single line.
