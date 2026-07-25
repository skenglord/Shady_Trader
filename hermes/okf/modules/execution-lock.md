---
type: Module
title: Execution Lock
description: Distributed trade lock intended to prevent concurrent or duplicate execution.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/execution/executionLock.ts
tags:
  - concurrency
  - idempotency
  - p1
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/execution/executionLock.ts` (1.9 KB) implements a Redis-backed lock. Its key is scoped to the
symbol alone, which is insufficient for exact-once semantics across candles and strategies.

# Files that matter

* `backend/execution/executionLock.ts:42` — lock key `trade_lock:${symbol}`.

# Risks

* [No exact-once candle processing](/risks/exact-once-execution.md) — G-025, G-026
