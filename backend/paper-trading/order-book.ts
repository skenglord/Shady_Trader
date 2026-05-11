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

  constructor() {
    this.initializeOrderBooks();
  }

  private initializeOrderBooks(): void {
    // Initialize with common trading pairs
    const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
    
    for (const symbol of symbols) {
      this.orderBooks.set(symbol, {
        bids: this.generateInitialLevels(100000, true),
        asks: this.generateInitialLevels(100000, false),
        lastUpdateTime: Date.now(),
      });
    }
  }

  private generateInitialLevels(midPrice: number, isBid: boolean): OrderBookLevel[] {
    const levels: OrderBookLevel[] = [];
    const baseQuantity = new Decimal(10);
    
    for (let i = 0; i < this.MAX_LEVELS; i++) {
      const priceOffset = (i + 1) * 0.001 * midPrice; // 0.1% per level
      const price = isBid 
        ? new Decimal(midPrice - priceOffset)
        : new Decimal(midPrice + priceOffset);
      
      const quantityMultiplier = Math.max(0.1, 1 - i * 0.1);
      const quantity = baseQuantity.mul(new Decimal(quantityMultiplier));
      
      levels.push({
        price,
        quantity,
      });
    }
    
    return levels;
  }

  public updateOrderBook(symbol: string, currentPrice: number, volatility: number = 0.02): void {
    const orderBook = this.orderBooks.get(symbol);
    if (!orderBook) {
      // Initialize new symbol
      const newBook = {
        bids: this.generateInitialLevels(currentPrice, true),
        asks: this.generateInitialLevels(currentPrice, false),
        lastUpdateTime: Date.now(),
      };
      this.orderBooks.set(symbol, newBook);
      return;
    }

    // Simulate market movement
    const priceChange = currentPrice * volatility * (Math.random() - 0.5) * 0.1;
    const newMidPrice = currentPrice + priceChange;

    // Update bid levels
    orderBook.bids = orderBook.bids.map((level, index) => {
      const newPrice = new Decimal(newMidPrice - (index + 1) * 0.001 * newMidPrice);
      const quantityChange = 1 + (Math.random() - 0.5) * 0.2;
      return {
        price: newPrice,
        quantity: level.quantity.mul(new Decimal(Math.max(0.1, quantityChange))),
      };
    });

    // Update ask levels
    orderBook.asks = orderBook.asks.map((level, index) => {
      const newPrice = new Decimal(newMidPrice + (index + 1) * 0.001 * newMidPrice);
      const quantityChange = 1 + (Math.random() - 0.5) * 0.2;
      return {
        price: newPrice,
        quantity: level.quantity.mul(new Decimal(Math.max(0.1, quantityChange))),
      };
    });

    orderBook.lastUpdateTime = Date.now();
  }

  public getOrderBook(symbol: string): OrderBookSnapshot | null {
    const orderBook = this.orderBooks.get(symbol);
    if (!orderBook) {
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
    if (!orderBook) {
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
