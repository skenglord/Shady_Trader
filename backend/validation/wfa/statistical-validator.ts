import { OptimizationResult } from './rolling-optimizer';
import { OverfittingDiagnostic } from './overfitting-detector';

export interface StatisticalTestResult {
  testName: string;
  statistic: number;
  pValue: number;
  isSignificant: boolean;
  interpretation: string;
}

export interface ValidationReport {
  whiteRealityCheck: StatisticalTestResult;
  hansenSPA: StatisticalTestResult;
  probabilisticSharpeRatio: StatisticalTestResult;
  bootstrapAnalysis: BootstrapResult;
  falseDiscoveryRate: FDRResult;
  overallValidationScore: number;
  validationPassed: boolean;
  recommendations: string[];
}

export interface BootstrapResult {
  sharpeRatioCI: [number, number];
  maxDrawdownCI: [number, number];
  winRateCI: [number, number];
  confidenceLevel: number;
  sampleSize: number;
}

export interface FDRResult {
  originalPValues: number[];
  adjustedPValues: number[];
  rejectedHypotheses: boolean[];
  criticalValue: number;
}

export class StatisticalValidator {
  private readonly benchmarkSharpe = 0; // Buy-and-hold Sharpe ratio
  private readonly significanceLevel = 0.05;
  private readonly bootstrapSamples = 1000;
  private readonly targetPSR = 0.95;

  /**
   * Run comprehensive statistical validation on optimization results
   */
  async validateOptimization(
    results: OptimizationResult[],
    overfittingDiagnostic: OverfittingDiagnostic
  ): Promise<ValidationReport> {
    const whiteRealityCheck = await this.whiteRealityCheck(results);
    const hansenSPA = this.hansenSuperiorPredictiveAbility(results);
    const probabilisticSharpeRatio = this.probabilisticSharpeRatio(results);
    const bootstrapAnalysis = this.bootstrapConfidenceIntervals(results);
    const falseDiscoveryRate = this.falseDiscoveryRate([whiteRealityCheck, hansenSPA, probabilisticSharpeRatio]);

    const overallValidationScore = this.calculateOverallScore({
      whiteRealityCheck,
      hansenSPA,
      probabilisticSharpeRatio,
      bootstrapAnalysis,
      falseDiscoveryRate,
    });

    const validationPassed = overallValidationScore >= 0.7;
    const recommendations = this.generateValidationRecommendations({
      whiteRealityCheck,
      hansenSPA,
      probabilisticSharpeRatio,
      bootstrapAnalysis,
      falseDiscoveryRate,
    }, overfittingDiagnostic);

    return {
      whiteRealityCheck,
      hansenSPA,
      probabilisticSharpeRatio,
      bootstrapAnalysis,
      falseDiscoveryRate,
      overallValidationScore,
      validationPassed,
      recommendations,
    };
  }

  /**
   * White Reality Check: Tests if best IS performance is statistically different from benchmark
   */
  private async whiteRealityCheck(results: OptimizationResult[]): Promise<StatisticalTestResult> {
    if (results.length < 2) {
      return {
        testName: 'White Reality Check',
        statistic: 0,
        pValue: 1,
        isSignificant: false,
        interpretation: 'Insufficient data for White Reality Check',
      };
    }

    // Get in-sample Sharpe ratios
    const isSharpeRatios = results.map(r => r.inSampleSharpe).sort((a, b) => b - a); // Descending

    // Calculate the test statistic: proportion of strategies that beat benchmark
    const strategiesBeatingBenchmark = isSharpeRatios.filter(s => s > this.benchmarkSharpe).length;
    const proportion = strategiesBeatingBenchmark / isSharpeRatios.length;

    // Use binomial test approximation
    const n = isSharpeRatios.length;
    const p = 0.5; // Null hypothesis: 50% chance of beating benchmark by luck
    const variance = (p * (1 - p)) / n;
    const stdDev = Math.sqrt(variance);

    // Z-statistic for proportion test
    const zStatistic = (proportion - p) / stdDev;
    const pValue = this.normalCDF(-Math.abs(zStatistic)) * 2; // Two-tailed

    const isSignificant = pValue < this.significanceLevel;

    return {
      testName: 'White Reality Check',
      statistic: zStatistic,
      pValue,
      isSignificant,
      interpretation: isSignificant
        ? `Strategy performance is statistically different from benchmark (p=${pValue.toFixed(4)})`
        : `No statistical difference from benchmark performance (p=${pValue.toFixed(4)})`,
    };
  }

  /**
   * Hansen Superior Predictive Ability: Controls for data-snooping bias
   */
  private hansenSuperiorPredictiveAbility(results: OptimizationResult[]): StatisticalTestResult {
    if (results.length < 10) {
      return {
        testName: 'Hansen Superior Predictive Ability',
        statistic: 0,
        pValue: 1,
        isSignificant: false,
        interpretation: 'Insufficient strategies for Hansen SPA test',
      };
    }

    // Calculate the Hansen SPA statistic
    const oosSharpeRatios = results.map(r => r.outOfSampleSharpe);
    const meanOOS = this.mean(oosSharpeRatios);
    const stdOOS = this.standardDeviation(oosSharpeRatios, meanOOS);

    if (stdOOS === 0) {
      return {
        testName: 'Hansen Superior Predictive Ability',
        statistic: 0,
        pValue: 1,
        isSignificant: false,
        interpretation: 'No variation in OOS performance',
      };
    }

    // T-statistic: (mean - benchmark) / (std / sqrt(n))
    const tStatistic = (meanOOS - this.benchmarkSharpe) / (stdOOS / Math.sqrt(oosSharpeRatios.length));
    const pValue = this.studentTPValue(tStatistic, oosSharpeRatios.length - 1);

    const isSignificant = pValue < this.significanceLevel;

    return {
      testName: 'Hansen Superior Predictive Ability',
      statistic: tStatistic,
      pValue,
      isSignificant,
      interpretation: isSignificant
        ? `Superior predictive ability confirmed (p=${pValue.toFixed(4)})`
        : `No superior predictive ability detected (p=${pValue.toFixed(4)})`,
    };
  }

  /**
   * Probabilistic Sharpe Ratio: Probability that true Sharpe exceeds benchmark
   */
  private probabilisticSharpeRatio(results: OptimizationResult[]): StatisticalTestResult {
    if (results.length === 0) {
      return {
        testName: 'Probabilistic Sharpe Ratio',
        statistic: 0,
        pValue: 1,
        isSignificant: false,
        interpretation: 'No data available',
      };
    }

    // Calculate PSR using the formula from Bailey and Lopez de Prado (2014)
    const oosSharpeRatios = results.map(r => r.outOfSampleSharpe);
    const sharpeHat = this.mean(oosSharpeRatios);
    const n = oosSharpeRatios.length;

    if (n < 2) {
      return {
        testName: 'Probabilistic Sharpe Ratio',
        statistic: 0,
        pValue: 1,
        isSignificant: false,
        interpretation: 'Insufficient observations',
      };
    }

    // Estimated Sharpe ratio standard error
    const sharpeStdErr = Math.sqrt((1 + sharpeHat * sharpeHat / 2) / (n - 1));

    // PSR calculation
    const zStatistic = sharpeHat / sharpeStdErr;
    const psr = this.normalCDF(zStatistic);

    const isSignificant = psr >= this.targetPSR;

    return {
      testName: 'Probabilistic Sharpe Ratio',
      statistic: psr,
      pValue: 1 - psr, // P-value is complement of PSR
      isSignificant,
      interpretation: `Probability of Sharpe > 0: ${(psr * 100).toFixed(1)}% (${isSignificant ? 'meets' : 'below'} ${this.targetPSR * 100}% target)`,
    };
  }

  /**
   * Bootstrap confidence intervals for performance metrics
   */
  private bootstrapConfidenceIntervals(results: OptimizationResult[]): BootstrapResult {
    const sharpeRatios = results.map(r => r.outOfSampleSharpe);
    const drawdowns = results.map(r => r.outOfSampleMaxDrawdown);
    const winRates = results.map(r => r.winRate);

    const sharpeCI = this.bootstrapCI(sharpeRatios, this.bootstrapSamples, 0.95);
    const drawdownCI = this.bootstrapCI(drawdowns, this.bootstrapSamples, 0.95);
    const winRateCI = this.bootstrapCI(winRates, this.bootstrapSamples, 0.95);

    return {
      sharpeRatioCI: sharpeCI,
      maxDrawdownCI: drawdownCI,
      winRateCI: winRateCI,
      confidenceLevel: 0.95,
      sampleSize: this.bootstrapSamples,
    };
  }

  /**
   * False Discovery Rate control using Benjamini-Hochberg procedure
   */
  private falseDiscoveryRate(tests: StatisticalTestResult[]): FDRResult {
    const pValues = tests.map(t => t.pValue).sort((a, b) => a - b);
    const m = pValues.length;

    // Benjamini-Hochberg critical values
    const adjustedPValues: number[] = [];
    const rejectedHypotheses: boolean[] = [];

    for (let i = 0; i < m; i++) {
      const adjustedPValue = pValues[i] * m / (i + 1);
      adjustedPValues.push(Math.min(adjustedPValue, 1));
    }

    // Find the largest k such that P_(k) <= k/m * alpha
    let k = -1;
    for (let i = 0; i < m; i++) {
      if (pValues[i] <= ((i + 1) / m) * this.significanceLevel) {
        k = i;
      }
    }

    const criticalValue = k >= 0 ? pValues[k] : 0;

    // Determine which hypotheses are rejected
    for (let i = 0; i < m; i++) {
      rejectedHypotheses.push(pValues[i] <= criticalValue);
    }

    return {
      originalPValues: pValues,
      adjustedPValues,
      rejectedHypotheses,
      criticalValue,
    };
  }

  /**
   * Calculate overall validation score
   */
  private calculateOverallScore(report: Omit<ValidationReport, 'overallValidationScore' | 'validationPassed' | 'recommendations'>): number {
    const weights = {
      whiteRealityCheck: 0.25,
      hansenSPA: 0.25,
      probabilisticSharpeRatio: 0.3,
      bootstrapAnalysis: 0.1,
      falseDiscoveryRate: 0.1,
    };

    let score = 0;

    // White Reality Check
    score += weights.whiteRealityCheck * (report.whiteRealityCheck.isSignificant ? 1 : 0);

    // Hansen SPA
    score += weights.hansenSPA * (report.hansenSPA.isSignificant ? 1 : 0);

    // Probabilistic Sharpe Ratio
    const psrScore = Math.min(1, report.probabilisticSharpeRatio.statistic / this.targetPSR);
    score += weights.probabilisticSharpeRatio * psrScore;

    // Bootstrap Analysis - score based on confidence interval width
    const sharpeRange = report.bootstrapAnalysis.sharpeRatioCI[1] - report.bootstrapAnalysis.sharpeRatioCI[0];
    const bootstrapScore = Math.max(0, 1 - sharpeRange / 2); // Penalize wide intervals
    score += weights.bootstrapAnalysis * bootstrapScore;

    // False Discovery Rate - score based on proportion of rejected hypotheses
    const fdrScore = report.falseDiscoveryRate.rejectedHypotheses.filter(Boolean).length / report.falseDiscoveryRate.rejectedHypotheses.length;
    score += weights.falseDiscoveryRate * fdrScore;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Generate validation recommendations
   */
  private generateValidationRecommendations(
    report: Omit<ValidationReport, 'overallValidationScore' | 'validationPassed' | 'recommendations'>,
    overfittingDiagnostic: OverfittingDiagnostic
  ): string[] {
    const recommendations: string[] = [];

    if (!report.whiteRealityCheck.isSignificant) {
      recommendations.push('White Reality Check failed: Strategy performance not statistically different from benchmark. Consider fundamental strategy review.');
    }

    if (!report.hansenSPA.isSignificant) {
      recommendations.push('Hansen SPA test failed: No superior predictive ability detected. Data-snooping bias may be present.');
    }

    if (!report.probabilisticSharpeRatio.isSignificant) {
      recommendations.push(`Probabilistic Sharpe Ratio below target: ${(report.probabilisticSharpeRatio.statistic * 100).toFixed(1)}% < ${(this.targetPSR * 100).toFixed(1)}%. Strategy risk-adjusted returns insufficient.`);
    }

    if (report.bootstrapAnalysis.sharpeRatioCI[1] - report.bootstrapAnalysis.sharpeRatioCI[0] > 1) {
      recommendations.push('Wide confidence intervals indicate unstable performance. Consider more robust parameter optimization or increased sample size.');
    }

    if (report.falseDiscoveryRate.rejectedHypotheses.filter(Boolean).length === 0) {
      recommendations.push('All statistical tests failed multiple testing correction. Consider alternative strategy approaches.');
    }

    if (overfittingDiagnostic.metrics.isOverfitted) {
      recommendations.push('Overfitting detected. Statistical validation results may be unreliable due to model instability.');
    }

    if (recommendations.length === 0) {
      recommendations.push('All statistical validation tests passed. Strategy demonstrates robust performance characteristics.');
    }

    return recommendations;
  }

  // Utility functions

  private bootstrapCI(data: number[], nSamples: number, confidence: number): [number, number] {
    const samples: number[] = [];

    for (let i = 0; i < nSamples; i++) {
      const sample = this.resample(data);
      samples.push(this.mean(sample));
    }

    samples.sort((a, b) => a - b);
    const lowerIndex = Math.floor((1 - confidence) / 2 * nSamples);
    const upperIndex = Math.floor((1 + confidence) / 2 * nSamples);

    return [samples[lowerIndex], samples[upperIndex]];
  }

  private resample(data: number[]): number[] {
    const sample: number[] = [];
    for (let i = 0; i < data.length; i++) {
      sample.push(data[Math.floor(Math.random() * data.length)]);
    }
    return sample;
  }

  private normalCDF(x: number): number {
    // Abramowitz & Stegun approximation
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);
    const t = 1 / (1 + p * absX);

    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

    return sign < 0 ? 1 - y : y;
  }

  private studentTPValue(t: number, df: number): number {
    // Simplified approximation for t-distribution p-value
    // For large df, approaches normal distribution
    if (df > 30) {
      return this.normalCDF(-Math.abs(t)) * 2;
    }

    // Use normal approximation for now (simplified)
    return this.normalCDF(-Math.abs(t)) * 2;
  }

  private mean(values: number[]): number {
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  private standardDeviation(values: number[], mean?: number): number {
    const avg = mean ?? this.mean(values);
    const squaredDiffs = values.map(val => Math.pow(val - avg, 2));
    return Math.sqrt(this.mean(squaredDiffs));
  }
}