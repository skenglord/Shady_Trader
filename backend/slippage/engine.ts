import { Decimal } from 'decimal.js';
import { OrderRequest, SlippageEngine as ISlippageEngine, SlippageEstimate, TimeHorizon } from './types.js';
import { logger } from '../logging/logger.js';

type LiveBookProvider = () => {
  getOrderBook(symbol: string, limit?: number): Promise<{
    timestamp: number;
    bids: [number, number][];
    asks: [number, number][];
  }> | null;
};

export class SlippageEngine implements ISlippageEngine {
  constructor(private readonly getExchange?: LiveBookProvider) {
    logger.info('SlippageEngine initialized', { service: 'SlippageEngine' });
  }

  async estimateSlippage(order: OrderRequest, horizon: TimeHorizon = 'immediate'): Promise<SlippageEstimate> {
    const exchange = this.getExchange?.();
    if (!exchange) throw new Error('Live exchange depth is unavailable for slippage estimation');
    const book = await exchange.getOrderBook(order.symbol, 50);
    if (!book || Date.now() - book.timestamp > 15_000) throw new Error(`No fresh live order book for ${order.symbol}`);

    const bids = book.bids.filter(([price, qty]) => Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0);
    const asks = book.asks.filter(([price, qty]) => Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0);
    if (!bids.length || !asks.length || bids[0][0] >= asks[0][0]) throw new Error(`Invalid live order book for ${order.symbol}`);
    const mid = (bids[0][0] + asks[0][0]) / 2;
    const levels = order.side === 'buy' ? asks : bids;
    let remaining = order.size.toNumber();
    let quoteValue = 0;
    for (const [price, quantity] of levels) {
      const fill = Math.min(remaining, quantity);
      quoteValue += fill * price;
      remaining -= fill;
      if (remaining <= 0) break;
    }
    if (remaining > Math.max(1e-12, order.size.toNumber() * 1e-9)) {
      throw new Error(`Live order book depth is insufficient for ${order.size.toString()} ${order.symbol}`);
    }

    const averageExecutionPrice = quoteValue / order.size.toNumber();
    const bookImpact = Math.abs(averageExecutionPrice - mid) / mid;
    const spreadCost = ((asks[0][0] - bids[0][0]) / 2) / mid;
    const impact = new Decimal(bookImpact);
    const spread = new Decimal(spreadCost);
    return {
      totalSlippage: impact.plus(spread),
      confidence: Math.max(0, 1 - (Date.now() - book.timestamp) / 15_000),
      breakdown: {
        permanentImpact: impact.mul(0.6),
        temporaryImpact: impact.mul(0.4),
        spreadCost: spread,
      },
      horizon,
    };
  }
}
