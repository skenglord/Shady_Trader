---
type: Risk
title: Optimiser output can reach active configuration without validation
description: Candidate settings are saved before validation, trial scores are persisted as zero, and one optimum may be applied across all modes.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/optimization
tags:
  - p0
  - optimisation
  - governance
  - unverified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-013, G-049, G-050, G-051, G-052.

# Affected code

* `backend/optimization/` — optimiser and trial persistence.
* `backend/monte-carlo/` — validation machinery that is not gating promotion.

# Why it matters

An optimiser that can write production configuration turns a research artifact into a live risk change
with no human in the loop. Seven-day samples and un-replayed objectives make overfitting likely, so the
promoted parameters may be actively harmful.

# Verification status

**UNVERIFIED** in this pass. <!-- TODO: verify optimiser write path to active config -->
