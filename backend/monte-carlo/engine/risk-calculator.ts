// Risk Metrics Calculator - VaR, CVaR, and Cornish-Fisher

export class RiskCalculator {
  /**
   * Parametric VaR (Variance-Covariance method)
   * Assumes normal distribution of returns
   */
  parametricVaR(
    returns: number[],
    confidenceLevel: number,
    portfolioValue: number
  ): number {
    const mean = this.mean(returns);
    const std = this.std(returns);
    
    // Z-score for confidence level
    const z = this.normalQuantile(confidenceLevel);
    
    // VaR = -(μ - z*σ) * PortfolioValue
    const varEstimate = -(mean - z * std) * portfolioValue;
    
    return Math.max(0, varEstimate);
  }

  /**
   * Historical VaR (Empirical quantile)
   */
  historicalVaR(
    losses: number[],
    confidenceLevel: number
  ): number {
    const sorted = [...losses].sort((a, b) => b - a); // Descending
    const index = Math.floor((1 - confidenceLevel) * losses.length);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  /**
   * Monte Carlo VaR from simulated paths
   */
  monteCarloVaR(
    simulatedLosses: number[],
    confidenceLevel: number
  ): number {
    return this.historicalVaR(simulatedLosses, confidenceLevel);
  }

  /**
   * Cornish-Fisher VaR (adjusts for skewness and kurtosis)
   */
  cornishFisherVaR(
    returns: number[],
    confidenceLevel: number,
    portfolioValue: number
  ): number {
    const mean = this.mean(returns);
    const std = this.std(returns);
    const skew = this.skewness(returns);
    const kurt = this.kurtosis(returns);

    // Standard normal quantile
    const z = this.normalQuantile(confidenceLevel);

    // Cornish-Fisher expansion
    const z_cf = z +
      (Math.pow(z, 2) - 1) * skew / 6 +
      (Math.pow(z, 3) - 3 * z) * kurt / 24 -
      (2 * Math.pow(z, 3) - 5 * z) * Math.pow(skew, 2) / 36;

    const varEstimate = -(mean - z_cf * std) * portfolioValue;

    return Math.max(0, varEstimate);
  }

  /**
   * Component VaR (Euler allocation)
   */
  componentVaR(
    portfolioReturns: number[],
    marginalContributions: number[]
  ): number[] {
    const totalVaR = this.historicalVaR(portfolioReturns, 0.95);

    // Marginal VaR contribution
    return marginalContributions.map(mc => {
      return totalVaR * (mc / this.sum(marginalContributions));
    });
  }

  /**
   * Conditional VaR (Expected Shortfall)
   * CVaR = E[Loss | Loss > VaR]
   */
  conditionalVaR(
    losses: number[],
    confidenceLevel: number
  ): number {
    const varEstimate = this.historicalVaR(losses, confidenceLevel);
    
    // Average of losses exceeding VaR
    const tailLosses = losses.filter(l => l >= varEstimate);
    
    if (tailLosses.length === 0) {
      return varEstimate;
    }
    
    const sum = tailLosses.reduce((a, b) => a + b, 0);
    return sum / tailLosses.length;
  }

  /**
   * Kupiec's Proportion of Failures test
   * Tests if VaR model is correctly calibrated
   */
  kupiecTest(
    actualLosses: number[],
    varEstimate: number,
    confidenceLevel: number
  ): {
    passes: boolean;
    pValue: number;
    failureRate: number;
    expectedRate: number;
  } {
    const n = actualLosses.length;
    const failures = actualLosses.filter(l => l > varEstimate).length;
    const p = failures / n;
    const alpha = 1 - confidenceLevel;
    
    // Likelihood ratio test
    const lr = -2 * Math.log(
      Math.pow(1 - alpha, n - failures) * Math.pow(alpha, failures) /
      (Math.pow(1 - p, n - failures) * Math.pow(p, failures))
    );
    
    // Chi-square(1) critical value at 95%
    const criticalValue = 3.841;
    const pValue = 1 - this.chi2CDF(lr, 1);
    
    return {
      passes: lr < criticalValue,
      pValue,
      failureRate: p,
      expectedRate: alpha
    };
  }

  /**
   * Backtest VaR model
   */
  backtestVaR(
    actualReturns: number[],
    varEstimates: number[],
    confidenceLevel: number
  ): {
    unconditional: boolean;
    independence: boolean;
    conditional: boolean;
    pValue: number;
  } {
    // Unconditional coverage (Kupiec)
    const kupiec = this.kupiecTest(actualReturns, this.mean(varEstimates), confidenceLevel);
    
    // Independence test (simplified)
    const independence = this.testIndependence(actualReturns, varEstimates);
    
    return {
      unconditional: kupiec.passes,
      independence,
      conditional: kupiec.passes && independence,
      pValue: kupiec.pValue
    };
  }

  /**
   * Calculate portfolio loss distribution from paths
   */
  calculateLossDistribution(
    paths: Float64Array,
    timeSteps: number,
    portfolioValue: number
  ): number[] {
    const numPaths = paths.length / (timeSteps + 1);
    const losses: number[] = [];
    
    for (let i = 0; i < numPaths; i++) {
      const baseIdx = i * (timeSteps + 1);
      const startPrice = paths[baseIdx];
      const endPrice = paths[baseIdx + timeSteps];
      
      // Calculate portfolio loss
      const loss = (startPrice - endPrice) / startPrice * portfolioValue;
      losses.push(Math.max(0, loss));
    }
    
    return losses;
  }

  /**
   * Calculate tail risk metrics
   */
  calculateTailRisk(
    losses: number[],
    confidenceLevels: number[]
  ): {
    worstCaseLoss: number;
    percentile99_9: number;
    var: Record<string, number>;
    cvar: Record<string, number>;
  } {
    const sorted = [...losses].sort((a, b) => b - a);
    
    const varResults: Record<string, number> = {};
    const cvar: Record<string, number> = {};
    
    confidenceLevels.forEach(cl => {
      const key = `${Math.round(cl * 100)}%`;
      varResults[key] = this.historicalVaR(losses, cl);
      cvar[key] = this.conditionalVaR(losses, cl);
    });
    
    return {
      worstCaseLoss: sorted[0],
      percentile99_9: sorted[Math.floor(0.001 * sorted.length)],
      var: varResults,
      cvar
    };
  }

  // ========== Helper Methods ==========

  private mean(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  private std(arr: number[]): number {
    const m = this.mean(arr);
    const variance = arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }

  private skewness(arr: number[]): number {
    const m = this.mean(arr);
    const s = this.std(arr);
    const n = arr.length;
    
    const sum = arr.reduce((a, b) => a + Math.pow((b - m) / s, 3), 0);
    return (n / ((n - 1) * (n - 2))) * sum;
  }

  private kurtosis(arr: number[]): number {
    const m = this.mean(arr);
    const s = this.std(arr);
    const n = arr.length;
    
    const sum = arr.reduce((a, b) => a + Math.pow((b - m) / s, 4), 0);
    return (n * (n + 1) / ((n - 1) * (n - 2) * (n - 3))) * sum - 3 * Math.pow(n - 1, 2) / ((n - 2) * (n - 3));
  }

  private sum(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0);
  }

  /**
   * Inverse CDF of standard normal distribution
   * Using Acklam's approximation
   */
  private normalQuantile(p: number): number {
    // Coefficients for Acklam's approximation
    const a = [
      -3.969683028665376e+01,  2.209460984245205e+02,
      -2.759285104469687e+02,  1.383577518672690e+02,
      -3.066479806614716e+01,  2.506628277459239e+00
    ];
    
    const b = [
      -5.447609879822406e+01,  1.615858368580409e+02,
      -1.556989798598866e+02,  6.680131188771972e+01,
      -1.328068155288572e+01
    ];
    
    const c = [
      -7.784894002430293e-03, -3.223964580411365e-01,
      -2.400758277161838e+00, -2.549732539343734e+00,
       4.374664141464968e+00,  2.938163982698783e+00
    ];
    
    const d = [
      7.784695709041462e-03,  3.224671290700398e-01,
      2.445134137142996e+00,  3.754408661907416e+00
    ];
    
    // Define breakpoints
    const pLow = 0.02425;
    const pHigh = 1 - pLow;
    
    if (p < 0 || p > 1) {
      throw new Error('Probability must be between 0 and 1');
    }
    
    if (p < pLow) {
      // Lower region
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
             ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= pHigh) {
      // Central region
      const q = p - 0.5;
      const r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
             (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
      // Upper region
      const q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
              ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
  }

  private chi2CDF(x: number, df: number): number {
    // Approximation of chi-square CDF
    // Using incomplete gamma function approximation
    return this.gammaInc(df / 2, x / 2);
  }

  private gammaInc(a: number, x: number): number {
    // Lower incomplete gamma function approximation
    if (x < a + 1) {
      // Series expansion
      let ap = a;
      let sum = 1 / a;
      let del = sum;
      
      for (let n = 1; n <= 100; n++) {
        ap += 1;
        del *= x / ap;
        sum += del;
        
        if (Math.abs(del) < Math.abs(sum) * 1e-10) {
          return sum * Math.exp(-x + a * Math.log(x) - this.lnGamma(a));
        }
      }
    } else {
      // Continued fraction
      let b = x + 1 - a;
      let c = 1 / 1e-30;
      let d = 1 / b;
      let h = d;
      
      for (let i = 1; i <= 100; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b;
        
        if (Math.abs(d) < 1e-30) d = 1e-30;
        
        c = b + an / c;
        
        if (Math.abs(c) < 1e-30) c = 1e-30;
        
        d = 1 / d;
        const del = d * c;
        h *= del;
        
        if (Math.abs(del - 1) < 1e-10) {
          return 1 - h * Math.exp(-x + a * Math.log(x) - this.lnGamma(a));
        }
      }
    }
    
    return 1;
  }

  private lnGamma(x: number): number {
    // Stirling's approximation
    const cof = [
      76.18009172947146,    -86.50532032941677,
      24.01409824083091,    -1.231739572450155,
      0.1208650973866179e-2, -0.5395239384953e-5
    ];
    
    let y = x;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    
    for (let j = 0; j < 6; j++) {
      ser += cof[j] / ++y;
    }
    
    return -tmp + Math.log(2.5066282746310007 * ser / x);
  }

  private testIndependence(
    actualLosses: number[],
    varEstimates: number[]
  ): boolean {
    // Simplified independence test
    // Check for clustering of failures
    let clusters = 0;
    let inCluster = false;
    
    for (let i = 0; i < actualLosses.length; i++) {
      if (actualLosses[i] > varEstimates[i]) {
        if (!inCluster) {
          clusters++;
          inCluster = true;
        }
      } else {
        inCluster = false;
      }
    }
    
    // If too many clusters, may indicate dependence
    const expectedClusters = actualLosses.length * 0.05; // Assuming 5% failure rate
    return clusters < expectedClusters * 2;
  }

  private mean(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  private std(arr: number[]): number {
    const m = this.mean(arr);
    return Math.sqrt(arr.reduce((a, b) => (b - m) ** 2, 0) / arr.length);
  }

  private sum(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0);
  }

  private normalQuantile(confidenceLevel: number): number {
    // Approximation using inverse error function
    // For standard normal, quantile at p is approx norminv(p)
    const p = 1 - confidenceLevel;
    // Using approximation formula
    const a1 = -3.969683028665376e+01;
    const a2 = 2.209460984245205e+02;
    const a3 = -2.759285104469687e+02;
    const a4 = 1.383577518672690e+02;
    const a5 = -3.066479806614716e+01;
    const a6 = 2.506628277459239e+00;

    const b1 = -5.447609879822406e+01;
    const b2 = 1.615858368580409e+02;
    const b3 = -1.556989798598866e+02;
    const b4 = 6.680131188771972e+01;
    const b5 = -1.328068155288572e+01;

    const c1 = -7.784894002430293e-03;
    const c2 = -3.223964580411365e-01;
    const c3 = -2.400758277161838e+00;
    const c4 = -2.549732539343734e+00;
    const c5 = 4.374664141464968e+00;
    const c6 = 2.938163982698783e+00;

    const d1 = 7.784695709041462e-03;
    const d2 = 3.224671290700398e-01;
    const d3 = 2.445134137142996e+00;
    const d4 = 3.754408661907416e+00;

    const p_low = 0.02425;
    const p_high = 1 - p_low;

    let q;
    if (p < p_low) {
      const q1 = Math.sqrt(-2 * Math.log(p));
      q = (((((c1 * q1 + c2) * q1 + c3) * q1 + c4) * q1 + c5) * q1 + c6) / ((((d1 * q1 + d2) * q1 + d3) * q1 + d4) * q1 + 1);
    } else if (p <= p_high) {
      const q1 = p - 0.5;
      const q2 = q1 * q1;
      q = (((((a1 * q2 + a2) * q2 + a3) * q2 + a4) * q2 + a5) * q2 + a6) * q1 / (((((b1 * q2 + b2) * q2 + b3) * q2 + b4) * q2 + b5) * q2 + 1);
    } else {
      const q1 = Math.sqrt(-2 * Math.log(1 - p));
      q = -(((((c1 * q1 + c2) * q1 + c3) * q1 + c4) * q1 + c5) * q1 + c6) / ((((d1 * q1 + d2) * q1 + d3) * q1 + d4) * q1 + 1);
    }
    return q;
  }
}
