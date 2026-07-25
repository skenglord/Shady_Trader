---
type: Risk
title: Daily-loss circuit breaker can never fire
description: A literal zero is passed as the day's loss into the circuit-breaker check, disabling the control entirely.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/shadow/shadow_trader.ts#L136-L137
tags:
  - p0
  - risk
  - money-path
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-006 (and G-036 for the baseline it compares against).

# Affected code

* `backend/shadow/shadow_trader.ts:136-137` — `const dailyLoss = 0; // Calculate daily loss from DB`.
* `backend/risk/manager.ts:456` — `if (dailyLoss >= initialBalance * (config.maxDailyLoss || 0.05))`.

# Why it matters

The comment shows the computation was never implemented. Because the argument is always zero, the
comparison can never be true and the daily-loss halt is dead code — one of the two headline capital
protections is entirely absent at runtime.

# Verification status

**CONFIRMED** — literal constant read from source.
