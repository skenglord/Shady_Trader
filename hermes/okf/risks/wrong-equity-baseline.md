---
type: Risk
title: Drawdown and daily limits measured from initial balance
description: Both controls compare against a fixed initial balance rather than a persisted high-water mark or a start-of-day equity snapshot.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/risk/manager.ts#L449
tags:
  - p1
  - risk
  - accounting
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-035, G-036.

# Affected code

* `backend/risk/manager.ts:449` — `currentDrawdown = (initialBalance - balance) / initialBalance`.
* `backend/risk/manager.ts:456` — daily-loss test against `initialBalance`.

# Why it matters

After a profitable run, drawdown from peak equity is understated because the baseline never rises, so the
drawdown halt triggers far later than intended. The daily limit has the same flaw and no UTC reset.

# Verification status

**CONFIRMED**.
