---
type: Risk
title: Backtesting does not replay the production decision path
description: Signals can execute on the decision candle, AI is nondeterministic, and no realistic fill, fee or funding model is shared with live code.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/backtest
tags:
  - p1
  - backtest
  - determinism
  - research
  - unverified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-046, G-047, G-048, G-051, G-052.

# Affected code

* `backend/backtest/service.ts` — backtest event loop.
* `backend/scripts/backtest.ts` — CLI driver.

# Why it matters

If the backtest does not use the same signal, risk, OMS, fill and ledger code as production, its results
describe a different system and cannot justify a parameter choice. Same-candle execution and
nondeterministic AI additionally introduce look-ahead, which inflates apparent performance.

# Verification status

**UNVERIFIED** in this pass. <!-- TODO: verify execution timing and cost model in service.ts -->
