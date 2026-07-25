---
type: Risk
title: Regime confidence is uncalibrated and missing values are treated as zero
description: Confidence is a hard-coded literal per branch and null RSI values are averaged as zero, deflating the mean.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/regime/detector.ts#L216
tags:
  - p1
  - regime
  - calibration
  - data-integrity
  - verified
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-021, G-022, G-023.

# Affected code

* `backend/regime/detector.ts:216` — `sum + (row.rsi_14 || 0)` counts nulls in the denominator.
* `backend/regime/detector.ts:248-294` — `_classifyRegime` returns literals 95/85/80/70/50.

# Why it matters

Downstream sizing and gating treat "confidence" as a probability, but it is a constant attached to a
branch, so it carries no information about actual reliability. The RSI average is simultaneously biased
downward by warm-up rows, which shifts classification toward bearish or neutral regimes.

# Verification status

**CONFIRMED** — both defects anchored.
