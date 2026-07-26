---
type: Risk
title: Slippage and protection controls do not fail closed
description: Live trading can proceed when slippage and liquidity dependencies are unavailable.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/slippage
tags:
  - p0
  - execution-cost
  - fail-closed
  - unverified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-011 (and G-043 for late-bound liquidity analysis).

# Affected code

* `backend/slippage/` — cost estimator, impact simulator, circuit breaker.

# Why it matters

A protection control that degrades to "allow" under failure provides no protection in exactly the
conditions where it matters most. For the active live mode these dependencies must fail closed.

# Verification status

**UNVERIFIED** in this pass; consistent with the confirmed fail-open pattern in
[init-fails-open](/risks/init-fails-open.md). <!-- TODO: verify slippage dependency failure path -->
