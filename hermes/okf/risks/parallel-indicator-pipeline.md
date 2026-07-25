---
type: Risk
title: Worker-parallel indicator path is incorrect and disagrees with the serial path
description: Warm-up overlap is appended on the wrong side, results are merged by array position rather than timestamp, and the two paths use different minimum history.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/indicators/engine.ts#L103-L151
tags:
  - p1
  - indicators
  - numerical
  - data-integrity
  - verified
  - root-cause
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-017, G-018, G-019, G-020.

# Affected code

* `backend/indicators/engine.ts:103-112` — overlap appended after `end` instead of prepended before `start`.
* `backend/indicators/engine.ts:137-151` — `mergeResults` merges by local array index.
* `backend/indicators/engine.ts:98` vs `:155`/`:265` — divergent minimum-history contracts.
* `backend/indicators/engine.ts:22-26` — WaveTrend fallback and `wt1`/`wt2` alignment loss.

# Why it matters

Chunks after the first lack the prior-candle context their indicators need, and positional merging can
overwrite values from different points in time, so parallel output is not merely imprecise but
misaligned. Because the serial and parallel paths accept different minimum history, the same input can
produce different features depending on which path runs.

# Verification status

**CONFIRMED** — all four anchored. They share one method, `calculateAllParallel`; a single rewrite plus a
serial-parity assertion addresses the whole cluster.
