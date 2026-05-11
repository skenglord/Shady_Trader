import { Decimal } from 'decimal.js';
import {
  CostEstimator as ICostEstimator,
  OrderRequest,
  TotalCostEstimate,
  FeeBreakdown,
  NetworkCostEstimate
} from './types.js';
import { SlippageEngine } from './engine.js';
import { logger } from '../logging/logger.js';

export class CostEstimator implements ICostEstimator {
  private slippageEngine: SlippageEngine;
  private feeCache = new Map<string, { fees: FeeBreakdown; timestamp: number }>();
  private cacheTimeout = 3600000; // 1 hour

  constructor(slippageEngine: SlippageEngine) {
    this.slippageEngine = slippageEngine;
    logger.info('CostEstimator initialized', { service: 'CostEstimator' });
  }

  async estimateTotalCost(order: OrderRequest): Promise<TotalCostEstimate> {
    const [slippage, fees, networkCosts] = await Promise.all([
      this.slippageEngine.estimateSlippage(order),
      this.getFees(order),
      this.estimateNetworkCosts(order)
    ]);

    const total = slippage.totalSlippage.plus(fees.total).plus(networkCosts.total);

    return {
      total,
      breakdown: { slippage, fees, networkCosts },
      confidence: Math.min(slippage.confidence, fees.confidence, networkCosts.confidence)
    };
  }

  private async getFees(order: OrderRequest): Promise<FeeBreakdown> {
    const cacheKey = `${order.symbol}_${order.type}`;
    const cached = this.feeCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
      return cached.fees;
    }

    // TODO: Integrate with ccxt for real exchange fees
    const fees = this.getMockFees(order);
    this.feeCache.set(cacheKey, { fees, timestamp: Date.now() });

    return fees;
  }

  private getMockFees(order: OrderRequest): FeeBreakdown {
    // Mock fee structure - would be replaced with real exchange data
    const isMaker = order.type === 'limit' && order.limitPrice !== undefined;

    let makerFee: Decimal;
    let takerFee: Decimal;

    if (order.symbol.includes('BTC')) {
      makerFee = new Decimal('0.001'); // 0.1%
      takerFee = new Decimal('0.002'); // 0.2%
    } else {
      makerFee = new Decimal('0.002'); // 0.2%
      takerFee = new Decimal('0.004'); // 0.4%
    }

    const fee = isMaker ? makerFee : takerFee;
    const total = fee.mul(order.size);

    return {
      makerFee,
      takerFee,
      total,
      confidence: 0.9
    };
  }

  private async estimateNetworkCosts(order: OrderRequest): Promise<NetworkCostEstimate> {
    // For crypto trading, network costs are minimal
    // This would be more relevant for on-chain operations

    const gasCost = new Decimal(0);
    const priorityFee = new Decimal(0);
    const total = gasCost.plus(priorityFee);

    return {
      gasCost,
      priorityFee,
      total,
      confidence: 1.0
    };
  }

  // Pre-trade cost check for trading engine
  async shouldExecuteTrade(order: OrderRequest, maxCostThreshold: Decimal): Promise<boolean> {
    try {
      const costEstimate = await this.estimateTotalCost(order);

      logger.info('Cost estimate for order', {
        service: 'CostEstimator',
        symbol: order.symbol,
        side: order.side,
        size: order.size.toString(),
        estimatedTotalCost: costEstimate.total.toString(),
        confidence: costEstimate.confidence,
        threshold: maxCostThreshold.toString()
      });

      return costEstimate.total.lte(maxCostThreshold) && costEstimate.confidence > 0.5;
    } catch (error) {
      logger.error('Failed to estimate cost for trade check', {
        service: 'CostEstimator',
        error: error.message,
        symbol: order.symbol
      });

      // Fail closed - reject trade if cost estimation fails
      return false;
    }
  }

  // Method to update fee cache (called by background job)
  updateFees(symbol: string, exchange: string, makerFee: number, takerFee: number): void {
    const feeBreakdown: FeeBreakdown = {
      makerFee: new Decimal(makerFee),
      takerFee: new Decimal(takerFee),
      total: new Decimal(0), // Will be calculated per order
      confidence: 0.95
    };

    this.feeCache.set(`${symbol}_limit`, { fees: feeBreakdown, timestamp: Date.now() });
    this.feeCache.set(`${symbol}_market`, { fees: feeBreakdown, timestamp: Date.now() });

    logger.info('Updated fee cache', {
      service: 'CostEstimator',
      symbol,
      exchange,
      makerFee,
      takerFee
    });
  }
}