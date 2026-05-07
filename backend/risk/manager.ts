import { runQuery } from '../database.js';

export enum RiskMode {
  ULTRA_CONSERVATIVE = "ultra_conservative",
  CONSERVATIVE = "conservative",
  MODERATE = "moderate",
  AGGRESSIVE = "aggressive",
  DEGEN = "degen",
  AI_ENHANCED = "ai_enhanced"
}

export const DEFAULT_RISK_CONFIGS = {
  [RiskMode.ULTRA_CONSERVATIVE]: {
    positionSize: 0.02, // 2% per trade
    maxDrawdown: 0.07, // 7%
    maxDailyLoss: 0.03, // 3%
    confidenceThreshold: 85,
    maxConcurrentPositions: 1,
    maxDailyTrades: 8,
    leverage: 1.0,
    stopLoss: 1.5, // 1.5%
    takeProfit: 0.8, // 0.8%
    activeRegimes: ["strong_bull", "weak_bull"],
    earlyExitEnabled: false,
    multiCandleHoldEnabled: false,
    runnerEnabled: false,
    description: "Maximum safety. Only takes the highest confidence signals. Stay out of bear/sideways markets. Ideal for capital preservation."
  },
  [RiskMode.CONSERVATIVE]: {
    positionSize: 0.03, // 3% per trade
    maxDrawdown: 0.11, // 11%
    maxDailyLoss: 0.03, // 3%
    confidenceThreshold: 80,
    maxConcurrentPositions: 2,
    maxDailyTrades: 12,
    leverage: 1.0,
    stopLoss: 2.0, // 2.0%
    takeProfit: 1.2, // 1.2%
    activeRegimes: ["strong_bull", "weak_bull", "sideways"],
    earlyExitEnabled: true,
    earlyExitTarget: 0.8,
    multiCandleHoldEnabled: false,
    runnerEnabled: false,
    description: "Proven strategy. Balanced risk/reward with early exit feature for steady, low-volatility growth."
  },
  [RiskMode.MODERATE]: {
    positionSize: 0.05, // 5% per trade
    maxDrawdown: 0.15, // 15%
    maxDailyLoss: 0.05, // 5%
    confidenceThreshold: 75,
    maxConcurrentPositions: 3,
    maxDailyTrades: 18,
    leverage: 1.5,
    stopLoss: 2.5, // 2.5%
    takeProfit: 1.8, // 1.8%
    activeRegimes: ["strong_bull", "weak_bull", "sideways"],
    earlyExitEnabled: true,
    earlyExitTarget: 1.0,
    multiCandleHoldEnabled: true,
    holdConditions: {
      minProfit: 0.5, // 0.5%
      maxCandles: 3
    },
    runnerEnabled: false,
    description: "Balanced aggression. Uses multi-candle holds to capture extended moves while maintaining strict risk controls."
  },
  [RiskMode.AGGRESSIVE]: {
    positionSize: 0.08, // 8% per trade
    maxDrawdown: 0.22, // 22%
    maxDailyLoss: 0.08, // 8%
    confidenceThreshold: 70,
    maxConcurrentPositions: 4,
    maxDailyTrades: 25,
    leverage: 2.0,
    stopLoss: 3.0, // 3.0%
    takeProfit: 2.5, // 2.5%
    activeRegimes: ["strong_bull", "weak_bull", "sideways", "bear"],
    earlyExitEnabled: true,
    earlyExitTarget: 1.5,
    multiCandleHoldEnabled: true,
    holdConditions: {
      minProfit: 0.3,
      maxCandles: 5
    },
    runnerEnabled: true,
    runnerConditions: {
      triggerProfit: 1.5,
      partialExit: 0.6,
      maxRunnerDuration: 3600000 // 1 hour
    },
    description: "High risk/reward. Uses runners and multi-candle holds to capture outsized moves. Trades all market regimes."
  },
  [RiskMode.DEGEN]: {
    positionSize: 0.15, // 15% per trade
    maxDrawdown: 0.35, // 35%
    maxDailyLoss: 0.15, // 15%
    confidenceThreshold: 65,
    maxConcurrentPositions: 5,
    maxDailyTrades: 40,
    leverage: 3.0,
    stopLoss: 4.0, // 4.0%
    takeProfit: 3.5, // 3.5%
    activeRegimes: ["strong_bull", "weak_bull", "sideways", "bear"],
    earlyExitEnabled: true,
    earlyExitTarget: 2.0,
    multiCandleHoldEnabled: true,
    holdConditions: {
      minProfit: 0.2,
      maxCandles: 8
    },
    runnerEnabled: true,
    runnerConditions: {
      triggerProfit: 1.0,
      partialExit: 0.5,
      maxRunnerDuration: 7200000 // 2 hours
    },
    description: "Maximum aggression. Very high position sizing and leverage. High probability of significant drawdown or blowup."
  },
  [RiskMode.AI_ENHANCED]: {
    positionSize: 0.05, // 5% per trade
    maxDrawdown: 0.15, // 15%
    maxDailyLoss: 0.05, // 5%
    confidenceThreshold: 75,
    maxConcurrentPositions: 3,
    maxDailyTrades: 18,
    leverage: 1.5,
    stopLoss: 2.5, // 2.5%
    takeProfit: 1.8, // 1.8%
    activeRegimes: ["strong_bull", "weak_bull", "sideways"],
    earlyExitEnabled: true,
    earlyExitTarget: 1.0,
    multiCandleHoldEnabled: true,
    holdConditions: {
      minProfit: 0.5,
      maxCandles: 3
    },
    runnerEnabled: false,
    aiValidationEnabled: true,
    description: "AI Enhanced Moderate. Matches Moderate risk profile but with mandatory Gemini AI validation for all trades."
  }
};

export class RiskManager {
  RISK_CONFIGS: Record<string, any>;
  private consecutiveLosses: Record<string, number>;
  private originalPositionSizes: Record<string, number>;

  constructor() {
    this.RISK_CONFIGS = JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIGS));
    this.consecutiveLosses = {};
    this.originalPositionSizes = {};
    // Initialize original position sizes for each mode
    for (const mode of Object.values(RiskMode)) {
      this.originalPositionSizes[mode] = this.RISK_CONFIGS[mode].positionSize;
    }
  }

  async init() {
    await this.loadConfigs();
  }

  async loadConfigs() {
    try {
      const rows = await runQuery(`SELECT value FROM settings WHERE key = 'risk_configs'`, [], 'all');
      const row = rows[0];
      if (row && row.value) {
        const savedConfigs = JSON.parse(row.value);
        this.RISK_CONFIGS = { ...this.RISK_CONFIGS, ...savedConfigs };
      }
      // Re-initialize original position sizes after loading
      for (const mode of Object.values(RiskMode)) {
        this.originalPositionSizes[mode] = this.RISK_CONFIGS[mode].positionSize;
      }
    } catch (e) {
      console.error('Failed to load risk configs:', e);
    }
  }

  async saveConfigs(configs: any) {
    try {
      await runQuery(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, ['risk_configs', JSON.stringify(configs)]);
      this.RISK_CONFIGS = { ...this.RISK_CONFIGS, ...configs };
    } catch (e) {
      console.error('Failed to save risk configs:', e);
    }
  }

  getConfig(mode: RiskMode) {
    return this.RISK_CONFIGS[mode];
  }

  getConsecutiveLosses(mode: RiskMode): number {
    return this.consecutiveLosses[mode] || 0;
  }

  recordLoss(mode: RiskMode) {
    const current = this.consecutiveLosses[mode] || 0;
    this.consecutiveLosses[mode] = current + 1;
    this.applyCircuitBreaker(mode);
  }

  recordWin(mode: RiskMode) {
    this.consecutiveLosses[mode] = 0;
    this.resetPositionSize(mode);
  }

  private applyCircuitBreaker(mode: RiskMode) {
    const losses = this.consecutiveLosses[mode] || 0;
    const config = this.RISK_CONFIGS[mode];
    const originalSize = this.originalPositionSizes[mode];

    if (losses >= 5) {
      // Reduce position size by 50%
      const reducedSize = originalSize * 0.5;
      if (config.positionSize !== reducedSize) {
        config.positionSize = reducedSize;
        console.log(`[RiskManager] Circuit breaker: Position size for ${mode} reduced to ${(reducedSize * 100).toFixed(1)}% due to ${losses} consecutive losses`);
      }
    }
    if (losses >= 7) {
      // Further reduce to 25% of original
      const furtherReducedSize = originalSize * 0.25;
      if (config.positionSize !== furtherReducedSize) {
        config.positionSize = furtherReducedSize;
        console.log(`[RiskManager] Circuit breaker: Position size for ${mode} further reduced to ${(furtherReducedSize * 100).toFixed(1)}% due to ${losses} consecutive losses`);
      }
    }
  }

  private resetPositionSize(mode: RiskMode) {
    const originalSize = this.originalPositionSizes[mode];
    const config = this.RISK_CONFIGS[mode];
    if (config.positionSize !== originalSize) {
      config.positionSize = originalSize;
      console.log(`[RiskManager] Circuit breaker: Position size for ${mode} reset to ${(originalSize * 100).toFixed(1)}% after winning trade`);
    }
  }


  calculatePositionSize(balance: number, entryPrice: number, stopLoss: number, riskMode: RiskMode, confidence: number = 75): number {
    const config = this.RISK_CONFIGS[riskMode];
    
    // MD Part 5.1: Dynamic Position Sizing
    // We use a simplified version: positionSize * confidence_multiplier
    const baseSize = config.positionSize || 0.02;

    // Confidence multiplier (±20%) - from MD Part 5.1 (corrected based on example)
    const confidenceMultiplier = 1.0 + (confidence - 75) / 100;
    const clippedMultiplier = Math.max(0.7, Math.min(1.2, confidenceMultiplier));

    const finalPct = baseSize * clippedMultiplier;
    const amountInCurrency = balance * finalPct;

    const leverage = config.leverage || 1;
    const positionSize = (amountInCurrency * leverage) / entryPrice;
    
    // Optional: Risk-based sizing as a secondary constraint
    // const riskAmount = balance * (config.maxRiskPerTrade || 0.02);
    // const riskPerUnit = Math.abs(entryPrice - stopLoss);
    // if (riskPerUnit > 0) {
    //   const riskBasedSize = riskAmount / riskPerUnit;
    //   return Math.min(positionSize, riskBasedSize);
    // }

    return positionSize;
  }

  validateTrade(signal: any, riskMode: RiskMode, currentPositions: number, regime: string): boolean {
    const config = this.RISK_CONFIGS[riskMode];

    if (signal.confidence < config.confidenceThreshold) return false;
    if (currentPositions >= config.maxConcurrentPositions) return false;

    // Enforce active regimes from MD
    if (config.activeRegimes && !config.activeRegimes.includes(regime)) {
      return false;
    }

    return true;
  }

  checkCircuitBreakers(balance: number, initialBalance: number, dailyLoss: number, riskMode: RiskMode, consecutiveLosses: number = 0, currentAtr: number = 0, avgAtr: number = 0): string | null {
    const config = this.RISK_CONFIGS[riskMode];
    
    const currentDrawdown = (initialBalance - balance) / initialBalance;
    if (currentDrawdown >= config.maxDrawdown) {
      return `Max drawdown reached: ${(currentDrawdown * 100).toFixed(2)}% >= ${(config.maxDrawdown * 100).toFixed(2)}%`;
    }

    if (dailyLoss >= initialBalance * (config.maxDailyLoss || 0.05)) {
      return `Max daily loss reached: $${dailyLoss.toFixed(2)} (Limit: ${(config.maxDailyLoss * 100).toFixed(1)}%)`;
    }

    // MD Part 5.3: Consecutive Losses - track and reduce position size
    const currentLosses = consecutiveLosses > 0 ? consecutiveLosses : (this.consecutiveLosses[riskMode] || 0);
    if (currentLosses >= 5) {
      if (currentLosses >= 7) {
        return `Extreme consecutive losses: ${currentLosses}. Position size reduced to 25%`;
      }
      return `High consecutive losses: ${currentLosses}. Position size reduced to 50%`;
    }

    // MD Part 5.3: Volatility Spike
    if (avgAtr > 0 && currentAtr > avgAtr * 3) {
      return `Volatility spike detected: ATR ${currentAtr.toFixed(2)} > 3x Avg (${avgAtr.toFixed(2)})`;
    }

    return null;
  }
}
