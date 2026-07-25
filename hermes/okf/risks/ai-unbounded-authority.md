---
type: Risk
title: AI can influence risk mode without a deterministic policy gate
description: Model output can affect or select risk mode, including Degen, with no deterministic transition matrix constraining it.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/ml
tags:
  - p0
  - ai
  - governance
  - money-path
  - unverified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-012 (and G-047 for nondeterministic AI in backtests).

# Affected code

* `backend/ml/gemma_adjuster.ts` — adjustment logic.
* `backend/ai/gemmaAdapter.ts` — model adapter.

# Why it matters

A non-deterministic component must never hold authority over capital risk. AI output should be advisory,
with a deterministic transition matrix deciding whether any recommendation is actionable, and Degen
excluded from automatic selection entirely.

# Verification status

**UNVERIFIED** in this pass. <!-- TODO: verify the mode-change call path from AI output -->
