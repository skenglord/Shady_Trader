---
type: Module
title: Paper trading
description: Dedicated paper-trading service, order book, position tracker, state machine and WebSocket handler.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/paper-trading
tags:
  - paper-trading
  - simulation
timestamp: 2026-07-26T00:00:00Z
---

# Overview

Seven files under `backend/paper-trading/` providing a separate simulated venue with its own order book,
position tracker and state machine. This is the intended soak surface for QG-10 and should be preserved.

# Files that matter

* `backend/paper-trading/paper-trading-service.ts` — service entry point.
* `backend/paper-trading/order-book.ts` — simulated book.
* `backend/paper-trading/position-tracker.ts` — position accounting.
* `backend/paper-trading/state-machine.ts` — lifecycle states.
