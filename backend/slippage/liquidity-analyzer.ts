import { Decimal } from 'decimal.js';
import {
  LiquidityAnalyzer as ILiquidityAnalyzer,
  OrderBookSnapshot,
  LiquidityProfile,
  SlippageProfile,
  LiquidityTier,
  OrderRequest
} from './types.js';
import { logger } from '../logging/logger.js';

export class LiquidityAnalyzer implements ILiquidityAnalyzer {
  private orderBookCache = new Map<string, OrderBookSnapshot>();
  private cacheTimeout = 100; // 100ms cache timeout
  private exchangeConnector: any; // Would be injected

  constructor(exchangeConnector?: any) {
    this.exchangeConnector = exchangeConnector;
    logger.info('LiquidityAnalyzer initialized', { service: 'LiquidityAnalyzer' });
  }

  async analyzeDepth(
    symbol: string,
    orderSize: Decimal,
    side: 'buy' | 'sell'
  ): Promise<LiquidityProfile> {
    const book = await this.getLatestBook(symbol);
    if (!book) {
      logger.warn('No order book data available', { service: 'LiquidityAnalyzer', symbol });
      return this.getDefaultProfile(orderSize);
    }

    const effectiveDepth = this.calculateEffectiveDepth(book, orderSize, side);
    const resiliency = this.measureResiliency(book, orderSize);
    const slippageProfile = this.generateSlippageProfile(book, orderSize);
    const tier = this.classifyLiquidityTier(effectiveDepth, resiliency);

    return {
      effectiveDepth,
      resiliencyScore: resiliency,
      slippageProfile,
      tier
    };
  }

  private async getLatestBook(symbol: string): Promise<OrderBookSnapshot | null> {
    const cached = this.orderBookCache.get(symbol);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
      return cached;
    }

    if (this.exchangeConnector) {
      try {
        const orderBookData = await this.exchangeConnector.getOrderBook(symbol);
        const snapshot = this.convertToSnapshot(orderBookData);
        this.orderBookCache.set(symbol, snapshot);
        return snapshot;
      } catch (error) {
        logger.warn('Failed to fetch order book from exchange', {
          service: 'LiquidityAnalyzer',
          symbol,
          error: error.message
        });
      }
    }

    // Fallback to mock data
    return this.getMockOrderBook(symbol);
  }

  private calculateEffectiveDepth(
    book: OrderBookSnapshot,
    orderSize: Decimal,
    side: 'buy' | 'sell'
  ): Decimal {
    const levels = side === 'buy' ? book.asks : book.bids;
    let cumulativeSize = new Decimal(0);
    let cumulativeVolume = new Decimal(0);

    for (const [price, size] of levels) {
      const remainingSize = orderSize.minus(cumulativeVolume);
      if (remainingSize.lte(0)) break;

      const fillSize = Decimal.min(remainingSize, size);
      cumulativeVolume = cumulativeVolume.plus(fillSize);
      cumulativeSize = cumulativeSize.plus(fillSize.mul(price));
    }

    return cumulativeVolume.div(orderSize).mul(100); // Percentage of order that can be filled
  }

  private measureResiliency(book: OrderBookSnapshot, orderSize: Decimal): number {
    // Resiliency = time to fill order at current depth
    const avgSpread = Number(book.spread);
    const totalDepth = Number(book.totalBidDepth.plus(book.totalAskDepth));
    const relativeSize = Number(orderSize) / totalDepth;

    // Simple resiliency metric: inverse of relative size (higher = more resilient)
    const resiliency = Math.min(1 / relativeSize, 10);

    // Factor in spread stability (placeholder)
    const spreadFactor = Math.max(0, 1 - avgSpread / 0.01); // Penalize wide spreads

    return resiliency * spreadFactor;
  }

  private generateSlippageProfile(
    book: OrderBookSnapshot,
    orderSize: Decimal
  ): SlippageProfile[] {
    const sizes = [0.1, 0.25, 0.5, 1.0, 2.0]; // Percentage of order size
    const profile: SlippageProfile[] = [];

    for (const sizePct of sizes) {
      const testSize = orderSize.mul(sizePct);
      const slippage = this.calculateSlippageForSize(book, testSize);

      profile.push({
        size: testSize,
        expectedSlippage: slippage,
        confidence: 0.8 // Placeholder
      });
    }

    return profile;
  }

  private calculateSlippageForSize(book: OrderBookSnapshot, size: Decimal): Decimal {
    // Simplified slippage calculation based on order book shape
    const midPrice = book.midPrice;
    let cumulativeVolume = new Decimal(0);
    let weightedPrice = new Decimal(0);

    // Use bid side for buy orders, ask side for sell orders
    const levels = book.asks; // Simplified - would depend on side

    for (const [price, levelSize] of levels) {
      const remainingSize = size.minus(cumulativeVolume);
      if (remainingSize.lte(0)) break;

      const fillSize = Decimal.min(remainingSize, levelSize);
      weightedPrice = weightedPrice.plus(fillSize.mul(price));
      cumulativeVolume = cumulativeVolume.plus(fillSize);
    }

    if (cumulativeVolume.gt(0)) {
      const avgExecutionPrice = weightedPrice.div(cumulativeVolume);
      return avgExecutionPrice.minus(midPrice).abs().div(midPrice);
    }

    return new Decimal(0.01); // Default 1% slippage if no depth
  }

  private classifyLiquidityTier(effectiveDepth: Decimal, resiliency: number): LiquidityTier {
    const depthScore = Number(effectiveDepth);

    if (depthScore > 80 && resiliency > 5) return 'high';
    if (depthScore > 50 && resiliency > 2) return 'medium';
    return 'low';
  }

  private getDefaultProfile(orderSize: Decimal): LiquidityProfile {
    return {
      effectiveDepth: new Decimal(50),
      resiliencyScore: 2,
      slippageProfile: [{
        size: orderSize,
        expectedSlippage: new Decimal(0.005),
        confidence: 0.3
      }],
      tier: 'low'
    };
  }

  private getMockOrderBook(symbol: string): OrderBookSnapshot {
    // Mock order book for development
    const midPrice = new Decimal(50000);
    const spread = new Decimal(1);

    const bids: Array<[Decimal, Decimal, number]> = [];
    const asks: Array<[Decimal, Decimal, number]> = [];

    // Generate 10 levels
    for (let i = 0; i < 10; i++) {
      const bidPrice = midPrice.minus(spread.mul(i + 1));
      const askPrice = midPrice.plus(spread.mul(i + 1));
      const size = new Decimal(1 + Math.random() * 5);

      bids.push([bidPrice, size, 1]);
      asks.push([askPrice, size, 1]);
    }

    return {
      symbol,
      timestamp: Date.now(),
      bids,
      asks,
      spread,
      midPrice,
      totalBidDepth: new Decimal(50),
      totalAskDepth: new Decimal(50),
      updateId: Date.now(),
      exchange: 'mock'
    };
  }

  private convertToSnapshot(orderBookData: any): OrderBookSnapshot {
    const bids: Array<[Decimal, Decimal, number]> = orderBookData.bids.map(
      ([price, size]: [number, number]) => [new Decimal(price), new Decimal(size), 1]
    );

    const asks: Array<[Decimal, Decimal, number]> = orderBookData.asks.map(
      ([price, size]: [number, number]) => [new Decimal(price), new Decimal(size), 1]
    );

    const bestBid = bids[0]?.[0] || new Decimal(0);
    const bestAsk = asks[0]?.[0] || new Decimal(0);
    const spread = bestAsk.minus(bestBid);
    const midPrice = bestBid.plus(bestAsk).div(2);

    const totalBidDepth = bids.reduce((sum, [, size]) => sum.plus(size), new Decimal(0));
    const totalAskDepth = asks.reduce((sum, [, size]) => sum.plus(size), new Decimal(0));

    return {
      symbol: orderBookData.symbol,
      timestamp: orderBookData.timestamp,
      bids,
      asks,
      spread,
      midPrice,
      totalBidDepth,
      totalAskDepth,
      updateId: Date.now(), // Simplified
      exchange: orderBookData.exchange
    };
  }

  // Method to update order book cache (called by ExchangeConnector)
  updateOrderBook(snapshot: OrderBookSnapshot): void {
    this.orderBookCache.set(snapshot.symbol, snapshot);
  }
}