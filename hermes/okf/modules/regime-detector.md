---
type: Module
title: Regime Detector
description: Legacy classifier plus three-axis composite regime classification with 7-day / 30-day / ATR-percentile windows.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/regime/detector.ts
tags:
  - regime
  - data-integrity
  - p1
  - calibration
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/regime/detector.ts` (12.2 KB) classifies market regime from indicator history. It requests
multi-day windows it is never given enough candles to fill, treats missing RSI as zero, and reports
hard-coded confidence literals.

# Files that matter

* `backend/regime/detector.ts:199-200` — `periods_30d = min(df.length, 2880)`, `periods_7d = min(df.length, 672)`.
* `backend/regime/detector.ts:216` — `sum + (row.rsi_14 || 0)` averaging.
* `backend/regime/detector.ts:248-294` — `_classifyRegime` returns literal confidence values 95/85/80/70/50.

# Risks

* [Starved market-data history](/risks/starved-history.md) — G-016
* [Regime signal quality is unsound](/risks/regime-signal-quality.md) — G-021, G-022, G-023
