---
type: Risk
title: Runtime fetches far less history than features require
description: A hard-coded 200-candle fetch feeds regime windows that ask for 672 and 2880 candles, so multi-day features silently clamp.
resource: https://github.com/skenglord/Shady_Trader/blob/63f1ecc0a2a90b8035cd8773e897e0953577c523/backend/main.ts#L918
tags:
  - p1
  - data-integrity
  - regime
  - verified
  - root-cause
timestamp: 2026-07-26T00:00:00Z
---

# Gaps

G-016.

# Affected code

* `backend/main.ts:918` — `exchange.getCandles(..., 200)`.
* `backend/regime/detector.ts:199-200` — `periods_30d = min(df.length, 2880)`, `periods_7d = min(df.length, 672)`.

# Why it matters

After EMA-50 warm-up, roughly 150 usable rows remain, so the 7-day and 30-day windows silently collapse to
whatever is available and the ATR percentile is computed over a fraction of its intended sample. Every
regime classification is therefore based on far less evidence than its own definition requires.

# Verification status

**CONFIRMED**. This is a prerequisite fix: correcting
[regime-signal-quality](/risks/regime-signal-quality.md) is not meaningful until history is sufficient.
