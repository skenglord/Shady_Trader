import { runQuery } from '../database.js';
import { logger } from '../logging/logger.js';
import { randomUUID } from 'crypto';

// ── v6.0 Block 6: Risk safety guards ──

/**
 * Degen live-mode guard. Degen is simulation-only unless explicitly overridden.
 */
export function validateModeForLive(riskMode: string): void {
  if (riskMode !== 'degen') return;
  if (process.env.DEGEN_LIVE_OVERRIDE !== 'true') {
    throw new Error(
      'SAFETY: Degen mode is simulation-only.\n' +
      'Expected max drawdown: 25-35%. Max leverage: 3x. Position size: 15%.\n' +
      'To enable live degen trading, set DEGEN_LIVE_OVERRIDE=true in .env.\n' +
      'This is not recommended for any account under $50,000.'
    );
  }
  logger.warn('DEGEN_LIVE_OVERRIDE active — confirm you accept liquidation risk', { service: 'riskManager' });
}

/**
 * Cap position size so effective at-risk capital never exceeds MAX_EFFECTIVE_RISK_FRACTION.
 * effective risk = size × leverage × stopDistanceFrac. Hard backstop after Kelly.
 */
export function enforceRiskCap(size: number, leverage: number, stopFrac: number): number {
  const MAX_RISK_FRAC = parseFloat(process.env.MAX_EFFECTIVE_RISK_FRACTION ?? '0.005');
  const effective = size * leverage * stopFrac;
  if (effective <= MAX_RISK_FRAC) return size;
  const capped = MAX_RISK_FRAC / (leverage * stopFrac);
  logger.debug('risk_cap_applied', { service: 'riskManager', original: size, capped, effective });
  return capped;
}

/**
 * Absolute dollar cap for degen positions.
 */
export function enforceDegenDollarCap(
  riskMode: string, finalSize: number, equity: number, stopDistanceFrac: number
): number {
  if (riskMode !== 'degen') return finalSize;
  const DEGEN_MAX_USD = parseFloat(process.env.DEGEN_MAX_RISK_DOLLARS ?? '500');
  const dollarRisk = equity * finalSize * stopDistanceFrac;
  if (dollarRisk > DEGEN_MAX_USD && equity * stopDistanceFrac > 0) {
    const capped = DEGEN_MAX_USD / (equity * stopDistanceFrac);
    logger.warn('degen_dollar_cap', { service: 'riskManager', dollarRisk, cap: DEGEN_MAX_USD });
    return capped;
  }
  return finalSize;
}

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
    activeRegimes: ["strongbull", "weakbull"],
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
    activeRegimes: ["strongbull", "weakbull", "sideways"],
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
    activeRegimes: ["strongbull", "weakbull", "sideways"],
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
    activeRegimes: ["strongbull", "weakbull", "sideways", "bear"],
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
      maxPartialExits: 3,
      maxRunnerDuration: 3600000 // 1 hour
    },
    description: "High risk/reward. Uses runners and multi-candle holds to capture outsized moves. Trades all market regimes."
  },
  [RiskMode.DEGEN]: {
    positionSize: 0.15, // 15% per trade (base)
    maxPositionPct: 0.50, // 50% absolute max per trade
    positionScaling: 'confidence', // 'fixed' | 'confidence' | 'kelly' — how positionSize is scaled
    maxDrawdown: 0.35, // 35%
    maxDailyLoss: 0.15, // 15%
    confidenceThreshold: 65,
    maxConcurrentPositions: 5,
    maxDailyTrades: 40,
    leverage: 3.0,
    stopLoss: 4.0, // 4.0%
    takeProfit: 3.5, // 3.5%
    activeRegimes: ["strongbull", "weakbull", "sideways", "bear", "uncertain"],
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
      maxPartialExits: 3,
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
    activeRegimes: ["strongbull", "weakbull", "sideways"],
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
  private consecutiveWins: Record<string, number>;
  private originalPositionSizes: Record<string, number>;

  constructor() {
    this.RISK_CONFIGS = JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIGS));
    this.consecutiveLosses = {};
    this.consecutiveWins = {};
    this.originalPositionSizes = {};
    // Initialize original position sizes for each mode
    for (const mode of Object.values(RiskMode)) {
      this.originalPositionSizes[mode] = this.RISK_CONFIGS[mode].positionSize;
    }
  }

  private async logSystemEvent(eventType: string, message: string, metadata?: any) {
    try {
      const auditId = randomUUID();
      const timestamp = Date.now();
      const metadataJson = metadata ? JSON.stringify(metadata) : null;

      await runQuery(`
        INSERT INTO audit_system_events (id, event_type, message, timestamp, severity, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [auditId, eventType, message, timestamp, 'info', metadataJson]);
    } catch (error) {
      logger.error('Failed to log system event', { error: error.message });
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
      logger.error('Failed to load risk configs', { error: String(e), service: 'manager' });
    }
  }

  async saveConfigs(configs: any) {
    try {
      await runQuery(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, ['risk_configs', JSON.stringify(configs)]);
      this.RISK_CONFIGS = { ...this.RISK_CONFIGS, ...configs };
    } catch (e) {
      logger.error('Failed to save risk configs', { error: String(e), service: 'manager' });
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
    const currentWins = (this.consecutiveWins[mode] || 0) + 1;
    this.consecutiveWins[mode] = currentWins;
    
    // Gradual recovery after multiple wins
    const RECOVERY_WINS = 3;
    if (currentWins >= RECOVERY_WINS) {
      this.resetPositionSize(mode);
      this.consecutiveWins[mode] = 0;
    } else {
      // Partial recovery - restore some position size
      this.partialRecovery(mode, currentWins);
    }
  }

  private partialRecovery(mode: RiskMode, wins: number) {
    const originalSize = this.originalPositionSizes[mode];
    const config = this.RISK_CONFIGS[mode];
    const losses = this.consecutiveLosses[mode] || 0;
    
    if (losses >= 7) {
      // After 7+ losses, gradual recovery from 25% towards original
      const recoveryFactor = 0.25 + (wins * 0.25);
      config.positionSize = Math.min(originalSize, originalSize * recoveryFactor);
    } else if (losses >= 5) {
      // After 5-6 losses, gradual recovery from 50% towards original
      const recoveryFactor = 0.5 + (wins * 0.25);
      config.positionSize = Math.min(originalSize, originalSize * recoveryFactor);
    }
    
    if (config.positionSize !== originalSize && wins <= 3) {
      logger.info(`[RiskManager] Circuit breaker: Position size for ${mode} recovering to ${(config.positionSize * 100).toFixed(1)}% after ${wins} win(s)`);
    }
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
        logger.info(`Circuit breaker: Position size for ${mode} reduced to ${(reducedSize * 100).toFixed(1)}% due to ${losses} consecutive losses`, { service: 'riskmanager' });
      }
    }
    if (losses >= 7) {
      // Further reduce to 25% of original
      const furtherReducedSize = originalSize * 0.25;
      if (config.positionSize !== furtherReducedSize) {
        config.positionSize = furtherReducedSize;
        logger.info(`Circuit breaker: Position size for ${mode} further reduced to ${(furtherReducedSize * 100).toFixed(1)}% due to ${losses} consecutive losses`, { service: 'riskmanager' });
      }
    }
  }

  private resetPositionSize(mode: RiskMode) {
    const originalSize = this.originalPositionSizes[mode];
    const config = this.RISK_CONFIGS[mode];
    if (config.positionSize !== originalSize) {
      config.positionSize = originalSize;
      logger.info(`[RiskManager] Circuit breaker: Position size for ${mode} reset to ${(originalSize * 100).toFixed(1)}% after winning trade`);
    }
  }

  async calculateKellyPositionSize(balance: number, riskMode: RiskMode, regime: string): Promise<number> {
    try {
      // Fetch historical performance for win rate and win/loss ratio calculation
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const historicalTrades = await runQuery(`
        SELECT pnl FROM shadow_trades
        WHERE timestamp > ? AND risk_mode = ? AND regime = ? AND status = 'closed'
        ORDER BY timestamp DESC LIMIT 100
      `, [thirtyDaysAgo, riskMode, regime], 'all');

      if (historicalTrades.length < 10) {
        // Not enough data, fall back to config
        return this.RISK_CONFIGS[riskMode].positionSize;
      }

      const wins = historicalTrades.filter((t: any) => t.pnl > 0);
      const losses = historicalTrades.filter((t: any) => t.pnl < 0);

      const p = wins.length / historicalTrades.length; // Win probability
      const q = 1 - p; // Loss probability

      if (p <= 0 || p >= 1) return this.RISK_CONFIGS[riskMode].positionSize;

      // Calculate average win and loss ratios
      const avgWin = wins.reduce((sum: number, t: any) => sum + Math.abs(t.pnl), 0) / wins.length;
      const avgLoss = losses.reduce((sum: number, t: any) => sum + Math.abs(t.pnl), 0) / losses.length;

      const b = avgWin / avgLoss; // Odds ratio (average win / average loss)

      // Kelly Criterion: f = (bp - q)/b
      const kellyFraction = (b * p - q) / b;

      // Apply bounds and safety factor
      const boundedKelly = Math.max(0.01, Math.min(0.25, kellyFraction * 0.5)); // Half-Kelly for safety

      return boundedKelly;
    } catch (error) {
      logger.error('Failed to calculate Kelly position size', { error: error.message, riskMode, regime });
      return this.RISK_CONFIGS[riskMode].positionSize; // Fallback
    }
  }

  calculatePositionSize(balance: number, entryPrice: number, stopLoss: number, riskMode: RiskMode, confidence: number = 75, regime: string = ''): number {
    const config = this.RISK_CONFIGS[riskMode];

    // Base position size from config (may be adjusted by circuit breaker)
    let baseSize = config.positionSize || 0.02;
    
    // Apply position scaling strategy
    let scalingMultiplier = 1.0;
    const scalingStrategy = config.positionScaling || 'confidence';
    
    switch (scalingStrategy) {
      case 'fixed':
        // No scaling — use base size as-is
        scalingMultiplier = 1.0;
        break;
      case 'kelly':
        // Use Kelly criterion if enough historical data, fallback to confidence
        if (config.kellyFraction) {
          scalingMultiplier = config.kellyFraction;
        } else {
          // Fall back to confidence-based scaling
          scalingMultiplier = 1.0 + (confidence - 75) / 100;
        }
        break;
      case 'confidence':
      default:
        // Scale position by how confident the signal is
        // confidence=50 → multiplier=0.75, confidence=75 → 1.0, confidence=100 → 1.25
        scalingMultiplier = 1.0 + (confidence - 75) / 100;
        break;
    }

    // Clamp scaling multiplier to prevent extreme values
    const clippedMultiplier = Math.max(0.5, Math.min(1.5, scalingMultiplier));

    let finalPct = baseSize * clippedMultiplier;
    
    // Apply hard cap from maxPositionPct (default 100% = no cap)
    const maxPct = config.maxPositionPct || 1.0;
    finalPct = Math.min(finalPct, maxPct);
    
    const amountInCurrency = balance * finalPct;

    const leverage = config.leverage || 1;
    const positionSize = (amountInCurrency * leverage) / entryPrice;

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
      const reason = `Max drawdown reached: ${(currentDrawdown * 100).toFixed(2)}% >= ${(config.maxDrawdown * 100).toFixed(2)}%`;
      this.logSystemEvent('circuit_breaker', reason, { riskMode, balance, initialBalance, currentDrawdown, maxDrawdown: config.maxDrawdown });
      return reason;
    }

    if (dailyLoss >= initialBalance * (config.maxDailyLoss || 0.05)) {
      const reason = `Max daily loss reached: $${dailyLoss.toFixed(2)} (Limit: ${(config.maxDailyLoss * 100).toFixed(1)}%)`;
      this.logSystemEvent('circuit_breaker', reason, { riskMode, dailyLoss, maxDailyLoss: config.maxDailyLoss, initialBalance });
      return reason;
    }

    // MD Part 5.3: Consecutive Losses - track and reduce position size
    const currentLosses = consecutiveLosses > 0 ? consecutiveLosses : (this.consecutiveLosses[riskMode] || 0);
    if (currentLosses >= 5) {
      const reason = currentLosses >= 7
        ? `Extreme consecutive losses: ${currentLosses}. Position size reduced to 25%`
        : `High consecutive losses: ${currentLosses}. Position size reduced to 50%`;
      this.logSystemEvent('circuit_breaker', reason, { riskMode, consecutiveLosses: currentLosses });
      return reason;
    }

    // MD Part 5.3: Volatility Spike
    if (avgAtr > 0 && currentAtr > avgAtr * 3) {
      const reason = `Volatility spike detected: ATR ${currentAtr.toFixed(2)} > 3x Avg (${avgAtr.toFixed(2)})`;
      this.logSystemEvent('circuit_breaker', reason, { riskMode, currentAtr, avgAtr });
      return reason;
    }

    return null;
  }
}
