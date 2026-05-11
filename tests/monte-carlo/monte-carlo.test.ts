// Monte Carlo Simulation Engine - Unit Tests
import { describe, it, expect, beforeEach } from 'vitest';
import { PathGenerator } from './engine/path-generator';
import { CorrelationMatrix } from './engine/correlation-matrix';
import { RiskCalculator } from './engine/risk-calculator';
import { StressTestRunner, BlackSwanScenario } from './engine/stress-test-engine';
import { MonteCarloEngine } from './engine/monte-carlo-engine';
import {
  validateCorrelationMatrix,
  ensurePositiveDefinite,
  validateSimulationParams,
  checkConvergence
} from './utils/validation';

describe('Monte Carlo Simulation Engine', () => {
  describe('PathGenerator', () => {
    let generator: PathGenerator;

    beforeEach(() => {
      generator = new PathGenerator({
        initialPrice: 100,
        drift: 0.05,
        volatility: 0.2,
        timeSteps: 252,
        numPaths: 1000,
        seed: 42
      });
    });

    it('should generate GBM paths with correct dimensions', () => {
      const paths = generator.generateGBM();
      expect(paths.length).toBe(1000 * (252 + 1));
    });

    it('should generate positive prices', () => {
      const paths = generator.generateGBM();
      for (let i = 0; i < paths.length; i++) {
        expect(paths[i]).toBeGreaterThan(0);
      }
    });

    it('should start with initial price', () => {
      const paths = generator.generateGBM();
      for (let i = 0; i < 1000; i++) {
        expect(paths[i * 253]).toBe(100);
      }
    });

    it('should validate correct paths', () => {
      const paths = generator.generateGBM();
      expect(generator.validatePath(paths, 252)).toBe(true);
    });

    it('should compute log returns', () => {
      const paths = generator.generateGBM();
      const returns = generator.computeLogReturns(paths, 252);
      expect(returns.length).toBe(1000 * 252);
    });

    it('should generate jump diffusion paths', () => {
      const paths = generator.generateJumpDiffusion(0.1, -0.05, 0.1);
      expect(paths.length).toBe(1000 * 253);
      
      for (let i = 0; i < paths.length; i++) {
        expect(paths[i]).toBeGreaterThan(0);
      }
    });
  });

  describe('CorrelationMatrix', () => {
    let returns: number[][];

    beforeEach(() => {
      // Generate synthetic correlated returns
      const n = 100;
      const p = 5;
      returns = [];
      
      for (let i = 0; i < n; i++) {
        const row = [];
        for (let j = 0; j < p; j++) {
          row.push((Math.random() - 0.5) * 0.1);
        }
        returns.push(row);
      }
    });

    it('should compute covariance matrix', () => {
      const cm = new CorrelationMatrix(returns, 'sample');
      const cov = cm.getCovariance();
      
      expect(cov.length).toBe(5);
      expect(cov[0].length).toBe(5);
    });

    it('should compute Cholesky decomposition', () => {
      const cm = new CorrelationMatrix(returns, 'sample');
      const L = cm.cholesky();
      
      expect(L.rows).toBe(5);
      expect(L.columns).toBe(5);
    });

    it('should validate positive definiteness', () => {
      const cm = new CorrelationMatrix(returns, 'sample');
      expect(cm.isPositiveDefinite()).toBe(true);
    });

    it('should generate correlated noise', () => {
      const cm = new CorrelationMatrix(returns, 'sample');
      const noise = cm.generateCorrelatedNoise(100);
      
      expect(noise.length).toBe(100);
      expect(noise[0].length).toBe(5);
    });

    it('should apply stress scenarios', () => {
      const cm = new CorrelationMatrix(returns, 'sample');
      const stressed = cm.applyStress({ type: 'crisis', intensity: 1.0 });
      
      expect(stressed.rows).toBe(5);
      expect(stressed.columns).toBe(5);
    });

    it('should compute condition number', () => {
      const cm = new CorrelationMatrix(returns, 'sample');
      const cond = cm.getConditionNumber();
      
      expect(cond).toBeGreaterThan(0);
    });
  });

  describe('RiskCalculator', () => {
    let calculator: RiskCalculator;
    let losses: number[];

    beforeEach(() => {
      calculator = new RiskCalculator();
      losses = Array.from({ length: 1000 }, () => Math.random() * 1000);
    });

    it('should compute parametric VaR', () => {
      const returns = Array.from({ length: 1000 }, () => (Math.random() - 0.5) * 0.1);
      const var95 = calculator.parametricVaR(returns, 0.95, 100000);
      
      expect(var95).toBeGreaterThan(0);
    });

    it('should compute historical VaR', () => {
      const var95 = calculator.historicalVaR(losses, 0.95);
      const var99 = calculator.historicalVaR(losses, 0.99);
      
      expect(var95).toBeGreaterThan(0);
      expect(var99).toBeGreaterThan(var95);
    });

    it('should compute CVaR', () => {
      const cvar95 = calculator.conditionalVaR(losses, 0.95);
      const cvar99 = calculator.conditionalVaR(losses, 0.99);
      
      expect(cvar95).toBeGreaterThan(0);
      expect(cvar99).toBeGreaterThan(cvar95);
    });

    it('should compute Cornish-Fisher VaR', () => {
      const returns = Array.from({ length: 1000 }, () => (Math.random() - 0.5) * 0.1);
      const cfVaR = calculator.cornishFisherVaR(returns, 0.95, 100000);
      
      expect(cfVaR).toBeGreaterThan(0);
    });

    it('should pass Kupiec test for well-calibrated VaR', () => {
      const actualLosses = Array.from({ length: 1000 }, () => Math.random() * 1000);
      const varEstimate = calculator.historicalVaR(actualLosses, 0.95);
      
      const result = calculator.kupiecTest(actualLosses, varEstimate, 0.95);
      
      expect(result.pValue).toBeGreaterThan(0.05);
    });

    it('should calculate loss distribution from paths', () => {
      const paths = new Float64Array(1000 * 253);
      for (let i = 0; i < paths.length; i++) {
        paths[i] = 100 + Math.random() * 10;
      }
      
      const losses = calculator.calculateLossDistribution(paths, 252, 100000);
      expect(losses.length).toBe(1000);
    });

    it('should calculate tail risk', () => {
      const tailRisk = calculator.calculateTailRisk(losses, [0.95, 0.99]);
      
      expect(tailRisk.worstCaseLoss).toBeGreaterThan(0);
      expect(tailRisk.percentile99_9).toBeGreaterThan(0);
      expect(tailRisk.var['95%']).toBeGreaterThan(0);
      expect(tailRisk.var['99%']).toBeGreaterThan(0);
    });
  });

  describe('StressTestRunner', () => {
    let runner: StressTestRunner;

    beforeEach(() => {
      runner = new StressTestRunner();
    });

    it('should run Black Swan scenario', async () => {
      runner.addScenario(new BlackSwanScenario(1.0));
      const report = await runner.runAllScenarios(100000, 1000);
      
      expect(report.results.length).toBe(1);
      expect(report.results[0].var['99%']).toBeGreaterThan(0);
    });

    it('should identify worst case scenario', async () => {
      runner.addScenario(new BlackSwanScenario(1.0));
      const report = await runner.runAllScenarios(100000, 1000);
      
      expect(report.comparativeAnalysis.worstCaseScenario).toBeDefined();
      expect(report.comparativeAnalysis.diversificationBenefit).toBeDefined();
    });
  });

  describe('MonteCarloEngine', () => {
    let engine: MonteCarloEngine;

    beforeEach(() => {
      engine = new MonteCarloEngine();
    });

    it('should run simulation', async () => {
      const request = {
        portfolio: {
          positions: [
            { symbol: 'BTC/USDT', quantity: 1, currentPrice: 65000 },
            { symbol: 'ETH/USDT', quantity: 10, currentPrice: 3500 }
          ]
        },
        parameters: {
          timeHorizon: 1,
          confidenceLevels: [0.95, 0.99],
          numPaths: 1000,
          model: 'gbm'
        }
      };
      
      const result = await engine.simulate(request);
      
      expect(result.status).toBe('completed');
      expect(result.result).toBeDefined();
      expect(result.result!.var['95%']).toBeGreaterThan(0);
    });

    it('should run stress tests', async () => {
      const portfolio = {
        positions: [
          { symbol: 'BTC/USDT', quantity: 1, currentPrice: 65000 }
        ]
      };
      
      const results = await engine.runStressTests(portfolio, [
        { type: 'black-swan', intensity: 1.0 }
      ]);
      
      expect(results.length).toBe(1);
      expect(results[0].var['99%']).toBeGreaterThan(0);
    });

    it('should validate VaR model', async () => {
      const historicalReturns = Array.from({ length: 1000 }, () => (Math.random() - 0.5) * 0.02);
      const varEstimates = Array.from({ length: 1000 }, () => Math.random() * 0.01);
      
      const validation = await engine.validateVaR(historicalReturns, varEstimates, 0.95);
      
      expect(validation).toBeDefined();
      expect(validation.pValue).toBeDefined();
    });

    it('should check convergence', async () => {
      const request = {
        portfolio: {
          positions: [
            { symbol: 'BTC/USDT', quantity: 1, currentPrice: 65000 }
          ]
        },
        parameters: {
          timeHorizon: 1,
          confidenceLevels: [0.95],
          numPaths: 5000,
          model: 'gbm'
        }
      };
      
      const result = await engine.simulate(request);
      
      expect(result.result!.convergence).toBeLessThan(0.1);
    });
  });

  describe('Validation Utilities', () => {
    it('should validate correlation matrix', () => {
      const matrix = [
        [1, 0.5],
        [0.5, 1]
      ];
      
      const result = validateCorrelationMatrix(matrix);
      expect(result.isValid).toBe(true);
      expect(result.minEigenvalue).toBeGreaterThan(0);
    });

    it('should ensure positive definiteness', () => {
      const matrix = [
        [1, 0.9],
        [0.9, 1]
      ];
      
      const corrected = ensurePositiveDefinite(matrix);
      expect(corrected.length).toBe(2);
    });

    it('should validate simulation parameters', () => {
      const result = validateSimulationParams({
        numPaths: 10000,
        timeHorizon: 30,
        confidenceLevels: [0.95, 0.99]
      });
      
      expect(result.isValid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should reject invalid simulation parameters', () => {
      const result = validateSimulationParams({
        numPaths: 100,
        timeHorizon: 30,
        confidenceLevels: [0.95]
      });
      
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should check convergence', () => {
      const values = Array.from({ length: 2000 }, () => Math.random() * 100);
      const result = checkConvergence(values, 1000);
      
      expect(result).toBeDefined();
      expect(result.coefficientOfVariation).toBeDefined();
    });
  });
});
