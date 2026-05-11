import { Decimal } from 'decimal.js';

export interface OrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  size: Decimal;
  type: 'market' | 'limit';
  limitPrice?: Decimal;
  timeInForce: 'GTC' | 'IOC' | 'FOK';
}

export interface MarketState {
  timestamp: number;
  midPrice: Decimal;
  spread: Decimal;
  volatility: number;
  depth: LiquidityDepth;
  regime: TradingRegime;
}

export interface LiquidityDepth {
  bidVolume: Decimal;
  askVolume: Decimal;
  bidLevels: number;
  askLevels: number;
  totalDepth: Decimal;
  vpin: number;
}

export interface SlippageEstimate {
  totalSlippage: Decimal;
  confidence: number;
  breakdown: {
    permanentImpact: Decimal;
    temporaryImpact: Decimal;
    spreadCost: Decimal;
  };
  horizon: TimeHorizon;
  flags?: string[];
}

export interface TotalCostEstimate {
  total: Decimal;
  breakdown: {
    slippage: SlippageEstimate;
    fees: FeeBreakdown;
    networkCosts: NetworkCostEstimate;
  };
  confidence: number;
}

export interface FeeBreakdown {
  makerFee: Decimal;
  takerFee: Decimal;
  total: Decimal;
  confidence: number;
}

export interface NetworkCostEstimate {
  gasCost: Decimal;
  priorityFee: Decimal;
  total: Decimal;
  confidence: number;
}

export interface LiquidityProfile {
  effectiveDepth: Decimal;
  resiliencyScore: number;
  slippageProfile: SlippageProfile[];
  tier: LiquidityTier;
}

export interface SlippageProfile {
  size: Decimal;
  expectedSlippage: Decimal;
  confidence: number;
}

export interface ExecutionSimulation {
  scenario: ExecutionScenario;
  expectedSlippage: number;
  worstCaseSlippage: number;
  executionTime: number;
}

export interface OrderBookSnapshot {
  id?: number;
  symbol: string;
  timestamp: number;
  bids: Array<[price: Decimal, size: Decimal, orderCount: number]>;
  asks: Array<[price: Decimal, size: Decimal, orderCount: number]>;
  spread: Decimal;
  midPrice: Decimal;
  totalBidDepth: Decimal;
  totalAskDepth: Decimal;
  updateId: number;
  exchange: string;
}

export interface SlippageRecord {
  id?: number;
  symbol: string;
  timestamp: number;
  side: 'buy' | 'sell';
  orderSize: number;
  orderType: 'market' | 'limit';
  predictedSlippage: number;
  realizedSlippage?: number;
  confidence: number;
  regime: string;
  volatility: number;
  marketImpact: number;
  spreadCost: number;
  temporaryImpact: number;
  exchange: string;
  metadata?: any;
}

export interface ToxicityMetrics {
  id?: number;
  symbol: string;
  timestamp: number;
  vpin: number;
  orderImbalance: number;
  largeTradeRatio: number;
  spreadVolatility: number;
  depthVolatility: number;
  exchange: string;
}

export interface NormalizedMarketData {
  timestamp: number;
  midPrice: Decimal;
  spread: Decimal;
  depth: {
    bidDepth: Decimal;
    askDepth: Decimal;
    totalDepth: Decimal;
  };
  volatility: {
    realized: number;
    implied: number;
  };
  toxicity: {
    vpin: number;
    orderImbalance: number;
  };
}

export type TradingRegime = 'high_liquidity' | 'normal' | 'low_liquidity' | 'volatile' | 'uncertain';

export type LiquidityTier = 'high' | 'medium' | 'low';

export type TimeHorizon = 'immediate' | 'seconds' | 'minutes';

export type ExecutionScenario = 'best_case' | 'worst_case' | 'expected';

export interface CircuitBreakerThresholds {
  absoluteThreshold: Decimal;
  confidenceThreshold: number;
  spreadWideningThreshold: number;
  toxicityThreshold: number;
  liquidityVoidThreshold: number;
}

export interface CircuitBreakerAction {
  action: 'proceed' | 'reject' | 'delay' | 'scale_down';
  reason: string;
  delayMs?: number;
  scaleFactor?: number;
}

export class SlippageCircuitBreaker {
  private thresholds: CircuitBreakerThresholds;
  private lastTriggerTime = 0;
  private consecutiveTriggers = 0;

  constructor(thresholds: CircuitBreakerThresholds) {
    this.thresholds = thresholds;
  }

  evaluateBreaker(
    estimate: TotalCostEstimate,
    marketState: MarketState
  ): CircuitBreakerAction {
    // Check absolute slippage threshold
    if (estimate.total.gte(this.thresholds.absoluteThreshold)) {
      this.recordTrigger();
      return { action: 'reject', reason: 'excessive_slippage' };
    }

    // Check confidence threshold
    if (estimate.confidence < this.thresholds.confidenceThreshold) {
      this.recordTrigger();
      return { action: 'delay', reason: 'low_confidence', delayMs: 1000 };
    }

    // Check for flash crash conditions
    if (this.detectVolatilitySpike(marketState)) {
      this.recordTrigger();
      return { action: 'scale_down', reason: 'volatility_spike', scaleFactor: 0.5 };
    }

    // Check spread widening
    const spreadRatio = Number(marketState.spread) / 0.0001; // Compare to normal spread
    if (spreadRatio > this.thresholds.spreadWideningThreshold) {
      this.recordTrigger();
      return { action: 'delay', reason: 'spread_widening', delayMs: 2000 };
    }

    // Check liquidity void
    if (Number(marketState.depth.totalDepth) < this.thresholds.liquidityVoidThreshold) {
      this.recordTrigger();
      return { action: 'reject', reason: 'liquidity_void' };
    }

    // Reset consecutive triggers on successful evaluation
    this.consecutiveTriggers = 0;

    return { action: 'proceed', reason: 'all_checks_passed' };
  }

  private recordTrigger(): void {
    this.lastTriggerTime = Date.now();
    this.consecutiveTriggers++;
  }

  private detectVolatilitySpike(marketState: MarketState): boolean {
    // Simplified volatility spike detection
    return marketState.volatility > 0.1; // 10% volatility threshold
  }

  getStatus(): { consecutiveTriggers: number; lastTriggerTime: number } {
    return {
      consecutiveTriggers: this.consecutiveTriggers,
      lastTriggerTime: this.lastTriggerTime
    };
  }
}

export interface CostEstimator {
  estimateTotalCost(order: OrderRequest): Promise<TotalCostEstimate>;
}

export interface SlippageEngine {
  estimateSlippage(order: OrderRequest): Promise<SlippageEstimate>;
}

export interface ImpactSimulator {
  simulateImpact(order: OrderRequest, marketState: MarketState): Promise<SlippageEstimate>;
}

export interface LiquidityAnalyzer {
  analyzeLiquidity(symbol: string, timestamp: number): Promise<LiquidityProfile>;
}

export interface AlmgrenChrissParams {
  gamma: number; // Impact coefficient
  lambda: number; // Temporary impact intensity
  kappa: number; // Decay rate
  alpha: number; // Adverse selection coefficient
  rho: number; // Temporal decay parameter
}