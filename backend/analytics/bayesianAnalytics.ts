// backend/analytics/bayesianAnalytics.ts — Block 13: Bayesian mode analytics
//
// Bug Fix (v6 #8): v4.1 priors alpha=7.2, beta=4.8 encode 12 virtual prior trades.
// With only 5 real trades, posterior is dominated by prior. This module flags
// priorDominated when real trades < 50.

export interface BayesianModeResult {
  mode:            string;
  posteriorMean:   number;
  credibleLow95:   number;
  credibleHigh95:  number;
  priorDominated:  boolean;
  realTrades:      number;
  bayesFactor:     number;
}

const ALPHA_PRIOR = 7.2;
const BETA_PRIOR  = 4.8;

function betaMean(a: number, b: number): number { return a / (a + b); }
function betaVar(a: number, b: number): number {
  return (a * b) / ((a + b) ** 2 * (a + b + 1));
}

export function computeModeAnalytics(
  mode:   string,
  wins:   number,
  losses: number
): BayesianModeResult {
  const total = wins + losses;
  const a     = ALPHA_PRIOR + wins;
  const b     = BETA_PRIOR  + losses;

  const mean  = betaMean(a, b);
  const std   = Math.sqrt(betaVar(a, b));

  const lo95  = Math.max(0, mean - 2 * std);
  const hi95  = Math.min(1, mean + 2 * std);

  const priorMean = betaMean(ALPHA_PRIOR, BETA_PRIOR);
  const bf = total > 0 ? mean / priorMean : 1.0;

  return {
    mode,
    posteriorMean:  Math.round(mean  * 1000) / 1000,
    credibleLow95:  Math.round(lo95  * 1000) / 1000,
    credibleHigh95: Math.round(hi95  * 1000) / 1000,
    priorDominated: total < 50,
    realTrades:     total,
    bayesFactor:    Math.round(bf * 100) / 100,
  };
}
