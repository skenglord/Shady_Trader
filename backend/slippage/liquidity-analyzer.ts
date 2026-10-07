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

  async analyzeLiquidity(symbol: string, timestamp: number): Promise<any> {
    const book = await this.getLatestBook(symbol);
    if (!book) throw new Error(`No live order book available for ${symbol}`);
    const profile = await this.analyzeDepth(symbol, new Decimal(1), 'buy');
    return { ...profile, timestamp: book.timestamp, symbol };
  }

  async analyzeDepth(
    symbol: string,
    orderSize: Decimal,
    side: 'buy' | 'sell'
  ): Promise<LiquidityProfile> {
    const book = await this.getLatestBook(symbol);
    if (!book) {
      logger.warn('No order book data available', { service: 'LiquidityAnalyzer', symbol });
      throw new Error(`No live order book available for ${symbol}`);
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

    const connector = typeof this.exchangeConnector === 'function' ? this.exchangeConnector() : this.exchangeConnector;
    if (connector) {
      try {
        const orderBookData = await connector.getOrderBook(symbol);
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

    return null;
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
    const relativeSpread = avgSpread / Math.max(Number(book.midPrice), Number.EPSILON);
    const spreadFactor = Math.max(0, 1 - relativeSpread);

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
        confidence: Math.max(0, 1 - (Date.now() - book.timestamp) / 15_000)
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

    if (cumulativeVolume.gte(size)) {
      const avgExecutionPrice = weightedPrice.div(cumulativeVolume);
      return avgExecutionPrice.minus(midPrice).abs().div(midPrice);
    }

    throw new Error('Insufficient live order book depth to estimate slippage');
  }

  private classifyLiquidityTier(effectiveDepth: Decimal, resiliency: number): LiquidityTier {
    const depthScore = Number(effectiveDepth);

    if (depthScore > 80 && resiliency > 5) return 'high';
    if (depthScore > 50 && resiliency > 2) return 'medium';
    return 'low';
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
