---
type: Module
title: Trading Engine (composition root)
description: backend/main.ts — the operational monolith: DI, scheduling, cycle orchestration, config persistence, kill path, broadcasting.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/main.ts
tags:
  - orchestration
  - monolith
  - high-churn
  - p0
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/main.ts` (58.9 KB) is the composition root and runtime coordinator. PR #14 decomposed
`runCycle()` from cyclomatic complexity ~88 into a `CycleContext` plus eleven stage methods
(complexity now 9), but the file itself remains an orchestration monolith mixing dependency
construction, scheduling, DB writes, AI policy, kill-switch behaviour and WebSocket broadcasting.

# Files that matter

* `backend/main.ts:116, 540` — `loadStateFromRedis()` and its call site.
* `backend/main.ts:414-422` — `waitForPendingOperations()`; sleeps instead of tracking in-flight work.
* `backend/main.ts:445` — market-data job scheduled hourly.
* `backend/main.ts:562-567` — risk/shadow init failures caught at warn level; engine proceeds.
* `backend/main.ts:688-700` — `start()`: calls `reset()` then auto-allocates the full main balance.
* `backend/main.ts:918` — `getCandles(..., 200)` hard-coded fetch limit.
* `backend/main.ts:1173-1178` — signal id generation and insert.
* `backend/main.ts:1380-1385` — inline timeframe→ms conversion.

# Risks

* [Startup destroys restored state](/risks/startup-state-destruction.md) — G-007, G-009
* [Initialisation fails open](/risks/init-fails-open.md) — G-041, G-042
* [Untracked shutdown](/risks/untracked-shutdown.md) — G-044, G-045
* [Starved market-data history](/risks/starved-history.md) — G-016
* [No exact-once candle processing](/risks/exact-once-execution.md) — G-025, G-026
* [No timeframe registry](/risks/no-timeframe-registry.md) — G-024, G-053
* [Backend orchestration monolith](/risks/backend-monolith.md) — G-062
