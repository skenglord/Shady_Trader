// backend/slippage/fillCalculator.ts
//
// All slippage values are FRACTIONS (0.0005 = 0.05%, never 0.05 = 5%).
// The _Frac suffix is used exclusively. The existing SlippageEngine already
// emits fractions (e.g. 0.001 = 0.1%); this module standardises consumption.

export interface FillResult {
  fillPrice:     number;
  slippageFrac:  number;   // fraction of price (e.g., 0.0005)
  feeFrac:       number;   // fraction of notional (e.g., 0.0006)
  totalCostFrac: number;   // slippageFrac + feeFrac
  skipped:       boolean;  // true if slippage:TP ratio exceeds threshold
  skipReason?:   string;
}

const TAKER_FEE  = parseFloat(process.env.TAKER_FEE_RATE      ?? '0.0006');
const SKIP_RATIO = parseFloat(process.env.SLIPPAGE_SKIP_THRESHOLD ?? '0.45');

export function computeFill(
  side:           'buy' | 'sell',
  midPrice:       number,
  tpDistanceFrac: number,
  slippageFrac:   number
): FillResult {
  if (tpDistanceFrac > 0 && (slippageFrac / tpDistanceFrac) > SKIP_RATIO) {
    return {
      fillPrice: midPrice, slippageFrac, feeFrac: 0, totalCostFrac: 0,
      skipped: true,
      skipReason: `Slippage (${(slippageFrac * 100).toFixed(3)}%) eats ` +
        `${((slippageFrac / tpDistanceFrac) * 100).toFixed(0)}% of TP`,
    };
  }

  const fillPrice = side === 'buy'
    ? midPrice * (1 + slippageFrac)
    : midPrice * (1 - slippageFrac);

  return {
    fillPrice, slippageFrac,
    feeFrac:       TAKER_FEE,
    totalCostFrac: slippageFrac + TAKER_FEE,
    skipped: false,
  };
}

export function computeNetPnL(
  side:      'buy' | 'sell',
  notional:  number,
  entry:     FillResult,
  exit:      FillResult
): number {
  const gross = side === 'buy'
    ? (exit.fillPrice - entry.fillPrice) / entry.fillPrice * notional
    : (entry.fillPrice - exit.fillPrice) / entry.fillPrice * notional;
  return gross - (entry.feeFrac + exit.feeFrac) * notional;
}

export function adjustStopForSlippage(
  rawStop: number, side: 'buy' | 'sell', slippageFrac: number
): number {
  if (slippageFrac <= 0) return rawStop;
  return side === 'buy'
    ? rawStop * (1 - slippageFrac)   // widen stop down for longs
    : rawStop * (1 + slippageFrac);  // widen stop up for shorts
}
