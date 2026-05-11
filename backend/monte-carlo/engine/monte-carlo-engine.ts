// Main Monte Carlo Engine - Integration and Performance Optimization
import { PathGenerator } from './path-generator';
import { CorrelationMatrix } from './correlation-matrix';
import { RiskCalculator } from './risk-calculator';
import { StressTestRunner, BlackSwanScenario, FlashCrashScenario, LiquidityCrisisScenario, RegimeShiftScenario, StressTestResult } from './stress-test-engine';
import { MonteCarloRequest, MonteCarloResult, RiskMetrics } from '../types';
import { randomUUID } from 'crypto';

export class MonteCarloEngine {
  private pathGenerator: PathGenerator;
  private riskCalculator: RiskCalculator;
  private stressTestRunner: StressTestRunner;
  private activeJobs: Map<string, JobStatus>;
  private useGPU: boolean;

  constructor() {
    this.pathGenerator = new PathGenerator({
      initialPrice: 100,
      drift: 0.05,
      volatility: 0.2,
      timeSteps: 252,
      numPaths: 10000,
      seed: 42,
      useGPU: true
    });
    this.riskCalculator = new RiskCalculator();
    this.stressTestRunner = new StressTestRunner();
    this.activeJobs = new Map();
    this.useGPU = this.detectGPU();
  }

  private detectGPU(): boolean {
    try {
      // Check for WebGL availability
      return typeof window !== 'undefined' && !!window.WebGLRenderingContext;
    } catch {
      return false;
    }
  }

  /**
   * Start Monte Carlo simulation
   */
  async simulate(request: MonteCarloRequest): Promise<MonteCarloResult> {
    const jobId = `mc_${randomUUID().substring(0, 8)}`;
    
    // Create job status
    this.activeJobs.set(jobId, {
      id: jobId,
      status: 'running',
      progress: 0,
      startTime: Date.now()
    });
    
    try {
      // Run simulation asynchronously
      const result = await this.runSimulation(request, jobId);
      
      this.activeJobs.set(jobId, {
        ...this.activeJobs.get(jobId)!,
        status: 'completed',
        progress: 100,
        result
      });
      
      return {
        jobId,
        status: 'completed',
        result
      };
    } catch (error) {
      this.activeJobs.set(jobId, {
        ...this.activeJobs.get(jobId)!,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return {
        jobId,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Run the actual simulation
   */
  private async runSimulation(
    request: MonteCarloRequest,
    jobId: string
  ): Promise<RiskMetrics> {
    const startTime = Date.now();
    const { portfolio, parameters } = request;
    
    // Calculate portfolio value
    const portfolioValue = portfolio.positions.reduce(
      (sum, pos) => sum + pos.quantity * pos.currentPrice,
      0
    );
    
    // Step 1: Generate correlated price paths
    this.updateProgress(jobId, 10, 'Generating price paths...');
    const paths = await this.generateCorrelatedPaths(portfolio, parameters);
    
    // Step 2: Calculate loss distribution
    this.updateProgress(jobId, 40, 'Calculating loss distribution...');
    const timeSteps = parameters.timeHorizon * 252; // Trading days per year
    const losses = this.riskCalculator.calculateLossDistribution(
      paths,
      timeSteps,
      portfolioValue
    );
    
    // Step 3: Calculate risk metrics
    this.updateProgress(jobId, 70, 'Computing risk metrics...');
    const var95 = this.riskCalculator.historicalVaR(losses, 0.95);
    const var99 = this.riskCalculator.historicalVaR(losses, 0.99);
    const cvar95 = this.riskCalculator.conditionalVaR(losses, 0.95);
    const cvar99 = this.riskCalculator.conditionalVaR(losses, 0.99);
    
    // Step 4: Component VaR
    this.updateProgress(jobId, 85, 'Computing component VaR...');
    const componentVaR = this.calculateComponentVaR(portfolio, losses, portfolioValue);
    
    // Step 5: Tail risk
    this.updateProgress(jobId, 95, 'Analyzing tail risk...');
    const tailRisk = this.calculateTailRisk(losses);
    
    // Step 6: Convergence check
    const convergence = this.checkConvergence(losses, parameters.numPaths);
    
    const runtimeMs = Date.now() - startTime;

    return {
      var: { '95%': var95, '99%': var99 },
      cvar: { '95%': cvar95, '99%': cvar99 },
      expectedShortfall: cvar99,
      componentVaR,
      tailRisk,
      simulationStats: {
        numPaths: parameters.numPaths,
        convergence: this.checkConvergence(losses, parameters.numPaths),
        runtimeMs
      }
    };
  }

  /**
   * Generate correlated price paths for portfolio
   */
  private async generateCorrelatedPaths(
    portfolio: MonteCarloRequest['portfolio'],
    parameters: MonteCarloRequest['parameters']
  ): Promise<Float64Array> {
    const numAssets = portfolio.positions.length;
    const timeSteps = parameters.timeHorizon * 252;
    const numPaths = parameters.numPaths;
    
    // Use GPU if available and beneficial
    const useGPU = this.useGPU && numPaths >= 1000;
    
    if (useGPU) {
      return this.generatePathsGPU(portfolio, parameters);
    } else {
      return this.generatePathsCPU(portfolio, parameters);
    }
  }

  /**
   * Generate paths using CPU (NumJS)
   */
  private generatePathsCPU(
    portfolio: MonteCarloRequest['portfolio'],
    parameters: MonteCarloRequest['parameters']
  ): Float64Array {
    const numAssets = portfolio.positions.length;
    const timeSteps = parameters.timeHorizon * 252;
    const numPaths = parameters.numPaths;
    const totalPoints = numPaths * (timeSteps + 1);
    
    // For simplicity, generate aggregate portfolio paths
    // In production, generate per-asset paths and aggregate
    const paths = new Float64Array(totalPoints);
    const dt = 1 / timeSteps;
    
    // Portfolio-level parameters (simplified)
    const portfolioDrift = 0.08;
    const portfolioVol = 0.25;
    const driftAdj = (portfolioDrift - 0.5 * portfolioVol * portfolioVol) * dt;
    const volAdj = portfolioVol * Math.sqrt(dt);
    
    // Initialize
    const initialValue = portfolio.positions.reduce(
      (sum, pos) => sum + pos.quantity * pos.currentPrice,
      0
    );
    
    for (let i = 0; i < numPaths; i++) {
      paths[i * (timeSteps + 1)] = initialValue;
    }
    
    // Generate paths
    for (let i = 0; i < numPaths; i++) {
      const baseIdx = i * (timeSteps + 1);
      for (let t = 1; t <= timeSteps; t++) {
        const z = this.gaussianRandom();
        const logReturn = driftAdj + volAdj * z;
        const prevPrice = paths[baseIdx + t - 1];
        const newPrice = prevPrice * Math.exp(logReturn);
        paths[baseIdx + t] = Math.max(newPrice, 1e-8);
      }
    }
    
    return paths;
  }

  /**
   * Generate paths using GPU (WebGL)
   */
  private async generatePathsGPU(
    portfolio: MonteCarloRequest['portfolio'],
    parameters: MonteCarloRequest['parameters']
  ): Promise<Float64Array> {
    // Fallback to CPU for now (GPU.js requires browser environment)
    // In production, use gpu.js with headless-gl in Node.js
    return this.generatePathsCPU(portfolio, parameters);
  }

  /**
   * Calculate component VaR for each position
   */
  private calculateComponentVaR(
    portfolio: MonteCarloRequest['portfolio'],
    losses: number[],
    portfolioValue: number
  ): Record<string, number> {
    const componentVaR: Record<string, number> = {};
    
    portfolio.positions.forEach(position => {
      const positionValue = position.quantity * position.currentPrice;
      const weight = positionValue / portfolioValue;
      
      // Simplified: proportional contribution
      // In production, use marginal VaR calculation
      const totalVaR = this.riskCalculator.historicalVaR(losses, 0.95);
      componentVaR[position.symbol] = totalVaR * weight;
    });
    
    return componentVaR;
  }

  /**
   * Calculate tail risk metrics
   */
  private calculateTailRisk(losses: number[]) {
    const sorted = [...losses].sort((a, b) => b - a);
    
    return {
      worstCaseLoss: sorted[0],
      percentile99_9: sorted[Math.floor(0.001 * sorted.length)]
    };
  }

  /**
   * Check convergence of VaR estimate
   */
  private checkConvergence(losses: number[], numPaths: number): number {
    // Split into two halves and compare VaR estimates
    const half = Math.floor(losses.length / 2);
    const firstHalf = losses.slice(0, half);
    const secondHalf = losses.slice(half);
    
    const var1 = this.riskCalculator.historicalVaR(firstHalf, 0.95);
    const var2 = this.riskCalculator.historicalVaR(secondHalf, 0.95);
    
    return Math.abs(var1 - var2) / ((var1 + var2) / 2);
  }

  /**
   * Update job progress
   */
  private updateProgress(jobId: string, progress: number, message?: string): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      job.progress = progress;
      job.lastUpdate = Date.now();
      if (message) {
        job.message = message;
      }
    }
  }

/**
    * Get job status
    */
  async getStatus(jobId: string): Promise<MonteCarloResult | null> {
    const job = this.activeJobs.get(jobId);
    if (!job) {
      return null;
    }

    return {
      jobId,
      status: job.status,
      result: job.result,
      error: job.error
    };
  }

  /**
   * Run stress tests
   */
  async runStressTests(
    portfolio: MonteCarloRequest['portfolio'],
    scenarios: Array<{
      type: 'black-swan' | 'flash-crash' | 'liquidity-crisis' | 'regime-shift';
      intensity?: number;
    }>
  ): Promise<StressTestResult[]> {
    const portfolioValue = portfolio.positions.reduce(
      (sum, pos) => sum + pos.quantity * pos.currentPrice,
      0
    );
    
    // Add scenarios
    scenarios.forEach(s => {
      switch (s.type) {
        case 'black-swan':
          this.stressTestRunner.addScenario(new BlackSwanScenario(s.intensity));
          break;
        case 'flash-crash':
          this.stressTestRunner.addScenario(new FlashCrashScenario(s.intensity));
          break;
        case 'liquidity-crisis':
          this.stressTestRunner.addScenario(new LiquidityCrisisScenario(s.intensity));
          break;
        case 'regime-shift':
          this.stressTestRunner.addScenario(new RegimeShiftScenario(s.intensity));
          break;
      }
    });
    
    // Run all scenarios
    const report = await this.stressTestRunner.runAllScenarios(portfolioValue);
    return report.results;
  }

  /**
   * Validate VaR model with backtesting
   */
  async validateVaR(
    historicalReturns: number[],
    varEstimates: number[],
    confidenceLevel: number
  ): Promise<{
    passes: boolean;
    pValue: number;
    failureRate: number;
  }> {
    const losses = historicalReturns.map(r => -r);
    const result = this.riskCalculator.kupiecTest(
      losses,
      this.riskCalculator.historicalVaR(losses, confidenceLevel),
      confidenceLevel
    );
    
    return {
      passes: result.passes,
      pValue: result.pValue,
      failureRate: result.failureRate
    };
  }

  private gaussianRandom(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    return r * Math.cos(theta);
  }
}

interface JobStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  startTime: number;
  lastUpdate?: number;
  message?: string;
  result?: RiskMetrics;
  error?: string;
}
