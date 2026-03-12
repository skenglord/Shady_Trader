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
    maxRiskPerTrade: 0.005, // 0.5%
    maxDrawdown: 0.05, // 5%
    confidenceThreshold: 85,
    maxConcurrentPositions: 1,
    tpMultiplier: 1.5,
    slMultiplier: 0.5,
    leverage: 1,
    description: "Maximum safety. Only takes the highest confidence signals with very tight stops and small positions. Ideal for capital preservation."
  },
  [RiskMode.CONSERVATIVE]: {
    maxRiskPerTrade: 0.01, // 1%
    maxDrawdown: 0.08, // 8%
    confidenceThreshold: 80,
    maxConcurrentPositions: 2,
    tpMultiplier: 2.0,
    slMultiplier: 1.0,
    leverage: 2,
    description: "Balanced safety. Takes high-probability setups with standard risk-reward ratios. Good for steady, low-volatility growth."
  },
  [RiskMode.MODERATE]: {
    maxRiskPerTrade: 0.02, // 2%
    maxDrawdown: 0.12, // 12%
    confidenceThreshold: 75,
    maxConcurrentPositions: 3,
    tpMultiplier: 2.5,
    slMultiplier: 1.5,
    leverage: 5,
    description: "Standard trading. Optimized for the best balance between risk and return. Uses wider stops to allow trades room to breathe."
  },
  [RiskMode.AGGRESSIVE]: {
    maxRiskPerTrade: 0.05, // 5%
    maxDrawdown: 0.18, // 18%
    confidenceThreshold: 70,
    maxConcurrentPositions: 5,
    tpMultiplier: 3.0,
    slMultiplier: 2.0,
    leverage: 20,
    description: "High growth. Willing to take more frequent signals and larger drawdowns for higher potential returns. Requires strong trends."
  },
  [RiskMode.DEGEN]: {
    maxRiskPerTrade: 0.10, // 10%
    maxDrawdown: 0.30, // 30%
    confidenceThreshold: 60,
    maxConcurrentPositions: 10,
    tpMultiplier: 5.0,
    slMultiplier: 3.0,
    leverage: 100,
    description: "Maximum risk. Takes almost every signal with large positions and very wide targets. High probability of significant drawdown."
  },
  [RiskMode.AI_ENHANCED]: {
    maxRiskPerTrade: 0.02, // 2%
    maxDrawdown: 0.12, // 12%
    confidenceThreshold: 75,
    maxConcurrentPositions: 3,
    tpMultiplier: 2.5,
    slMultiplier: 1.5,
    leverage: 5,
    description: "AI Enhanced. Uses Gemini for macro-level signal confirmation and sentiment analysis before taking a trade. Matches Moderate risk profile."
  }
};

export class RiskManager {
  RISK_CONFIGS: Record<string, any>;

  constructor() {
    this.RISK_CONFIGS = JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIGS));
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

  calculatePositionSize(balance: number, entryPrice: number, stopLoss: number, riskMode: RiskMode): number {
    const config = this.RISK_CONFIGS[riskMode];
    const riskAmount = balance * config.maxRiskPerTrade;
    
    const riskPerUnit = Math.abs(entryPrice - stopLoss);
    if (riskPerUnit === 0) return 0;

    const riskBasedSize = riskAmount / riskPerUnit;
    const leverage = config.leverage || 1;
    const maxLeveragedSize = (balance * leverage) / entryPrice;
    
    return Math.min(riskBasedSize, maxLeveragedSize);
  }

  validateTrade(signal: any, riskMode: RiskMode, currentPositions: number): boolean {
    const config = this.RISK_CONFIGS[riskMode];

    if (signal.confidence < config.confidenceThreshold) return false;
    if (currentPositions >= config.maxConcurrentPositions) return false;

    return true;
  }

  checkCircuitBreakers(balance: number, initialBalance: number, dailyLoss: number, riskMode: RiskMode): string | null {
    const config = this.RISK_CONFIGS[riskMode];
    
    const currentDrawdown = (initialBalance - balance) / initialBalance;
    if (currentDrawdown >= config.maxDrawdown) {
      return `Max drawdown reached: ${(currentDrawdown * 100).toFixed(2)}% >= ${(config.maxDrawdown * 100).toFixed(2)}%`;
    }

    if (dailyLoss >= balance * config.maxRiskPerTrade * 3) {
      return `Max daily loss reached: $${dailyLoss.toFixed(2)}`;
    }

    return null;
  }
}
