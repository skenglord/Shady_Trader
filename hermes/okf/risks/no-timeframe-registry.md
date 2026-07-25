---
type: Risk
title: Timeframe durations are hard-coded and schedules do not derive from them
description: The timeframe-to-milliseconds map is duplicated in at least four places and the market-data job runs hourly against a 15-minute trading cadence.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/exchange/connector.ts#L407-L408
tags:
  - p1
  - scheduling
  - data-integrity
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-024, G-053.

# Affected code

* `backend/exchange/connector.ts:407-408, 584, 665, 693` — four inline duplicates in one file.
* `backend/main.ts:1380-1382` — another inline conversion.
* `backend/main.ts:445` — market-data job `every: 60 * 60 * 1000`.
* `backend/main.ts:108, 746` — default `15m` timeframe, 10-second cycle sleep.

# Why it matters

With no authoritative registry, the scheduler has nowhere to derive cadence from and hard-codes an hourly
refresh, so the engine evaluates signals every ten seconds against candle data that can be up to an hour
stale. Duplicated maps also drift independently as timeframes are added.

# Verification status

**CONFIRMED**.
