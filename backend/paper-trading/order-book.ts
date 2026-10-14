import { Decimal } from 'decimal.js';
import { randomUUID } from 'crypto';

export interface OrderBookLevel {
  price: Decimal;
  quantity: Decimal;
}

export interface OrderBookSnapshot {
  symbol: string;
  timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midPrice: Decimal;
  spread: Decimal;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  quantity: Decimal;
  price?: Decimal;
  timeInForce: 'GTC' | 'IOC' | 'FOK';
  timestamp: number;
  status: 'pending' | 'partially_filled' | 'filled' | 'cancelled' | 'expired';
  filledQuantity?: Decimal;
  fillPrice?: Decimal;
  fillTimestamp?: number;
}

export class OrderBookSimulator {
  private orderBooks: Map<string, {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    lastUpdateTime: number;
  }> = new Map();

  private pendingOrders: Map<string, PaperOrder> = new Map();
  private readonly MAX_LEVELS = 10;

  constructor() {}

  public restoreOrders(orders: PaperOrder[]): void {
    this.pendingOrders = new Map(orders.map(order => [order.id, order]));
  }

  public snapshotBooks() {
    return new Map([...this.orderBooks].map(([symbol, book]) => [symbol, {
      ...book, bids: book.bids.map(level => ({ ...level })), asks: book.asks.map(level => ({ ...level })),
    }]));
  }

  public restoreBooks(books: ReturnType<OrderBookSimulator['snapshotBooks']>): void {
    this.orderBooks = books;
  }

  public updateOrderBook(snapshot: { symbol: string; timestamp: number; bids: [number, number][]; asks: [number, number][] }): boolean {
    const toLevels = (rows: [number, number][]) => rows.slice(0, this.MAX_LEVELS).map(([price, quantity]) => {
      if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) throw new Error('Invalid live order book level');
      return { price: new Decimal(price), quantity: new Decimal(quantity) };
    });
    if (!Number.isFinite(snapshot.timestamp) || snapshot.timestamp > Date.now() + 1_000) throw new Error('Invalid live order book timestamp');
    const existing = this.orderBooks.get(snapshot.symbol);
    if (existing && snapshot.timestamp <= existing.lastUpdateTime) return false;
    const bids = toLevels(snapshot.bids).sort((a, b) => b.price.comparedTo(a.price));
    const asks = toLevels(snapshot.asks).sort((a, b) => a.price.comparedTo(b.price));
    if (!bids.length || !asks.length || bids[0].price.gte(asks[0].price)) throw new Error('Live order book is empty or crossed');
    this.orderBooks.set(snapshot.symbol, { bids, asks, lastUpdateTime: snapshot.timestamp });
    return true;
  }

  public getOrderBook(symbol: string): OrderBookSnapshot | null {
    const orderBook = this.orderBooks.get(symbol);
    if (!orderBook || Date.now() - orderBook.lastUpdateTime > 15_000) {
      return null;
    }

    const bestBid = orderBook.bids[0]?.price || new Decimal(0);
    const bestAsk = orderBook.asks[0]?.price || new Decimal(0);
    const midPrice = bestBid.add(bestAsk).div(2);
    const spread = bestAsk.minus(bestBid);

    return {
      symbol,
      timestamp: orderBook.lastUpdateTime,
      bids: orderBook.bids.map(level => ({ ...level })),
      asks: orderBook.asks.map(level => ({ ...level })),
      midPrice,
      spread,
    };
  }

  public getTopLevels(symbol: string, levels: number = 10): {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  } | null {
    const orderBook = this.orderBooks.get(symbol);
    if (!orderBook || Date.now() - orderBook.lastUpdateTime > 15_000) {
      return null;
    }

    return {
      bids: orderBook.bids.slice(0, levels),
      asks: orderBook.asks.slice(0, levels),
    };
  }

  public addPaperOrder(order: PaperOrder): string {
    order.id = order.id || randomUUID();
    order.timestamp = Date.now();
    order.status = 'pending';
    this.pendingOrders.set(order.id, order);
    return order.id;
  }

  public cancelPaperOrder(orderId: string): boolean {
    const order = this.pendingOrders.get(orderId);
    if (order && (order.status === 'pending' || order.status === 'partially_filled')) {
      order.status = 'cancelled';
      return true;
    }
    return false;
  }

  public getPaperOrder(orderId: string): PaperOrder | undefined {
    return this.pendingOrders.get(orderId);
  }

  public getOrders(): PaperOrder[] {
    return Array.from(this.pendingOrders.values());
  }

  public matchOrders(symbol: string, slippageModel?: SlippageModel): {
    filledOrders: PaperOrder[];
    remainingOrders: PaperOrder[];
  } {
    const orderBook = this.orderBooks.get(symbol);
    if (!orderBook || Date.now() - orderBook.lastUpdateTime > 15_000) {
      return { filledOrders: [], remainingOrders: [] };
    }
    const filledOrders: PaperOrder[] = [];
    const remainingOrders: PaperOrder[] = [];
    for (const order of this.pendingOrders.values()) {
      if (order.symbol !== symbol || !['pending', 'partially_filled'].includes(order.status)) continue;
      const levels = (order.side === 'buy' ? orderBook.asks : orderBook.bids).filter(level =>
        level.quantity.gt(0) && (order.type === 'market' || (order.price &&
          (order.side === 'buy' ? level.price.lte(order.price) : level.price.gte(order.price)))));
      let remaining = order.quantity.minus(order.filledQuantity || 0);
      if (order.timeInForce === 'FOK' && levels.reduce((sum, level) => sum.add(level.quantity), new Decimal(0)).lt(remaining)) {
        order.status = 'cancelled';
        continue;
      }
      let filled = new Decimal(0);
      let cost = new Decimal(0);
      for (const level of levels) {
        if (remaining.lte(0)) break;
        const quantity = Decimal.min(remaining, level.quantity);
        const price = slippageModel && order.type === 'market'
          ? this.applySlippage(level.price, order.side, slippageModel) : level.price;
        cost = cost.add(quantity.mul(price));
        filled = filled.add(quantity);
        remaining = remaining.minus(quantity);
        level.quantity = level.quantity.minus(quantity);
      }
      if (filled.gt(0)) {
        const previous = order.filledQuantity || new Decimal(0);
        const totalCost = previous.mul(order.fillPrice || 0).add(cost);
        order.filledQuantity = previous.add(filled);
        order.fillPrice = totalCost.div(order.filledQuantity);
        order.fillTimestamp = Date.now();
        order.status = remaining.isZero() ? 'filled' : 'partially_filled';
        filledOrders.push(order);
      }
      // Market orders cannot rest without a price; cancel any unfilled remainder.
      if (remaining.gt(0) && (order.timeInForce !== 'GTC' || order.type === 'market')) order.status = 'cancelled';
      if (order.status === 'pending' || order.status === 'partially_filled') remainingOrders.push(order);
    }
    return { filledOrders, remainingOrders };
  }

  private applySlippage(price: Decimal, side: 'buy' | 'sell', slippageModel: SlippageModel): Decimal {
    const slippageFactor = new Decimal(1 + slippageModel.slippagePercent / 100);
    return side === 'buy' 
      ? price.mul(slippageFactor)
      : price.div(slippageFactor);
  }
}

export interface SlippageModel {
  slippagePercent: number;
  volatilityImpact: number;
  liquidityImpact: number;
}
