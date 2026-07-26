---
type: Module
title: Backtesting and replay
description: Backtest service and scripts; the intended basis for deterministic replay.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/backtest
tags:
  - backtest
  - research
  - determinism
  - p1
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/backtest/service.ts` (9.8 KB) plus `backend/scripts/backtest.ts`. A useful skeleton, but it does
not share the production decision/execution/ledger code path, so historical results are not comparable to
paper or live behaviour.

# Files that matter

* `backend/backtest/service.ts` — backtest entry point and event loop.
* `backend/scripts/backtest.ts` — CLI driver.
* `backend/research/` — supporting research code.

# Risks

* [Backtest is not production-equivalent](/risks/backtest-not-production-equivalent.md) — G-046, G-047, G-048
