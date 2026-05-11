// Monte Carlo Simulation Engine - Type Definitions

export interface MonteCarloRequest {
  portfolio: {
    positions: Array<{
      symbol: string;
      quantity: number;
      currentPrice: number;
    }>;
  };
  parameters: {
    timeHorizon: number;      // Days
    confidenceLevels: number[]; // [0.95, 0.99]
    numPaths: number;          // 10000-100000
    model: 'gbm' | 'jump-diffusion' | 'heston';
  };
  correlationMatrix?: number[][];  // Optional
}

export interface MonteCarloResult {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: {
    var: Record<string, number>;      // { '95%': 12345, '99%': 23456 }
    cvar: Record<string, number>;
    expectedShortfall: number;
    componentVaR: Record<string, number>;
    tailRisk: {
      worstCaseLoss: number;
      percentile99_9: number;
    };
    simulationStats: {
      numPaths: number;
      convergence: number;
      runtimeMs: number;
    };
  };
  error?: string;
}

export interface PathGeneratorConfig {
  initialPrice: number;
  drift: number;
  volatility: number;
  timeSteps: number;
  numPaths: number;
  seed?: number;
  useGPU?: boolean;
}

export interface CorrelationMatrixConfig {
  returns: number[][];  // [nTimesteps × nAssets]
  method: 'ledoit-wolf' | 'sample';
}

export interface StressScenario {
  type: 'black-swan' | 'flash-crash' | 'liquidity-crisis' | 'regime-shift';
  intensity: number;  // 0.5 = mild, 1.0 = base, 2.0 = severe
}

export interface RiskMetrics {
  var: Record<string, number>;
  cvar: Record<string, number>;
  expectedShortfall: number;
  componentVaR: Record<string, number>;
  tailRisk: {
    worstCaseLoss: number;
    percentile99_9: number;
  };
  simulationStats: {
    numPaths: number;
    convergence: number;
    runtimeMs: number;
  };
}

export interface ValidationReport {
  passed: boolean;
  tests: Array<{
    name: string;
    passed: boolean;
    metric?: number;
    threshold?: number;
  }>;
}
