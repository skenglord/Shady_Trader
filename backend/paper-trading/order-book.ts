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
  status: 'pending' | 'filled' | 'cancelled' | 'expired';
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

  public updateOrderBook(snapshot: { symbol: string; timestamp: number; bids: [number, number][]; asks: [number, number][] }): void {
    const toLevels = (rows: [number, number][]) => rows.slice(0, this.MAX_LEVELS).map(([price, quantity]) => {
      if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) throw new Error('Invalid live order book level');
      return { price: new Decimal(price), quantity: new Decimal(quantity) };
    });
    const bids = toLevels(snapshot.bids), asks = toLevels(snapshot.asks);
    if (!bids.length || !asks.length || bids[0].price.gte(asks[0].price)) throw new Error('Live order book is empty or crossed');
    this.orderBooks.set(snapshot.symbol, { bids, asks, lastUpdateTime: snapshot.timestamp });
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
      bids: [...orderBook.bids],
      asks: [...orderBook.asks],
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
    if (order && order.status === 'pending') {
      order.status = 'cancelled';
      return true;
    }
    return false;
  }

  public getPaperOrder(orderId: string): PaperOrder | undefined {
    return this.pendingOrders.get(orderId);
  }

  public matchOrders(symbol: string, slippageModel?: SlippageModel): {
    filledOrders: PaperOrder[];
    remainingOrders: PaperOrder[];
  } {
    const orderBook = this.orderBooks.get(symbol);
    if (!orderBook) {
      return { filledOrders: [], remainingOrders: [] };
    }

    const filledOrders: PaperOrder[] = [];
    const remainingOrders: PaperOrder[] = [];

    for (const [orderId, order] of this.pendingOrders) {
      if (order.symbol !== symbol || order.status !== 'pending') {
        if (order.symbol === symbol) {
          remainingOrders.push(order);
        }
        continue;
      }

      if (order.type === 'market') {
        const fillResult = this.matchMarketOrder(order, orderBook, slippageModel);
        if (fillResult.filled) {
          filledOrders.push(fillResult.order);
        } else {
          remainingOrders.push(order);
        }
      } else if (order.type === 'limit') {
        const fillResult = this.matchLimitOrder(order, orderBook);
        if (fillResult.filled) {
          filledOrders.push(fillResult.order);
        } else {
          remainingOrders.push(order);
        }
      }
    }

    return { filledOrders, remainingOrders };
  }

  private matchMarketOrder(
    order: PaperOrder,
    orderBook: { bids: OrderBookLevel[]; asks: OrderBookLevel[]; lastUpdateTime: number },
    slippageModel?: SlippageModel
  ): { filled: boolean; order: PaperOrder } {
    const levels = order.side === 'buy' ? orderBook.asks : orderBook.bids;
    let remainingQuantity = order.quantity;
    let totalCost = new Decimal(0);
    let filledQuantity = new Decimal(0);

    for (const level of levels) {
      if (remainingQuantity.lte(0)) break;

      const fillQuantity = Decimal.min(remainingQuantity, level.quantity);
      const fillPrice = slippageModel 
        ? this.applySlippage(level.price, order.side, slippageModel)
        : level.price;

      totalCost = totalCost.add(fillQuantity.mul(fillPrice));
      filledQuantity = filledQuantity.add(fillQuantity);
      remainingQuantity = remainingQuantity.sub(fillQuantity);
    }

    if (filledQuantity.gt(0)) {
      const avgPrice = totalCost.div(filledQuantity);
      order.status = 'filled';
      order.filledQuantity = filledQuantity;
      order.fillPrice = avgPrice;
      order.fillTimestamp = Date.now();
      return { filled: true, order };
    }

    return { filled: false, order };
  }

  private matchLimitOrder(
    order: PaperOrder,
    orderBook: { bids: OrderBookLevel[]; asks: OrderBookLevel[]; lastUpdateTime: number }
  ): { filled: boolean; order: PaperOrder } {
    if (!order.price) {
      return { filled: false, order };
    }

    const levels = order.side === 'buy' ? orderBook.asks : orderBook.bids;
    let canFill = false;

    for (const level of levels) {
      if (order.side === 'buy' && level.price.lte(order.price)) {
        canFill = true;
        break;
      } else if (order.side === 'sell' && level.price.gte(order.price)) {
        canFill = true;
        break;
      }
    }

    if (canFill) {
      return this.matchMarketOrder(order, orderBook);
    }

    return { filled: false, order };
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
