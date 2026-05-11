import { Decimal } from 'decimal.js';
import {
  ImpactSimulator as IImpactSimulator,
  OrderRequest,
  ExecutionSimulation,
  ExecutionScenario,
  OrderBookSnapshot,
  MarketState
} from './types.js';
import { SlippageEngine } from './engine.js';
import { logger } from '../logging/logger.js';

export class ImpactSimulator implements IImpactSimulator {
  private slippageEngine: SlippageEngine;
  private pathsPerSimulation = 1000;

  constructor(slippageEngine: SlippageEngine) {
    this.slippageEngine = slippageEngine;
    logger.info('ImpactSimulator initialized', { service: 'ImpactSimulator' });
  }

  async simulateExecution(
    order: OrderRequest,
    scenarios: ExecutionScenario[] = ['best_case', 'worst_case', 'expected']
  ): Promise<ExecutionSimulation[]> {
    const simulations = scenarios.map(scenario =>
      this.runMonteCarloSimulation(order, scenario)
    );

    return await Promise.all(simulations);
  }

  private async runMonteCarloSimulation(
    order: OrderRequest,
    scenario: ExecutionScenario
  ): Promise<ExecutionSimulation> {
    const paths = this.generatePricePaths(order.symbol, scenario, this.pathsPerSimulation);
    const executions = paths.map(path =>
      this.simulateOrderExecution(order, path)
    );

    const slippageValues = executions.map(e => Number(e.slippage));
    const timeValues = executions.map(e => e.timeToFill);

    return {
      scenario,
      expectedSlippage: this.mean(slippageValues),
      worstCaseSlippage: this.percentile(slippageValues, 95),
      executionTime: this.mean(timeValues)
    };
  }

  private generatePricePaths(
    symbol: string,
    scenario: ExecutionScenario,
    numPaths: number
  ): PricePath[] {
    // Simplified price path generation
    const paths: PricePath[] = [];
    const basePrice = 50000; // Mock current price
    const timeSteps = 100; // 100 time steps for execution
    const dt = 1 / timeSteps;

    for (let i = 0; i < numPaths; i++) {
      const path: PricePath = {
        prices: [],
        timestamps: []
      };

      let price = basePrice;
      const startTime = Date.now();

      for (let t = 0; t < timeSteps; t++) {
        const drift = this.getScenarioDrift(scenario);
        const volatility = this.getScenarioVolatility(scenario);
        const randomShock = this.randomNormal() * volatility * Math.sqrt(dt);

        price *= Math.exp((drift - volatility * volatility / 2) * dt + randomShock);

        path.prices.push(price);
        path.timestamps.push(startTime + t * 10); // 10ms per step
      }

      paths.push(path);
    }

    return paths;
  }

  private simulateOrderExecution(order: OrderRequest, path: PricePath): ExecutionResult {
    let remainingSize = Number(order.size);
    let totalCost = 0;
    let filledSize = 0;
    let executionTime = 0;

    // Simplified market order execution
    for (let i = 0; i < path.prices.length && remainingSize > 0; i++) {
      const price = path.prices[i];
      const time = path.timestamps[i];

      // Execute a portion of the order at current price
      const fillSize = Math.min(remainingSize * 0.1, remainingSize); // 10% fill per step
      totalCost += fillSize * price;
      filledSize += fillSize;
      remainingSize -= fillSize;

      if (remainingSize <= 0) {
        executionTime = time - path.timestamps[0];
        break;
      }
    }

    const avgExecutionPrice = totalCost / filledSize;
    const slippage = Math.abs(avgExecutionPrice - path.prices[0]) / path.prices[0];

    return {
      slippage: new Decimal(slippage),
      timeToFill: executionTime,
      avgExecutionPrice: new Decimal(avgExecutionPrice),
      filledSize: new Decimal(filledSize)
    };
  }

  private getScenarioDrift(scenario: ExecutionScenario): number {
    const drifts = {
      best_case: 0.0001,    // Slight upward drift (favorable)
      expected: 0.0,        // No drift
      worst_case: -0.0001   // Slight downward drift (unfavorable)
    };

    return drifts[scenario];
  }

  private getScenarioVolatility(scenario: ExecutionScenario): number {
    const volatilities = {
      best_case: 0.001,     // Low volatility
      expected: 0.005,      // Normal volatility
      worst_case: 0.01      // High volatility
    };

    return volatilities[scenario];
  }

  private randomNormal(): number {
    // Box-Muller transform for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  private mean(values: number[]): number {
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  private percentile(values: number[], p: number): number {
    const sorted = values.sort((a, b) => a - b);
    const index = Math.floor((p / 100) * (sorted.length - 1));
    return sorted[index];
  }
}

interface PricePath {
  prices: number[];
  timestamps: number[];
}

interface ExecutionResult {
  slippage: Decimal;
  timeToFill: number;
  avgExecutionPrice: Decimal;
  filledSize: Decimal;
}