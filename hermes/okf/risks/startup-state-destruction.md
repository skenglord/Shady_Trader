---
type: Risk
title: Startup discards restored open trades
description: init() rehydrates open trades from the database, then start() immediately resets every portfolio, discarding them.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/main.ts#L688-L700
tags:
  - p0
  - state
  - persistence
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-007.

# Affected code

* `backend/shadow/shadow_trader.ts:72-95` — `init()` → `loadState()` loads `status='open'` trades.
* `backend/shadow/shadow_trader.ts:75-81` — `reset()` replaces each portfolio with a fresh 100000 object.
* `backend/main.ts:692` — `this.shadowTrader.reset()` inside `start()`.

# Why it matters

Restored positions are silently dropped on every engine start, so after a restart the system believes it
holds nothing while the exchange may still hold real positions. Combined with the absent reconciliation
loop, nothing later detects the discrepancy.

# Verification status

**CONFIRMED** — `reset()` is on the normal startup path, not an admin-only command.
