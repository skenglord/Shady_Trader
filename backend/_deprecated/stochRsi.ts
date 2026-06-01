// backend/_deprecated/stochRsi.ts
// DEPRECATED: Replaced by WaveTrend in Block 3 of v6.0 upgrade.
// StochRSI was removed due to ~0.75 correlation with WaveTrend
// (double-counting the same information in signal scoring).
// Last used: Phase 1 pre-v6 implementation.
// Safe to delete after Phase 3 validation.

import { StochasticRSI } from 'technicalindicators';

export function calculateStochRSI(closes: number[]) {
  return StochasticRSI.calculate({
    rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3, values: closes
  });
}
