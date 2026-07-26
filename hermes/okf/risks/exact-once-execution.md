---
type: Risk
title: No exact-once guarantee for candle processing
description: Symbol-only locks, random signal ids and no unique constraint allow the same candle to produce repeated trades.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/execution/executionLock.ts#L42
tags:
  - p1
  - concurrency
  - idempotency
  - money-path
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-025, G-026.

# Affected code

* `backend/execution/executionLock.ts:42` — key `trade_lock:${symbol}`, no candle or strategy scope.
* `backend/main.ts:1173-1178` — signal id `sig-{timestamp}-{random}`.
* `backend/database.ts:226-240` — `signals` table has no UNIQUE on (symbol, candle_time).

# Why it matters

With a 10-second cycle on a 15-minute timeframe, the same unfinished candle is evaluated roughly ninety
times, and nothing in the lock, the id scheme or the schema prevents a repeated signal from becoming a
repeated trade. Two engine instances would compound this into double submission.

# Verification status

**CONFIRMED**.
