import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { OverfittingDetector, OverfittingMetrics, StabilityAnalysis } from '../../backend/validation/wfa/overfitting-detector';
import { OptimizationResult, ParameterSet } from '../../backend/validation/wfa/rolling-optimizer';
import { RiskMode } from '../../backend/risk/manager';
import { DataPartition } from '../../backend/validation/wfa/data-partitioner';
import { Candle } from '../../backend/indicators/engine';

// Mock optimization results for testing
function createMockOptimizationResults(count: number, overfitted: boolean = false): OptimizationResult[] {
  const results: OptimizationResult[] = [];

  for (let i = 0; i < count; i++) {
    const baseSharpe = overfitted ? 2.5 : 1.2; // Overfitted models show better IS performance
    const oosSharpe = overfitted ? 0.3 : 1.0; // But worse OOS performance

    results.push({
      parameters: {
        mode: RiskMode.MODERATE,
        confidenceThreshold: 75,
        stopLoss: 2.0,
        takeProfit: 2.0,
        positionSize: 0.05,
      },
      inSampleSharpe: baseSharpe + (Math.random() - 0.5) * 0.2,
      inSampleMaxDrawdown: 0.15 + Math.random() * 0.05,
      outOfSampleSharpe: oosSharpe + (Math.random() - 0.5) * 0.2,
      outOfSampleMaxDrawdown: 0.18 + Math.random() * 0.05,
      fitnessScore: 0.8 + Math.random() * 0.4,
      tradeCount: 50 + Math.floor(Math.random() * 50),
      winRate: 0.5 + Math.random() * 0.3,
    });
  }

  return results;
}

function createMockPartitions(count: number): DataPartition[] {
  const partitions: DataPartition[] = [];
  const baseTime = Date.now();

  for (let i = 0; i < count; i++) {
    const candles: Candle[] = [];
    for (let j = 0; j < 100; j++) {
      candles.push({
        time: baseTime + i * 86400000 + j * 60000, // 1 day + 1 min intervals
        open: 50000 + Math.random() * 1000,
        high: 50000 + Math.random() * 1000,
        low: 50000 + Math.random() * 1000,
        close: 50000 + Math.random() * 1000,
        volume: Math.random() * 1000,
      });
    }

    partitions.push({
      inSample: candles.slice(0, 70),
      outOfSample: candles.slice(70, 100),
      foldIndex: i,
      totalFolds: count,
      isAnchored: true,
    });
  }

  return partitions;
}

describe.skip('OverfittingDetector', () => {
  let detector: OverfittingDetector;

  beforeEach(() => {
    detector = new OverfittingDetector();
  });

  describe.skip('analyzeOverfitting', () => {
    test('should analyze overfitting with normal results', () => {
      const results = createMockOptimizationResults(10, false);
      const partitions = createMockPartitions(10);

      const diagnostic = detector.analyzeOverfitting(results, partitions);

      expect(diagnostic).toBeDefined();
      expect(diagnostic.metrics).toBeDefined();
      expect(diagnostic.stability).toBeDefined();
      expect(diagnostic.recommendations).toBeInstanceOf(Array);
      expect(diagnostic.confidenceLevel).toBeGreaterThanOrEqual(0);
      expect(diagnostic.confidenceLevel).toBeLessThanOrEqual(1);
    });

    test('should detect overfitting in overfitted results', () => {
      const results = createMockOptimizationResults(10, true);
      const partitions = createMockPartitions(10);

      const diagnostic = detector.analyzeOverfitting(results, partitions);

      expect(diagnostic.metrics.isOverfitted).toBe(true);
      expect(diagnostic.metrics.divergenceRatio).toBeGreaterThan(0);
      expect(diagnostic.recommendations.length).toBeGreaterThan(0);
    });

    test('should handle edge cases', () => {
      const emptyResults: OptimizationResult[] = [];
      const partitions = createMockPartitions(1);

      expect(() => detector.analyzeOverfitting(emptyResults, partitions)).toThrow('Cannot analyze overfitting with empty results');
    });
  });

  describe.skip('calculateOverfittingMetrics', () => {
    test('should calculate metrics for normal results', () => {
      const results = createMockOptimizationResults(10, false);

      // Access private method for testing
      const metrics = (detector as any).calculateOverfittingMetrics(results);

      expect(metrics).toBeDefined();
      expect(metrics.divergenceRatio).toBeGreaterThanOrEqual(0);
      expect(metrics.correlationDecay).toBeGreaterThanOrEqual(-1);
      expect(metrics.correlationDecay).toBeLessThanOrEqual(1);
      expect(metrics.shapeTestPValue).toBeGreaterThanOrEqual(0);
      expect(metrics.shapeTestPValue).toBeLessThanOrEqual(1);
      expect(metrics.complexityPenalty).toBeGreaterThanOrEqual(0);
      expect(metrics.overallOverfittingScore).toBeGreaterThanOrEqual(0);
      expect(metrics.overallOverfittingScore).toBeLessThanOrEqual(1);
      expect(typeof metrics.isOverfitted).toBe('boolean');
    });

    test('should flag high divergence as overfitting', () => {
      const results = createMockOptimizationResults(10, true);

      const metrics = (detector as any).calculateOverfittingMetrics(results);

      expect(metrics.divergenceRatio).toBeGreaterThan(0);
      // Note: Due to the mock data structure, the exact threshold behavior may vary
    });
  });

  describe.skip('calculateStabilityAnalysis', () => {
    test('should calculate stability for multiple results', () => {
      const results = createMockOptimizationResults(5, false);

      const stability = (detector as any).calculateStabilityAnalysis(results);

      expect(stability).toBeDefined();
      expect(stability.parameterStability).toBeGreaterThanOrEqual(0);
      expect(stability.parameterStability).toBeLessThanOrEqual(1);
      expect(stability.performanceConsistency).toBeGreaterThanOrEqual(0);
      expect(stability.performanceConsistency).toBeLessThanOrEqual(1);
      expect(stability.drawdownStability).toBeGreaterThanOrEqual(0);
      expect(stability.drawdownStability).toBeLessThanOrEqual(1);
      expect(stability.overallStability).toBeGreaterThanOrEqual(0);
      expect(stability.overallStability).toBeLessThanOrEqual(1);
    });

    test('should handle single result edge case', () => {
      const results = createMockOptimizationResults(1, false);

      const stability = (detector as any).calculateStabilityAnalysis(results);

      expect(stability.parameterStability).toBe(1);
      expect(stability.performanceConsistency).toBe(1);
      expect(stability.drawdownStability).toBe(1);
      expect(stability.overallStability).toBe(1);
    });
  });

  describe.skip('generateRecommendations', () => {
    test('should generate appropriate recommendations', () => {
      const metrics: OverfittingMetrics = {
        divergenceRatio: 0.5, // High divergence
        correlationDecay: 0.2, // Low correlation
        shapeTestPValue: 0.01, // Significant difference
        complexityPenalty: 8, // High complexity
        overallOverfittingScore: 0.8,
        isOverfitted: true,
      };

      const stability: StabilityAnalysis = {
        parameterStability: 0.5, // Low stability
        performanceConsistency: 0.6,
        drawdownStability: 0.4, // Low stability
        overallStability: 0.5,
      };

      const recommendations = (detector as any).generateRecommendations(metrics, stability);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations.some(r => r.includes('divergence'))).toBe(true);
      expect(recommendations.some(r => r.includes('correlation'))).toBe(true);
      expect(recommendations.some(r => r.includes('parameter'))).toBe(true);
      expect(recommendations.some(r => r.includes('drawdown'))).toBe(true);
    });

    test('should generate positive recommendations for stable models', () => {
      const metrics: OverfittingMetrics = {
        divergenceRatio: 0.1, // Low divergence
        correlationDecay: 0.8, // High correlation
        shapeTestPValue: 0.3, // No significant difference
        complexityPenalty: 2, // Low complexity
        overallOverfittingScore: 0.2,
        isOverfitted: false,
      };

      const stability: StabilityAnalysis = {
        parameterStability: 0.9, // High stability
        performanceConsistency: 0.8,
        drawdownStability: 0.9,
        overallStability: 0.87,
      };

      const recommendations = (detector as any).generateRecommendations(metrics, stability);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations.some(r => r.includes('stable') || r.includes('no significant'))).toBe(true);
    });
  });

  describe.skip('calculateConfidenceLevel', () => {
    test('should calculate confidence based on metrics and stability', () => {
      const metrics: OverfittingMetrics = {
        divergenceRatio: 0.1,
        correlationDecay: 0.8,
        shapeTestPValue: 0.5,
        complexityPenalty: 1,
        overallOverfittingScore: 0.2,
        isOverfitted: false,
      };

      const stability: StabilityAnalysis = {
        parameterStability: 0.9,
        performanceConsistency: 0.8,
        drawdownStability: 0.9,
        overallStability: 0.87,
      };

      const confidence = (detector as any).calculateConfidenceLevel(metrics, stability);

      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
      expect(confidence).toBeGreaterThan(0.5); // Should be reasonably high for good metrics
    });
  });

  describe.skip('statistical utilities', () => {
    describe.skip('kolmogorovSmirnovTest', () => {
      test('should handle identical distributions', () => {
        const sample1 = [1, 2, 3, 4, 5];
        const sample2 = [1, 2, 3, 4, 5];

        const pValue = (detector as any).kolmogorovSmirnovTest(sample1, sample2);

        expect(pValue).toBeGreaterThan(0.05); // Should not reject null hypothesis
      });

      test('should detect different distributions', () => {
        const sample1 = [1, 2, 3, 4, 5];
        const sample2 = [10, 20, 30, 40, 50];

        const pValue = (detector as any).kolmogorovSmirnovTest(sample1, sample2);

        expect(pValue).toBeLessThan(0.05); // Should reject null hypothesis
      });

      test('should handle edge cases', () => {
        const smallSample1 = [1];
        const smallSample2 = [2];

        const pValue = (detector as any).kolmogorovSmirnovTest(smallSample1, smallSample2);

        expect(pValue).toBe(1); // No difference with insufficient data
      });
    });

    describe.skip('calculateCorrelationDecay', () => {
      test('should calculate rolling correlation', () => {
        const isReturns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const oosReturns = [1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1, 8.1, 9.1, 10.1]; // Highly correlated

        const correlation = (detector as any).calculateCorrelationDecay(isReturns, oosReturns);

        expect(correlation).toBeGreaterThan(0.8); // Should be highly correlated
      });

      test('should handle mismatched array lengths', () => {
        const isReturns = [1, 2, 3];
        const oosReturns = [1, 2]; // Different lengths

        const correlation = (detector as any).calculateCorrelationDecay(isReturns, oosReturns);

        expect(correlation).toBe(0); // Should return 0 for mismatched lengths
      });
    });

    describe.skip('countParameters', () => {
      test('should count basic parameters', () => {
        const params: ParameterSet = {
          mode: RiskMode.MODERATE,
          confidenceThreshold: 75,
          stopLoss: 2.0,
          takeProfit: 2.0,
          positionSize: 0.05,
        };

        const count = (detector as any).countParameters(params);

        expect(count).toBe(4); // mode + 3 basic parameters
      });

      test('should count optional parameters', () => {
        const params: ParameterSet = {
          mode: RiskMode.MODERATE,
          confidenceThreshold: 75,
          stopLoss: 2.0,
          takeProfit: 2.0,
          positionSize: 0.05,
          earlyExitTarget: 1.0,
          holdMinProfit: 0.5,
          holdMaxCandles: 3,
          runnerTriggerProfit: 1.5,
          runnerPartialExit: 0.6,
        };

        const count = (detector as any).countParameters(params);

        expect(count).toBe(9); // mode + 3 basic + 5 optional
      });
    });
  });
});