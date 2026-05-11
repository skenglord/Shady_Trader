import { OptimizationResult, ParameterSet } from './rolling-optimizer';
import { DataPartition } from './data-partitioner';

export interface OverfittingMetrics {
  divergenceRatio: number;
  correlationDecay: number;
  shapeTestPValue: number;
  complexityPenalty: number;
  overallOverfittingScore: number;
  isOverfitted: boolean;
}

export interface StabilityAnalysis {
  parameterStability: number;
  performanceConsistency: number;
  drawdownStability: number;
  overallStability: number;
}

export interface OverfittingDiagnostic {
  metrics: OverfittingMetrics;
  stability: StabilityAnalysis;
  recommendations: string[];
  confidenceLevel: number;
}

export class OverfittingDetector {
  private readonly divergenceThreshold = 0.3;
  private readonly correlationThreshold = 0.4;
  private readonly shapeTestThreshold = 0.05;
  private readonly stabilityThreshold = 0.7;

  /**
   * Analyze overfitting across multiple optimization results
   */
  analyzeOverfitting(
    optimizationResults: OptimizationResult[],
    partitions: DataPartition[]
  ): OverfittingDiagnostic {
    const metrics = this.calculateOverfittingMetrics(optimizationResults);
    const stability = this.calculateStabilityAnalysis(optimizationResults);
    const recommendations = this.generateRecommendations(metrics, stability);
    const confidenceLevel = this.calculateConfidenceLevel(metrics, stability);

    return {
      metrics,
      stability,
      recommendations,
      confidenceLevel,
    };
  }

  /**
   * Calculate overfitting metrics between IS and OOS performance
   */
  private calculateOverfittingMetrics(results: OptimizationResult[]): OverfittingMetrics {
    if (results.length === 0) {
      throw new Error('Cannot analyze overfitting with empty results');
    }

    // Extract IS and OOS performance arrays
    const isSharpeRatios = results.map(r => r.inSampleSharpe);
    const oosSharpeRatios = results.map(r => r.outOfSampleSharpe);
    const isDrawdowns = results.map(r => r.inSampleMaxDrawdown);
    const oosDrawdowns = results.map(r => r.outOfSampleMaxDrawdown);

    // Calculate divergence ratio: |μ_IS - μ_OOS| / σ_IS
    const isSharpeMean = this.mean(isSharpeRatios);
    const oosSharpeMean = this.mean(oosSharpeRatios);
    const isSharpeStd = this.standardDeviation(isSharpeRatios, isSharpeMean);
    const divergenceRatio = isSharpeStd > 0 ? Math.abs(isSharpeMean - oosSharpeMean) / isSharpeStd : 0;

    // Calculate correlation decay: rolling correlation between IS/OOS returns
    const correlationDecay = this.calculateCorrelationDecay(isSharpeRatios, oosSharpeRatios);

    // Calculate shape test: KS test on return distributions
    const shapeTestPValue = this.kolmogorovSmirnovTest(isSharpeRatios, oosSharpeRatios);

    // Calculate complexity penalty: SIC for parameter count (simplified)
    const avgParameterCount = this.mean(results.map(r => this.countParameters(r.parameters)));
    const complexityPenalty = Math.log(results.length) * avgParameterCount / results.length;

    // Overall overfitting score (0-1, higher = more overfitted)
    const overallOverfittingScore = (
      (divergenceRatio > this.divergenceThreshold ? 1 : divergenceRatio / this.divergenceThreshold) * 0.4 +
      (correlationDecay < this.correlationThreshold ? 1 : (1 - correlationDecay) / (1 - this.correlationThreshold)) * 0.3 +
      (shapeTestPValue < this.shapeTestThreshold ? 1 : shapeTestPValue / this.shapeTestThreshold) * 0.2 +
      Math.min(complexityPenalty / 10, 1) * 0.1
    );

    const isOverfitted = overallOverfittingScore > 0.6;

    return {
      divergenceRatio,
      correlationDecay,
      shapeTestPValue,
      complexityPenalty,
      overallOverfittingScore,
      isOverfitted,
    };
  }

  /**
   * Calculate stability analysis across optimization folds
   */
  private calculateStabilityAnalysis(results: OptimizationResult[]): StabilityAnalysis {
    if (results.length < 2) {
      return {
        parameterStability: 1,
        performanceConsistency: 1,
        drawdownStability: 1,
        overallStability: 1,
      };
    }

    // Parameter stability: coefficient of variation of key parameters
    const confidenceThresholds = results.map(r => r.parameters.confidenceThreshold);
    const stopLosses = results.map(r => r.parameters.stopLoss);
    const takeProfits = results.map(r => r.parameters.takeProfit);

    const paramStability = 1 - (
      this.coefficientOfVariation(confidenceThresholds) +
      this.coefficientOfVariation(stopLosses) +
      this.coefficientOfVariation(takeProfits)
    ) / 3;

    // Performance consistency: correlation of fitness scores across folds
    const fitnessScores = results.map(r => r.fitnessScore);
    const performanceConsistency = this.mean(fitnessScores) > 0 ?
      Math.max(0, 1 - this.standardDeviation(fitnessScores, this.mean(fitnessScores)) / Math.abs(this.mean(fitnessScores))) : 0;

    // Drawdown stability: consistency of max drawdown across folds
    const drawdowns = results.map(r => r.outOfSampleMaxDrawdown);
    const drawdownStability = 1 - this.coefficientOfVariation(drawdowns);

    // Overall stability score
    const overallStability = (paramStability + performanceConsistency + drawdownStability) / 3;

    return {
      parameterStability: Math.max(0, Math.min(1, paramStability)),
      performanceConsistency: Math.max(0, Math.min(1, performanceConsistency)),
      drawdownStability: Math.max(0, Math.min(1, drawdownStability)),
      overallStability: Math.max(0, Math.min(1, overallStability)),
    };
  }

  /**
   * Generate recommendations based on overfitting analysis
   */
  private generateRecommendations(metrics: OverfittingMetrics, stability: StabilityAnalysis): string[] {
    const recommendations: string[] = [];

    if (metrics.divergenceRatio > this.divergenceThreshold) {
      recommendations.push('High divergence between IS/OOS performance detected. Consider reducing model complexity or increasing regularization.');
    }

    if (metrics.correlationDecay < this.correlationThreshold) {
      recommendations.push('Poor correlation between IS/OOS returns. Model may be overfitting to historical data patterns.');
    }

    if (metrics.shapeTestPValue < this.shapeTestThreshold) {
      recommendations.push('IS/OOS return distributions are significantly different. Consider using more robust out-of-sample testing.');
    }

    if (metrics.complexityPenalty > 5) {
      recommendations.push('High parameter count detected. Consider parameter reduction or feature selection.');
    }

    if (stability.parameterStability < this.stabilityThreshold) {
      recommendations.push('Parameter values are unstable across folds. Consider increasing regularization or using parameter constraints.');
    }

    if (stability.performanceConsistency < this.stabilityThreshold) {
      recommendations.push('Performance metrics are inconsistent across folds. Consider walk-forward validation with more folds.');
    }

    if (stability.drawdownStability < this.stabilityThreshold) {
      recommendations.push('Drawdown patterns are unstable. Consider implementing stricter risk management rules.');
    }

    if (recommendations.length === 0) {
      recommendations.push('No significant overfitting detected. Model appears stable across validation folds.');
    }

    return recommendations;
  }

  /**
   * Calculate confidence level in the overfitting analysis
   */
  private calculateConfidenceLevel(metrics: OverfittingMetrics, stability: StabilityAnalysis): number {
    // Confidence increases with more data and lower variance
    const dataConfidence = Math.min(1, Math.log10(Math.max(1, stability.parameterStability * 10)) / 2);
    const metricConfidence = 1 - metrics.overallOverfittingScore;
    const stabilityConfidence = stability.overallStability;

    return (dataConfidence + metricConfidence + stabilityConfidence) / 3;
  }

  /**
   * Calculate rolling correlation between IS and OOS returns
   */
  private calculateCorrelationDecay(isReturns: number[], oosReturns: number[]): number {
    if (isReturns.length !== oosReturns.length || isReturns.length < 2) {
      return 0;
    }

    const windowSize = Math.min(20, Math.floor(isReturns.length / 2));
    const correlations: number[] = [];

    for (let i = windowSize; i < isReturns.length; i++) {
      const isWindow = isReturns.slice(i - windowSize, i);
      const oosWindow = oosReturns.slice(i - windowSize, i);
      const correlation = this.pearsonCorrelation(isWindow, oosWindow);
      correlations.push(correlation);
    }

    return correlations.length > 0 ? this.mean(correlations) : 0;
  }

  /**
   * Kolmogorov-Smirnov test for distribution equality
   */
  private kolmogorovSmirnovTest(sample1: number[], sample2: number[]): number {
    if (sample1.length < 2 || sample2.length < 2) {
      return 1; // No difference if insufficient data
    }

    // Sort samples
    const sorted1 = [...sample1].sort((a, b) => a - b);
    const sorted2 = [...sample2].sort((a, b) => a - b);

    // Calculate empirical CDFs
    const ecdf1 = this.empiricalCDF(sorted1);
    const ecdf2 = this.empiricalCDF(sorted2);

    // Find maximum difference
    let maxDiff = 0;
    let i = 0, j = 0;

    while (i < sorted1.length && j < sorted2.length) {
      const diff = Math.abs(ecdf1[i] - ecdf2[j]);
      maxDiff = Math.max(maxDiff, diff);

      if (sorted1[i] < sorted2[j]) {
        i++;
      } else if (sorted1[i] > sorted2[j]) {
        j++;
      } else {
        i++;
        j++;
      }
    }

    // Approximate p-value using asymptotic distribution
    const n1 = sorted1.length;
    const n2 = sorted2.length;
    const statistic = maxDiff * Math.sqrt((n1 * n2) / (n1 + n2));

    // Simplified p-value approximation (for large samples)
    if (statistic < 0.5) {
      return Math.exp(-2 * statistic * statistic);
    } else {
      return 2 * Math.exp(-2 * statistic * statistic);
    }
  }

  /**
   * Calculate empirical cumulative distribution function
   */
  private empiricalCDF(sortedSample: number[]): number[] {
    const ecdf: number[] = [];
    for (let i = 0; i < sortedSample.length; i++) {
      ecdf.push((i + 1) / sortedSample.length);
    }
    return ecdf;
  }

  /**
   * Count number of free parameters in parameter set
   */
  private countParameters(params: ParameterSet): number {
    let count = 3; // confidenceThreshold, stopLoss, takeProfit

    if (params.earlyExitTarget !== undefined) count++;
    if (params.holdMinProfit !== undefined) count++;
    if (params.holdMaxCandles !== undefined) count++;
    if (params.runnerTriggerProfit !== undefined) count++;
    if (params.runnerPartialExit !== undefined) count++;

    return count;
  }

  // Statistical utility functions

  private mean(values: number[]): number {
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  private standardDeviation(values: number[], mean?: number): number {
    const avg = mean ?? this.mean(values);
    const squaredDiffs = values.map(val => Math.pow(val - avg, 2));
    return Math.sqrt(this.mean(squaredDiffs));
  }

  private coefficientOfVariation(values: number[]): number {
    const mean = this.mean(values);
    const std = this.standardDeviation(values, mean);
    return mean !== 0 ? std / Math.abs(mean) : 0;
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length < 2) {
      return 0;
    }

    const meanX = this.mean(x);
    const meanY = this.mean(y);
    const stdX = this.standardDeviation(x, meanX);
    const stdY = this.standardDeviation(y, meanY);

    if (stdX === 0 || stdY === 0) {
      return 0;
    }

    let covariance = 0;
    for (let i = 0; i < x.length; i++) {
      covariance += (x[i] - meanX) * (y[i] - meanY);
    }
    covariance /= x.length;

    return covariance / (stdX * stdY);
  }
}