// backend/indicators/volumePressureIndex.ts
//
// VPI combines MFI direction, candle body direction, volume surge, and
// divergences into a single [-1, +1] score.
//
// * Bug Fix 5 (scale): VPI always outputs [-1, +1]. ALL threshold comparisons
// in signal_generator.ts must use ±0.60, not ±60.
//
// * Bug Fix 5 (CVD): defaults to OHLCV-only and upgrades to the CVD-enhanced
// path automatically when cvdDelta is provided and non-null.

export type VPILabel =
  | 'strong_buying' | 'moderate_buying' | 'neutral'
  | 'moderate_selling' | 'strong_selling'
  | 'divergent_buying' | 'divergent_selling';

export interface VPIResult {
  score:   number;    // always in [-1, +1]
  label:   VPILabel;
  cvdUsed: boolean;   // true when cvdDelta was provided and used
}

export function computeVPI(
  mfi:        number,
  mfiBullDiv: boolean,
  mfiBearDiv: boolean,
  volRatio:   number,
  close: number, open: number, high: number, low: number,
  cvdDelta?:   number | null,
  cvdDeltaMA?: number | null
): VPIResult {

  // 1. MFI component [-0.35, +0.35]
  const mfiComp =
    mfi >= 80 ? 0.35 : mfi >= 60 ? 0.20 : mfi >= 50 ?  0.08 :
    mfi >= 40 ? -0.05 : mfi >= 20 ? -0.20 : -0.35;

  // 2. CVD component [-0.30, +0.30] — zero when CVD unavailable
  let cvdComp = 0;
  let cvdUsed = false;
  if (cvdDelta != null && cvdDeltaMA != null && Math.abs(cvdDeltaMA) > 1e-9) {
    cvdComp = Math.max(-0.30, Math.min(0.30,
      Math.tanh(cvdDelta / Math.abs(cvdDeltaMA)) * 0.30
    ));
    cvdUsed = true;
  }

  // 3. Candle body direction [-0.20, +0.20]
  const range    = high - low;
  const bodySize = range > 1e-9 ? Math.abs(close - open) / range : 0;
  const bodyComp = (close >= open ? 1 : -1) * bodySize * 0.20;

  // 4. Volume surge [0, +0.15] — direction-signed based on other signals
  const preSum  = mfiComp + cvdComp + bodyComp;
  const surge   = volRatio > 1.5 ? 0.15 : volRatio > 1.2 ? 0.08 : 0;
  const surgeComp = Math.abs(preSum) > 0.05 ? Math.sign(preSum) * surge : 0;

  // 5. Divergence override [-0.15, +0.15]
  const divComp = mfiBullDiv ? 0.15 : mfiBearDiv ? -0.15 : 0;

  const raw   = mfiComp + cvdComp + bodyComp + surgeComp + divComp;
  const score = Math.max(-1, Math.min(1, raw));

  const label: VPILabel =
    (mfiBullDiv && score < -0.20) ? 'divergent_buying'  :
    (mfiBearDiv && score >  0.20) ? 'divergent_selling' :
    score >= 0.60 ? 'strong_buying'    : score >= 0.25 ? 'moderate_buying' :
    score <= -0.60 ? 'strong_selling'  : score <= -0.25 ? 'moderate_selling' :
    'neutral';

  return { score, label, cvdUsed };
}
