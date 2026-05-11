import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { StatisticalValidator } from '../../backend/validation/wfa/statistical-validator';
import { OptimizationResult } from '../../backend/validation/wfa/rolling-optimizer';
import { OverfittingDiagnostic } from '../../backend/validation/wfa/overfitting-detector';

// Mock optimization results for testing
function createMockOptimizationResults(count: number, goodPerformance: boolean = true): OptimizationResult[] {
  const results: OptimizationResult[] = [];

  for (let i = 0; i < count; i++) {
    const baseSharpe = goodPerformance ? 1.5 : 0.2;
    const baseMaxDD = goodPerformance ? 0.15 : 0.40;

    results.push({
      parameters: {
        mode: 'moderate' as any,
        confidenceThreshold: 75,
        stopLoss: 2.0,
        takeProfit: 2.0,
        positionSize: 0.05,
      },
      inSampleSharpe: baseSharpe + (Math.random() - 0.5) * 0.3,
      inSampleMaxDrawdown: baseMaxDD + Math.random() * 0.1,
      outOfSampleSharpe: baseSharpe * 0.8 + (Math.random() - 0.5) * 0.2, // Slightly worse OOS
      outOfSampleMaxDrawdown: baseMaxDD * 1.2 + Math.random() * 0.1,
      fitnessScore: 0.8 + Math.random() * 0.3,
      tradeCount: 50 + Math.floor(Math.random() * 100),
      winRate: 0.5 + Math.random() * 0.4,
    });
  }

  return results;
}

function createMockOverfittingDiagnostic(good: boolean = true): OverfittingDiagnostic {
  return {
    metrics: {
      divergenceRatio: good ? 0.1 : 0.6,
      correlationDecay: good ? 0.8 : 0.2,
      shapeTestPValue: good ? 0.7 : 0.01,
      complexityPenalty: good ? 2 : 10,
      overallOverfittingScore: good ? 0.2 : 0.8,
      isOverfitted: !good,
    },
    stability: {
      parameterStability: good ? 0.9 : 0.4,
      performanceConsistency: good ? 0.8 : 0.5,
      drawdownStability: good ? 0.9 : 0.3,
      overallStability: good ? 0.87 : 0.43,
    },
    recommendations: good ? ['Model appears stable'] : ['High overfitting detected'],
    confidenceLevel: good ? 0.9 : 0.6,
  };
}

describe('StatisticalValidator', () => {
  let validator: StatisticalValidator;

  beforeEach(() => {
    validator = new StatisticalValidator();
  });

  describe('validateOptimization', () => {
    test('should validate good optimization results', async () => {
      const results = createMockOptimizationResults(20, true);
      const diagnostic = createMockOverfittingDiagnostic(true);

      const report = await validator.validateOptimization(results, diagnostic);

      assert(report, 'Report should be generated');
      assert(typeof report.overallValidationScore === 'number', 'Overall score should be a number');
      assert(report.overallValidationScore >= 0 && report.overallValidationScore <= 1, 'Score should be between 0 and 1');
      assert(Array.isArray(report.recommendations), 'Recommendations should be an array');
    });

    test('should flag poor optimization results', async () => {
      const results = createMockOptimizationResults(20, false);
      const diagnostic = createMockOverfittingDiagnostic(false);

      const report = await validator.validateOptimization(results, diagnostic);

      assert(report.overallValidationScore < 0.5, 'Poor results should have low validation score');
      assert(report.recommendations.length > 0, 'Should have recommendations for improvement');
    });
  });

  describe('whiteRealityCheck', () => {
    test('should pass for good performing strategies', async () => {
      const results = createMockOptimizationResults(15, true);
      const testResult = await (validator as any).whiteRealityCheck(results);

      assert(testResult.testName === 'White Reality Check', 'Should have correct test name');
      assert(typeof testResult.pValue === 'number', 'P-value should be a number');
      assert(typeof testResult.isSignificant === 'boolean', 'Should have significance flag');
    });

    test('should handle insufficient data', async () => {
      const results = createMockOptimizationResults(1, true);
      const testResult = await (validator as any).whiteRealityCheck(results);

      assert(!testResult.isSignificant, 'Should not be significant with insufficient data');
    });
  });

  describe('hansenSuperiorPredictiveAbility', () => {
    test('should evaluate predictive ability', () => {
      const results = createMockOptimizationResults(15, true);
      const testResult = (validator as any).hansenSuperiorPredictiveAbility(results);

      assert(testResult.testName === 'Hansen Superior Predictive Ability', 'Should have correct test name');
      assert(typeof testResult.pValue === 'number', 'P-value should be a number');
      assert(typeof testResult.isSignificant === 'boolean', 'Should have significance flag');
    });

    test('should handle insufficient strategies', () => {
      const results = createMockOptimizationResults(5, true);
      const testResult = (validator as any).hansenSuperiorPredictiveAbility(results);

      assert(!testResult.isSignificant, 'Should not be significant with insufficient strategies');
    });
  });

  describe('probabilisticSharpeRatio', () => {
    test('should calculate PSR correctly', () => {
      const results = createMockOptimizationResults(20, true);
      const testResult = (validator as any).probabilisticSharpeRatio(results);

      assert(testResult.testName === 'Probabilistic Sharpe Ratio', 'Should have correct test name');
      assert(typeof testResult.statistic === 'number', 'Statistic should be a number');
      assert(testResult.statistic >= 0 && testResult.statistic <= 1, 'PSR should be between 0 and 1');
    });

    test('should handle edge cases', () => {
      const results: OptimizationResult[] = [];
      const testResult = (validator as any).probabilisticSharpeRatio(results);

      assert(testResult.statistic === 0, 'Should return 0 for empty results');
    });
  });

  describe('bootstrapConfidenceIntervals', () => {
    test('should generate confidence intervals', () => {
      const results = createMockOptimizationResults(20, true);
      const bootstrapResult = (validator as any).bootstrapConfidenceIntervals(results);

      assert(bootstrapResult.sharpeRatioCI.length === 2, 'Should have upper and lower bounds');
      assert(bootstrapResult.maxDrawdownCI.length === 2, 'Should have upper and lower bounds');
      assert(bootstrapResult.winRateCI.length === 2, 'Should have upper and lower bounds');
      assert(bootstrapResult.sharpeRatioCI[0] <= bootstrapResult.sharpeRatioCI[1], 'Lower bound should be <= upper bound');
      assert(bootstrapResult.confidenceLevel === 0.95, 'Should use 95% confidence level');
    });
  });

  describe('falseDiscoveryRate', () => {
    test('should apply FDR correction', () => {
      const tests = [
        { testName: 'Test 1', statistic: 1.5, pValue: 0.05, isSignificant: true },
        { testName: 'Test 2', statistic: 1.2, pValue: 0.10, isSignificant: false },
        { testName: 'Test 3', statistic: 1.8, pValue: 0.03, isSignificant: true },
      ];

      const fdrResult = (validator as any).falseDiscoveryRate(tests);

      assert(Array.isArray(fdrResult.originalPValues), 'Should have original p-values');
      assert(Array.isArray(fdrResult.adjustedPValues), 'Should have adjusted p-values');
      assert(Array.isArray(fdrResult.rejectedHypotheses), 'Should have rejection decisions');
      assert(typeof fdrResult.criticalValue === 'number', 'Should have critical value');
    });
  });

  describe('calculateOverallScore', () => {
    test('should combine multiple test results', () => {
      const mockReport = {
        whiteRealityCheck: { isSignificant: true, statistic: 2.0, pValue: 0.02 },
        hansenSPA: { isSignificant: true, statistic: 2.5, pValue: 0.01 },
        probabilisticSharpeRatio: { statistic: 0.98, pValue: 0.01 },
        bootstrapAnalysis: {
          sharpeRatioCI: [1.2, 1.8],
          maxDrawdownCI: [0.1, 0.25],
          winRateCI: [0.45, 0.65],
          confidenceLevel: 0.95,
          sampleSize: 1000,
        },
        falseDiscoveryRate: {
          originalPValues: [0.05, 0.10, 0.03],
          adjustedPValues: [0.10, 0.15, 0.09],
          rejectedHypotheses: [true, false, true],
          criticalValue: 0.05,
        },
      };

      const score = (validator as any).calculateOverallScore(mockReport);

      assert(typeof score === 'number', 'Score should be a number');
      assert(score >= 0 && score <= 1, 'Score should be between 0 and 1');
      assert(score > 0.7, 'Good results should have high score');
    });
  });

  describe('generateValidationRecommendations', () => {
    test('should provide helpful recommendations', () => {
      const mockReport = {
        whiteRealityCheck: { isSignificant: false, statistic: 0.5, pValue: 0.6 },
        hansenSPA: { isSignificant: false, statistic: 0.8, pValue: 0.4 },
        probabilisticSharpeRatio: { statistic: 0.85, pValue: 0.02 },
        bootstrapAnalysis: {
          sharpeRatioCI: [0.5, 2.0], // Wide interval
          maxDrawdownCI: [0.1, 0.3],
          winRateCI: [0.4, 0.6],
          confidenceLevel: 0.95,
          sampleSize: 1000,
        },
        falseDiscoveryRate: {
          originalPValues: [0.6, 0.4, 0.02],
          adjustedPValues: [0.6, 0.4, 0.06],
          rejectedHypotheses: [false, false, true],
          criticalValue: 0.05,
        },
      };

      const diagnostic = createMockOverfittingDiagnostic(false);
      const recommendations = (validator as any).generateValidationRecommendations(mockReport, diagnostic);

      assert(Array.isArray(recommendations), 'Should return array of recommendations');
      assert(recommendations.length > 0, 'Should have recommendations for poor results');
      assert(recommendations.some(r => r.includes('overfitting')), 'Should mention overfitting');
    });
  });
});