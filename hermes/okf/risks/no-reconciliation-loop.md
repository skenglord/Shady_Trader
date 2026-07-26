---
type: Risk
title: No authoritative exchange reconciliation is wired into the engine
description: A PositionReconciliationEngine exists and is instantiated by the connector, but no startup or continuous reconciliation runs in the engine lifecycle.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/exchange/reconciliation.ts#L15
tags:
  - p0
  - reconciliation
  - execution
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-003.

# Affected code

* `backend/exchange/reconciliation.ts:15` — `PositionReconciliationEngine` class.
* `backend/exchange/connector.ts:109` — the only instantiation.
* `backend/main.ts` — contains **zero** `reconcil*` references.

# Why it matters

Without reconciliation on startup and on a continuous cadence, there is no mechanism to detect that
internal state and exchange truth have diverged — which the other execution defects make likely. The
building block already exists, so this is a wiring and policy gap rather than a from-scratch build.

# Verification status

**CONFIRMED (nuanced)** — the engine class exists, contradicting a strict reading of "no reconciliation
engine". What is missing is lifecycle integration.
