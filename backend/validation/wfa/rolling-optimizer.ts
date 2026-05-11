import { Candle } from '../../indicators/engine';
import { SignalGenerator } from '../../strategy/signal_generator';
import { RiskMode } from '../../risk/manager';
import { IndicatorEngine } from '../../indicators/engine';
import { RegimeType } from '../../regime/detector';

export interface ParameterSet {
  mode: RiskMode;
  confidenceThreshold: number;
  stopLoss: number; // percentage
  takeProfit: number; // percentage
  positionSize: number; // percentage
  earlyExitTarget?: number;
  holdMinProfit?: number;
  holdMaxCandles?: number;
  runnerTriggerProfit?: number;
  runnerPartialExit?: number;
}

export interface OptimizationResult {
  parameters: ParameterSet;
  inSampleSharpe: number;
  inSampleMaxDrawdown: number;
  outOfSampleSharpe: number;
  outOfSampleMaxDrawdown: number;
  fitnessScore: number;
  tradeCount: number;
  winRate: number;
}

export interface OptimizationConfig {
  maxIterations: number;
  earlyStopThreshold: number;
  parameterBounds: {
    confidenceThreshold: [number, number];
    stopLoss: [number, number];
    takeProfit: [number, number];
    positionSize: [number, number];
  };
  cacheSize: number;
}

export class RollingOptimizer {
  private readonly config: OptimizationConfig;
  private readonly parameterCache = new Map<string, OptimizationResult>();

  constructor(config: Partial<OptimizationConfig> = {}) {
    this.config = {
      maxIterations: config.maxIterations ?? 10000,
      earlyStopThreshold: config.earlyStopThreshold ?? 0.5,
      parameterBounds: config.parameterBounds ?? {
        confidenceThreshold: [60, 90],
        stopLoss: [0.5, 5.0],
        takeProfit: [0.5, 5.0],
        positionSize: [0.01, 0.20],
      },
      cacheSize: config.cacheSize ?? 10000,
    };
  }

  /**
   * Optimize parameters for a specific risk mode using walk-forward validation
   */
  async optimizeMode(
    mode: RiskMode,
    inSampleData: Candle[],
    outOfSampleData: Candle[],
    baseParameters: Partial<ParameterSet> = {}
  ): Promise<OptimizationResult> {
    const cacheKey = this.generateCacheKey(mode, inSampleData, outOfSampleData, baseParameters);
    if (this.parameterCache.has(cacheKey)) {
      return this.parameterCache.get(cacheKey)!;
    }

    // Generate parameter grid for this mode
    const parameterGrid = this.generateParameterGrid(mode, baseParameters);

    let bestResult: OptimizationResult | null = null;
    let iterationsWithoutImprovement = 0;
    const maxIterationsWithoutImprovement = Math.floor(this.config.maxIterations * 0.2);

    for (let i = 0; i < Math.min(parameterGrid.length, this.config.maxIterations); i++) {
      const params = parameterGrid[i];
      const result = await this.evaluateParameters(params, inSampleData, outOfSampleData);

      if (!bestResult || result.fitnessScore > bestResult.fitnessScore) {
        bestResult = result;
        iterationsWithoutImprovement = 0;
      } else {
        iterationsWithoutImprovement++;
      }

      // Early stopping: terminate if no improvement for 20% of iterations
      if (iterationsWithoutImprovement >= maxIterationsWithoutImprovement) {
        break;
      }

      // Emergency stop: terminate if Sharpe drops below threshold
      if (result.outOfSampleSharpe < this.config.earlyStopThreshold) {
        break;
      }
    }

    if (!bestResult) {
      throw new Error(`Optimization failed for mode ${mode}`);
    }

    // Cache result
    if (this.parameterCache.size >= this.config.cacheSize) {
      const firstKey = this.parameterCache.keys().next().value;
      this.parameterCache.delete(firstKey);
    }
    this.parameterCache.set(cacheKey, bestResult);

    return bestResult;
  }

  /**
   * Evaluate a parameter set on in-sample and out-of-sample data
   */
  private async evaluateParameters(
    params: ParameterSet,
    inSampleData: Candle[],
    outOfSampleData: Candle[]
  ): Promise<OptimizationResult> {
    // Evaluate in-sample performance
    const inSampleResult = await this.backtestParameters(params, inSampleData);

    // Evaluate out-of-sample performance
    const outOfSampleResult = await this.backtestParameters(params, outOfSampleData);

    // Calculate fitness score: Sharpe ratio with max drawdown penalty (λ=2.0)
    const lambda = 2.0;
    const inSampleFitness = inSampleResult.sharpe - lambda * inSampleResult.maxDrawdown;
    const outOfSampleFitness = outOfSampleResult.sharpe - lambda * outOfSampleResult.maxDrawdown;

    // Overall fitness: weight OOS more heavily (70% OOS, 30% IS)
    const fitnessScore = 0.7 * outOfSampleFitness + 0.3 * inSampleFitness;

    return {
      parameters: params,
      inSampleSharpe: inSampleResult.sharpe,
      inSampleMaxDrawdown: inSampleResult.maxDrawdown,
      outOfSampleSharpe: outOfSampleResult.sharpe,
      outOfSampleMaxDrawdown: outOfSampleResult.maxDrawdown,
      fitnessScore,
      tradeCount: outOfSampleResult.tradeCount,
      winRate: outOfSampleResult.winRate,
    };
  }

  /**
   * Run backtest with specific parameters
   */
  private async backtestParameters(
    params: ParameterSet,
    data: Candle[]
  ): Promise<{ sharpe: number; maxDrawdown: number; tradeCount: number; winRate: number }> {
    const returns: number[] = [];
    let tradeCount = 0;
    let winningTrades = 0;
    let cumulativeReturn = 1.0;
    let peakReturn = 1.0;
    let maxDrawdown = 0.0;

    // Create indicator engine and signal generator
    const indicatorEngine = new IndicatorEngine();
    const signalGenerator = new SignalGenerator();

    // Calculate indicators for all data
    const dataWithIndicators = indicatorEngine.calculateAll(data);

    for (let i = 50; i < dataWithIndicators.length; i++) { // Start after warmup
      const currentData = dataWithIndicators.slice(0, i + 1);
      const currentCandle = dataWithIndicators[i];

      // Generate signal with current parameters
      const signal = await signalGenerator.generateSignal(
        currentData,
        RegimeType.STRONG_BULL, // We'll need to detect regime here
        'BTC',
        false,
        'regime'
      );

      if (signal) {
        // Apply parameter constraints
        if (signal.confidence < params.confidenceThreshold) {
          continue;
        }

        // Simulate trade execution with parameter-adjusted levels
        const entryPrice = signal.entryPrice;
        const stopLoss = entryPrice * (1 - params.stopLoss / 100);
        const takeProfit = entryPrice * (1 + params.takeProfit / 100);

        // Find exit point (simplified - in reality would use next candles)
        let exitPrice = entryPrice;
        let tradeReturn = 0;

        // Simulate holding until stop loss or take profit
        for (let j = i + 1; j < Math.min(i + 20, dataWithIndicators.length); j++) { // Max hold 20 candles
          const nextCandle = dataWithIndicators[j];
          const high = nextCandle.high;
          const low = nextCandle.low;

          if (signal.side === 'buy') {
            if (low <= stopLoss) {
              exitPrice = stopLoss;
              tradeReturn = (exitPrice - entryPrice) / entryPrice;
              break;
            } else if (high >= takeProfit) {
              exitPrice = takeProfit;
              tradeReturn = (exitPrice - entryPrice) / entryPrice;
              break;
            }
          } else { // sell
            if (high >= stopLoss) {
              exitPrice = stopLoss;
              tradeReturn = (entryPrice - exitPrice) / entryPrice;
              break;
            } else if (low <= takeProfit) {
              exitPrice = takeProfit;
              tradeReturn = (entryPrice - exitPrice) / entryPrice;
              break;
            }
          }
        }

        // Calculate position size adjusted return
        const positionReturn = tradeReturn * params.positionSize;
        returns.push(positionReturn);
        tradeCount++;

        if (positionReturn > 0) {
          winningTrades++;
        }

        // Update drawdown tracking
        cumulativeReturn *= (1 + positionReturn);
        if (cumulativeReturn > peakReturn) {
          peakReturn = cumulativeReturn;
        }
        const drawdown = (peakReturn - cumulativeReturn) / peakReturn;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
      }
    }

    // Calculate Sharpe ratio (annualized, assuming daily returns)
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const stdDev = Math.sqrt(
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    );

    const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(365) : 0; // Annualized
    const winRate = tradeCount > 0 ? winningTrades / tradeCount : 0;

    return {
      sharpe,
      maxDrawdown,
      tradeCount,
      winRate,
    };
  }

  /**
   * Generate parameter grid for optimization
   */
  private generateParameterGrid(mode: RiskMode, baseParams: Partial<ParameterSet>): ParameterSet[] {
    const grid: ParameterSet[] = [];
    const bounds = this.config.parameterBounds;

    // Generate grid points (simplified - in production would use more sophisticated sampling)
    const confidenceSteps = 6; // 60, 65, 70, 75, 80, 85
    const stopLossSteps = 5; // 1.0, 2.0, 3.0, 4.0, 5.0
    const takeProfitSteps = 5; // 1.0, 2.0, 3.0, 4.0, 5.0
    const positionSizeSteps = 4; // 0.05, 0.08, 0.10, 0.15

    for (let c = 0; c < confidenceSteps; c++) {
      for (let sl = 0; sl < stopLossSteps; sl++) {
        for (let tp = 0; tp < takeProfitSteps; tp++) {
          for (let ps = 0; ps < positionSizeSteps; ps++) {
            const confidenceThreshold = bounds.confidenceThreshold[0] +
              (c * (bounds.confidenceThreshold[1] - bounds.confidenceThreshold[0]) / (confidenceSteps - 1));

            const stopLoss = bounds.stopLoss[0] +
              (sl * (bounds.stopLoss[1] - bounds.stopLoss[0]) / (stopLossSteps - 1));

            const takeProfit = bounds.takeProfit[0] +
              (tp * (bounds.takeProfit[1] - bounds.takeProfit[0]) / (takeProfitSteps - 1));

            const positionSize = bounds.positionSize[0] +
              (ps * (bounds.positionSize[1] - bounds.positionSize[0]) / (positionSizeSteps - 1));

            // Apply mode-specific constraints
            const constrainedParams = this.applyModeConstraints({
              mode,
              confidenceThreshold: Math.round(confidenceThreshold),
              stopLoss,
              takeProfit,
              positionSize,
              ...baseParams,
            });

            grid.push(constrainedParams);
          }
        }
      }
    }

    return grid;
  }

  /**
   * Apply mode-specific parameter constraints
   */
  private applyModeConstraints(params: ParameterSet): ParameterSet {
    const constraints = {
      [RiskMode.ULTRA_CONSERVATIVE]: {
        confidenceThreshold: [85, 95],
        stopLoss: [1.0, 2.0],
        takeProfit: [0.5, 1.5],
        positionSize: [0.01, 0.03],
      },
      [RiskMode.CONSERVATIVE]: {
        confidenceThreshold: [75, 85],
        stopLoss: [1.5, 2.5],
        takeProfit: [1.0, 2.0],
        positionSize: [0.02, 0.04],
      },
      [RiskMode.MODERATE]: {
        confidenceThreshold: [70, 80],
        stopLoss: [2.0, 3.0],
        takeProfit: [1.5, 2.5],
        positionSize: [0.03, 0.07],
      },
      [RiskMode.AGGRESSIVE]: {
        confidenceThreshold: [65, 75],
        stopLoss: [2.5, 4.0],
        takeProfit: [2.0, 3.5],
        positionSize: [0.05, 0.10],
      },
      [RiskMode.DEGEN]: {
        confidenceThreshold: [60, 70],
        stopLoss: [3.0, 5.0],
        takeProfit: [2.5, 4.5],
        positionSize: [0.08, 0.20],
      },
      [RiskMode.AI_ENHANCED]: {
        confidenceThreshold: [70, 80],
        stopLoss: [2.0, 3.0],
        takeProfit: [1.5, 2.5],
        positionSize: [0.03, 0.07],
      },
    };

    const constraint = constraints[params.mode];
    if (constraint) {
      params.confidenceThreshold = Math.max(
        constraint.confidenceThreshold[0],
        Math.min(constraint.confidenceThreshold[1], params.confidenceThreshold)
      );
      params.stopLoss = Math.max(
        constraint.stopLoss[0],
        Math.min(constraint.stopLoss[1], params.stopLoss)
      );
      params.takeProfit = Math.max(
        constraint.takeProfit[0],
        Math.min(constraint.takeProfit[1], params.takeProfit)
      );
      params.positionSize = Math.max(
        constraint.positionSize[0],
        Math.min(constraint.positionSize[1], params.positionSize)
      );
    }

    return params;
  }

  /**
   * Generate cache key for parameter evaluation results
   */
  private generateCacheKey(
    mode: RiskMode,
    inSampleData: Candle[],
    outOfSampleData: Candle[],
    baseParams: Partial<ParameterSet>
  ): string {
    const inSampleHash = this.simpleHash(JSON.stringify(inSampleData.slice(0, 10)));
    const outOfSampleHash = this.simpleHash(JSON.stringify(outOfSampleData.slice(0, 10)));
    const paramsHash = this.simpleHash(JSON.stringify(baseParams));

    return `${mode}_${inSampleHash}_${outOfSampleHash}_${paramsHash}`;
  }

  /**
   * Simple hash function for cache keys
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  /**
   * Clear parameter cache
   */
  clearCache(): void {
    this.parameterCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.parameterCache.size,
      maxSize: this.config.cacheSize,
    };
  }
}