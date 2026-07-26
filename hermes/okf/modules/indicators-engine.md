---
type: Module
title: Indicator Engine
description: Serial and worker-parallel technical indicator computation: EMA, RSI, Bollinger, ADX, MACD, ATR, VWAP, WaveTrend, MFI, VPI.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/indicators
tags:
  - indicators
  - numerical
  - p1
  - data-integrity
timestamp: 2026-07-26T00:00:00Z
---

# Overview

`backend/indicators/engine.ts` (10.3 KB) provides both a serial reference path (`calculateAll`) and a
worker-parallel path (`calculateAllParallel`). The two paths do not agree: they use different minimum
history, chunk overlap is applied on the wrong side, and results are merged positionally.

# Files that matter

* `backend/indicators/engine.ts:22-26` — WaveTrend denominator fallback and `alignToEnd` calls for `wt1`/`wt2`.
* `backend/indicators/engine.ts:98` — parallel minimum history (`< 20`).
* `backend/indicators/engine.ts:103-112` — chunk slicing; the 50-candle overlap is appended after `end`.
* `backend/indicators/engine.ts:137-151` — `mergeResults` merges by array position.
* `backend/indicators/engine.ts:155, 265` — serial minimum history (`< 50`) plus non-null filtering.
* `backend/indicators/rrRsi.ts`, `backend/indicators/volumePressureIndex.ts` — derived indicators.

# Risks

* [Parallel indicator pipeline is incorrect](/risks/parallel-indicator-pipeline.md) — G-017, G-018, G-019, G-020
