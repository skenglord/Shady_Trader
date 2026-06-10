// backend/indicators/rrRsi.ts
// Regime-Relative RSI: replaces hardcoded RSI thresholds with thresholds that
// adapt to the current regime's RSI distribution.

import type { CompositeRegime } from '../types/regime.js';

export interface RRRsiThresholds {
  regime:      CompositeRegime;
  oversold:    number;
  overbought:  number;
  mean:        number;
  std:         number;
  windowSize:  number;
}

export interface RRRsiState {
  thresholds:         RRRsiThresholds;
  bootstrapComplete:  boolean;  // false until 50 observations in window
  current:            number;   // most recent RSI value
  flags: {
    oversold:          boolean;  // rsi < oversold threshold
    overbought:        boolean;  // rsi > overbought threshold
    // * Bug Fix 1: bullishMomentum and bearishMomentum have the same
    // numeric range (oversold < rsi < overbought). They are NOT duplicates —
    // they are semantically different calling contexts: bullishMomentum is
    // checked for BUY signals, bearishMomentum for SELL signals.
    // The symmetry is intentional. Do not collapse them into one flag.
    bullishMomentum:   boolean;  // RSI in healthy buy zone (above OS, below OB)
    bearishMomentum:   boolean;  // RSI in healthy sell zone (above OS, below OB)
    neutral:           boolean;  // within 0.5σ of mean
  };
}

const SIGMA_OS: Record<CompositeRegime, number> = {
  strongbull: 0.7, weakbull: 1.0, sideways: 1.2, bear: 1.5, uncertain: 1.0,
};
const SIGMA_OB: Record<CompositeRegime, number> = {
  strongbull: 1.5, weakbull: 1.2, sideways: 1.2, bear: 0.7, uncertain: 1.0,
};
const FLOOR: Record<CompositeRegime, number> = {
  strongbull: 40, weakbull: 28, sideways: 22, bear: 18, uncertain: 25,
};
const CEIL: Record<CompositeRegime, number> = {
  strongbull: 85, weakbull: 76, sideways: 75, bear: 65, uncertain: 72,
};
const FALLBACK: Record<CompositeRegime, { os: number; ob: number }> = {
  strongbull: { os: 45, ob: 70 }, weakbull:  { os: 40, ob: 68 },
  bear:       { os: 30, ob: 60 }, sideways:  { os: 35, ob: 65 },
  uncertain:  { os: 35, ob: 65 },
};

const BOOTSTRAP_MIN = 50;

/**
 * Compute dynamic RSI thresholds from the current regime's RSI distribution.
 * Call once per cycle, pass the result into all strategy functions.
 */
export function computeRRRsi(
  rsiHistory: number[],
  regime: CompositeRegime
): RRRsiState {
  const win = rsiHistory.slice(-100).filter(v => isFinite(v) && !isNaN(v));
  const bootstrapComplete = win.length >= BOOTSTRAP_MIN;

  let os: number, ob: number, mean = 50, std = 15;

  if (bootstrapComplete) {
    mean = win.reduce((a, b) => a + b, 0) / win.length;
    const variance = win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length;
    std = Math.sqrt(variance);
    os  = Math.max(FLOOR[regime], mean - SIGMA_OS[regime] * std);
    ob  = Math.min(CEIL[regime],  mean + SIGMA_OB[regime] * std);
  } else {
    os  = FALLBACK[regime].os;
    ob  = FALLBACK[regime].ob;
  }

  const r1  = (n: number) => Math.round(n * 10) / 10;
  const cur = rsiHistory[rsiHistory.length - 1] ?? NaN;

  return {
    thresholds: {
      regime, oversold: r1(os), overbought: r1(ob),
      mean: r1(mean), std: r1(std), windowSize: win.length,
    },
    bootstrapComplete,
    current: cur,
    flags: {
      oversold:        cur < os,
      overbought:      cur > ob,
      bullishMomentum: cur > os && cur < ob,  // intentionally same range as bearishMomentum
      bearishMomentum: cur > os && cur < ob,  // used in sell-side context
      neutral:         Math.abs(cur - mean) < std * 0.5,
    },
  };
}
