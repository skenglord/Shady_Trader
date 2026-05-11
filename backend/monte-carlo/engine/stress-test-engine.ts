// Stress Test Engine - Portfolio Stress Scenarios
import { Matrix } from 'ml-matrix';
import { RiskCalculator } from './risk-calculator';
import { PathGenerator } from './path-generator';
import { CorrelationMatrix } from './correlation-matrix';

export interface StressTestResult {
  scenario: string;
  var: Record<string, number>;
  cvar: Record<string, number>;
  maxLoss: number;
  expectedLoss: number;
  percentile95: number;
  percentile99: number;
  heatmap: number[][];
}

export interface StressTestReport {
  results: StressTestResult[];
  comparativeAnalysis: {
    worstCaseScenario: string;
    riskContribution: Record<string, number>;
    diversificationBenefit: number;
  };
}

export abstract class StressScenario {
  abstract name: string;
  abstract description: string;
  
  abstract applyShocks(returns: number[]): number[];
  abstract applyCorrelation(matrix: Matrix): Matrix;
  abstract applyTransactionCosts(baseCost: number): number;
}

export class BlackSwanScenario extends StressScenario {
  name = 'black-swan';
  description = '6σ event across all assets';
  
  constructor(private intensity: number = 1.0) {
    super();
  }
  
  applyShocks(returns: number[]): number[] {
    return returns.map(r => {
      // Apply 6-sigma shock
      const shock = -6 * this.intensity * Math.abs(r);
      return r + shock;
    });
  }
  
  applyCorrelation(matrix: Matrix): Matrix {
    const stressed = matrix.clone();
    const n = stressed.rows;
    
    // Increase all correlations
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          const current = stressed.get(i, j);
          const newVal = Math.min(current + 0.3 * this.intensity, 0.99);
          stressed.set(i, j, newVal);
          stressed.set(j, i, newVal);
        }
      }
    }
    
    return stressed;
  }
  
  applyTransactionCosts(baseCost: number): number {
    return baseCost * (1 + 5 * this.intensity);
  }
}

export class FlashCrashScenario extends StressScenario {
  name = 'flash-crash';
  description = '-10% price drop in 5 minutes (2010-style)';
  
  constructor(private intensity: number = 1.0) {
    super();
  }
  
  applyShocks(returns: number[]): number[] {
    const shocked = [...returns];
    
    // Simulate rapid price decline
    const crashPoint = Math.floor(shocked.length * 0.5);
    const crashMagnitude = -0.1 * this.intensity;
    
    for (let i = crashPoint; i < Math.min(crashPoint + 5, shocked.length); i++) {
      shocked[i] = crashMagnitude / 5;
    }
    
    return shocked;
  }
  
  applyCorrelation(matrix: Matrix): Matrix {
    const stressed = matrix.clone();
    const n = stressed.rows;
    
    // Correlations spike during flash crash
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          stressed.set(i, j, 0.9 * this.intensity);
          stressed.set(j, i, 0.9 * this.intensity);
        }
      }
    }
    
    return stressed;
  }
  
  applyTransactionCosts(baseCost: number): number {
    return baseCost * (1 + 10 * this.intensity);
  }
}

export class LiquidityCrisisScenario extends StressScenario {
  name = 'liquidity-crisis';
  description = 'Bid-ask spread × 10, volume ↓ 90%';
  
  constructor(private intensity: number = 1.0) {
    super();
  }
  
  applyShocks(returns: number[]): number[] {
    // Add volatility spike
    return returns.map(r => {
      const volatilityMultiplier = 3 * this.intensity;
      return r * (1 + (Math.random() - 0.5) * volatilityMultiplier);
    });
  }
  
  applyCorrelation(matrix: Matrix): Matrix {
    const stressed = matrix.clone();
    const n = stressed.rows;
    
    // Flight to quality - correlations increase
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          const current = stressed.get(i, j);
          const newVal = Math.min(current * 1.5, 0.95);
          stressed.set(i, j, newVal);
          stressed.set(j, i, newVal);
        }
      }
    }
    
    return stressed;
  }
  
  applyTransactionCosts(baseCost: number): number {
    return baseCost * (1 + 10 * this.intensity);
  }
}

export class RegimeShiftScenario extends StressScenario {
  name = 'regime-shift';
  description = 'Bull → Bear correlation structure change';
  
  constructor(private intensity: number = 1.0) {
    super();
  }
  
  applyShocks(returns: number[]): number[] {
    // Persistent negative drift
    return returns.map(r => {
      const regimeShift = -0.02 * this.intensity;
      return r + regimeShift;
    });
  }
  
  applyCorrelation(matrix: Matrix): Matrix {
    const stressed = matrix.clone();
    const n = stressed.rows;
    
    // All correlations move toward 1.0 (diversification failure)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          const newVal = 0.8 + 0.15 * this.intensity;
          stressed.set(i, j, Math.min(newVal, 0.99));
          stressed.set(j, i, Math.min(newVal, 0.99));
        }
      }
    }
    
    return stressed;
  }
  
  applyTransactionCosts(baseCost: number): number {
    return baseCost * (1 + 3 * this.intensity);
  }
}

export class StressTestRunner {
  private scenarios: StressScenario[] = [];
  private riskCalculator: RiskCalculator;
  private pathGenerator: PathGenerator;

  constructor() {
    this.riskCalculator = new RiskCalculator();
    this.pathGenerator = new PathGenerator({
      initialPrice: 100,
      drift: 0.05,
      volatility: 0.2,
      timeSteps: 252,
      numPaths: 10000,
      seed: 42
    });
  }

  addScenario(scenario: StressScenario): void {
    this.scenarios.push(scenario);
  }

  async runScenario(
    scenario: StressScenario,
    portfolioValue: number,
    numPaths: number = 100000
  ): Promise<StressTestResult> {
    // Generate base paths
    const basePaths = this.pathGenerator.generateGBM();
    const timeSteps = 252;
    
    // Apply scenario shocks
    const shockedPaths = this.applyScenarioToPaths(
      basePaths,
      timeSteps,
      scenario
    );
    
    // Calculate losses
    const losses = this.riskCalculator.calculateLossDistribution(
      shockedPaths,
      timeSteps,
      portfolioValue
    );
    
    // Calculate risk metrics
    const var95 = this.riskCalculator.historicalVaR(losses, 0.95);
    const var99 = this.riskCalculator.historicalVaR(losses, 0.99);
    const cvar95 = this.riskCalculator.conditionalVaR(losses, 0.95);
    const cvar99 = this.riskCalculator.conditionalVaR(losses, 0.99);
    
    // Calculate percentiles
    const sortedLosses = [...losses].sort((a, b) => b - a);
    const p95 = sortedLosses[Math.floor(0.05 * sortedLosses.length)];
    const p99 = sortedLosses[Math.floor(0.01 * sortedLosses.length)];
    
    // Generate heatmap (simplified)
    const heatmap = this.generateHeatmap(scenario, losses);
    
    return {
      scenario: scenario.name,
      var: { '95%': var95, '99%': var99 },
      cvar: { '95%': cvar95, '99%': cvar99 },
      maxLoss: Math.max(...losses),
      expectedLoss: losses.reduce((a, b) => a + b, 0) / losses.length,
      percentile95: p95,
      percentile99: p99,
      heatmap
    };
  }

  async runAllScenarios(
    portfolioValue: number,
    numPaths: number = 100000
  ): Promise<StressTestReport> {
    const results: StressTestResult[] = [];
    
    for (const scenario of this.scenarios) {
      const result = await this.runScenario(scenario, portfolioValue, numPaths);
      results.push(result);
    }
    
    return this.generateReport(results);
  }

  private applyScenarioToPaths(
    paths: Float64Array,
    timeSteps: number,
    scenario: StressScenario
  ): Float64Array {
    const numPaths = paths.length / (timeSteps + 1);
    const shockedPaths = new Float64Array(paths.length);
    
    for (let i = 0; i < numPaths; i++) {
      const baseIdx = i * (timeSteps + 1);
      shockedPaths[baseIdx] = paths[baseIdx]; // Initial price
      
      for (let t = 1; t <= timeSteps; t++) {
        const prevPrice = shockedPaths[baseIdx + t - 1];
        const baseReturn = (paths[baseIdx + t] - paths[baseIdx + t - 1]) / paths[baseIdx + t - 1];
        
        // Apply scenario shock to return
        const shockedReturn = scenario.applyShocks([baseReturn])[0];
        const newPrice = prevPrice * (1 + shockedReturn);
        
        shockedPaths[baseIdx + t] = Math.max(newPrice, 1e-8);
      }
    }
    
    return shockedPaths;
  }

  private generateHeatmap(
    scenario: StressScenario,
    losses: number[]
  ): number[][] {
    // Simplified heatmap: loss distribution across percentiles
    const percentiles = [0.5, 0.75, 0.9, 0.95, 0.99, 0.999];
    const heatmap: number[][] = [];
    
    const sortedLosses = [...losses].sort((a, b) => a - b);
    
    for (let i = 0; i < percentiles.length; i++) {
      const idx = Math.floor(percentiles[i] * sortedLosses.length);
      heatmap.push([
        percentiles[i] * 100,
        sortedLosses[Math.min(idx, sortedLosses.length - 1)]
      ]);
    }
    
    return heatmap;
  }

  private generateReport(results: StressTestResult[]): StressTestReport {
    // Find worst case scenario
    let worstCaseScenario = '';
    let maxLoss = 0;
    
    const riskContribution: Record<string, number> = {};
    let totalRisk = 0;
    
    results.forEach(result => {
      riskContribution[result.scenario] = result.var['99%'];
      totalRisk += result.var['99%'];
      
      if (result.maxLoss > maxLoss) {
        maxLoss = result.maxLoss;
        worstCaseScenario = result.scenario;
      }
    });
    
    // Calculate diversification benefit
    const standaloneRisk = Object.values(riskContribution).reduce((a, b) => a + b, 0);
    const portfolioRisk = results[0]?.var['99%'] || 0; // Simplified
    const diversificationBenefit = standaloneRisk > 0 
      ? (standaloneRisk - portfolioRisk) / standaloneRisk 
      : 0;
    
    return {
      results,
      comparativeAnalysis: {
        worstCaseScenario,
        riskContribution,
        diversificationBenefit
      }
    };
  }
}
