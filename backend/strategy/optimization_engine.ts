import { runQuery } from '../database.js';
import { RiskMode, RiskManager } from '../risk/manager.js';
import OpenAI from 'openai';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

type QueryFn = (query: string, params?: any[], mode?: 'all' | 'get' | 'run') => Promise<any>;
type AiClientFactory = (apiKey: string) => OpenAI;

export class OptimizationEngine {
  private riskManager: RiskManager;
  private isOptimizing: boolean = false;
  private queryFn: QueryFn;
  private aiClientFactory: AiClientFactory;
  private optimizationTrials: Array<{ params: number[], score: number }> = [];

  constructor(
    riskManager: RiskManager,
    deps: {
      queryFn?: QueryFn;
      aiClientFactory?: AiClientFactory;
    } = {}
  ) {
    this.riskManager = riskManager;
    this.queryFn = deps.queryFn || runQuery;
    this.aiClientFactory = deps.aiClientFactory || ((apiKey: string) => new OpenAI({
      baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
      apiKey: 'ollama'
    }));
  }

  async bayesianOptimize(regime: string): Promise<any> {
    const pythonScript = path.resolve(process.cwd(), 'backend/optimization/bayesian_optimizer.py');
    
    // Fetch recent optimization history to feed as warm-start
    const recentTrials = await this.queryFn(`
      SELECT params, score FROM optimization_trials
      WHERE regime = ? ORDER BY timestamp DESC LIMIT 50
    `, [regime], 'all');

    try {
      const { stdout } = await execAsync(`python3 ${pythonScript}`, {
        input: JSON.stringify(recentTrials),
        timeout: 10000
      });
      
      const bestParams = JSON.parse(stdout);
      return bestParams;
    } catch (error) {
      console.error("Python optimization failed:", error);
      // Fallback defaults
      return {
        stopLoss: 0.02,
        takeProfit: 0.05,
        confidenceThreshold: 0.75,
        leverage: 2.0
      };
    }
  }

  private async evaluateParameters(regime: string, params: number[]): Promise<number> {
    // Simulate evaluation - in practice, this would run backtests or live evaluation
    const [stopLoss, takeProfit, confidenceThreshold, leverage] = params;

    // Fetch recent performance data
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentTrades = await this.queryFn(`
      SELECT pnl, confidence FROM shadow_trades
      WHERE timestamp > ? AND regime = ? AND status = 'closed'
    `, [sevenDaysAgo, regime], 'all');

    if (recentTrades.length === 0) return 0;

    // Calculate Sharpe-like ratio with parameter adjustments
    let totalPnL = 0;
    let totalVariance = 0;
    for (const trade of recentTrades) {
      if (trade.confidence >= confidenceThreshold) {
        const adjustedPnL = trade.pnl * (1 + (leverage - 1) * 0.1); // Simplified leverage effect
        totalPnL += adjustedPnL;
        totalVariance += adjustedPnL * adjustedPnL;
      }
    }

    const meanReturn = totalPnL / recentTrades.length;
    const variance = totalVariance / recentTrades.length - meanReturn * meanReturn;
    const sharpe = variance > 0 ? meanReturn / Math.sqrt(variance) : 0;

    return sharpe;
  }

  async optimize(regime: string) {
    if (this.isOptimizing) return;
    this.isOptimizing = true;
    console.log(`Starting Bayesian optimization for regime: ${regime}`);

    try {
      const currentConfigs = this.riskManager.RISK_CONFIGS;

      // Use Bayesian optimization for each risk mode
      const optimizedConfigs = { ...currentConfigs };

      for (const mode of Object.keys(currentConfigs)) {
        console.log(`Optimizing parameters for ${mode} mode...`);
        const optimalParams = await this.bayesianOptimize(regime);

        // Apply Bayesian optimization results with smoothing
        for (const [key, val] of Object.entries(optimalParams)) {
          const currentVal = currentConfigs[mode][key];
          if (typeof currentVal === 'number' && typeof val === 'number') {
            optimizedConfigs[mode][key] = Number((val * 0.8 + currentVal * 0.2).toFixed(4));
          }
        }

        // Store optimization trial in database
        await this.storeOptimizationTrial(regime, mode, optimalParams, 0); // score placeholder
      }

      await this.riskManager.saveConfigs(optimizedConfigs);
      console.log("Bayesian optimization complete. New configs saved.");

      // Run Monte Carlo validation
      await this.validateWithMonteCarlo(regime, optimizedConfigs);

    } catch (error) {
      console.error("Bayesian optimization failed:", error);
    } finally {
      this.isOptimizing = false;
    }
  }

  private async storeOptimizationTrial(regime: string, mode: string, params: any, score: number) {
    await this.queryFn(`
      INSERT INTO optimization_trials (regime, mode, params, score, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `, [regime, mode, JSON.stringify(params), score, Date.now()]);
  }

  private async validateWithMonteCarlo(regime: string, configs: any) {
    // Placeholder for Monte Carlo validation - implement in next step
    console.log("Running Monte Carlo validation on optimized configs...");
  }
}
