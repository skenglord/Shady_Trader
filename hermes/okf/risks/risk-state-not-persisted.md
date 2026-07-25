---
type: Risk
title: Loss-streak and recovery state is in-memory and mis-sequenced
description: Streak counters never reach the database, and recordWin zeroes the loss count before the recovery path reads it.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/risk/manager.ts#L273-L292
tags:
  - p1
  - risk
  - state
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-032, G-033.

# Affected code

* `backend/risk/manager.ts:199-201` — `consecutiveLosses` / `consecutiveWins` as in-memory records.
* `backend/risk/manager.ts:273-285` — `recordWin` zeroes losses at :274 before calling `partialRecovery` at :285.
* `backend/risk/manager.ts:292` — `partialRecovery` reads the already-zeroed counter.
* `backend/risk/manager.ts:267-271` — `recordLoss` never resets `consecutiveWins`.

# Why it matters

Every circuit-breaker cooldown resets to zero on restart, so a process bounce clears the protection a
loss streak was meant to impose. The recovery step is computed from a counter that is always zero,
so partial recovery never behaves as designed.

# Verification status

**CONFIRMED** — both the ordering bug and the persistence gap read from source.
