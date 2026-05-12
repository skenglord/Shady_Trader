import { PaperTradingStateMachine, PaperTradingState, PaperTradingEvent, PaperTradingContext } from './state-machine';
import { OrderBookSimulator, PaperOrder } from './order-book';
import { PaperPositionTracker, PaperPosition, PnlCalculation } from './position-tracker';
import { Decimal } from 'decimal.js';
import { randomUUID } from 'crypto';

export interface PaperTradeRequest {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  quantity: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage?: number;
  timeInForce: 'GTC' | 'IOC' | 'FOK';
  idempotencyKey?: string;
}

export interface PaperTradeResponse {
  id: string;
  status: 'pending' | 'filled' | 'cancelled' | 'expired';
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  price?: string;
  filledQuantity?: string;
  fillPrice?: string;
  timestamp: number;
  pnl?: string;
}

export interface PositionResponse {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  entryPrice: string;
  currentPrice?: string;
  stopLoss?: string;
  takeProfit?: string;
  leverage: number;
  status: 'open' | 'closed' | 'liquidated';
  unrealizedPnl?: string;
  realizedPnl?: string;
  pnlPercentage?: string;
  roi?: string;
  openedAt: number;
  closedAt?: number;
  candlesHeld: number;
  exitReason?: string;
}

export interface PaperTradingSummary {
  totalUnrealizedPnl: string;
  totalRealizedPnl: string;
  totalMarginUsed: string;
  positionCount: {
    total: number;
    open: number;
    closed: number;
    liquidated: number;
  };
  positions: PositionResponse[];
}

export interface IdempotencyRecord {
  key: string;
  requestHash: string;
  response: any;
  timestamp: number;
  expiresAt: number;
}

export class PaperTradingService {
  private stateMachines: Map<string, PaperTradingStateMachine> = new Map();
  private orderBook: OrderBookSimulator;
  private positionTracker: PaperPositionTracker;
  private idempotencyCache: Map<string, IdempotencyRecord> = new Map();
  private readonly IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private orderMatchingInterval: NodeJS.Timeout | null = null;
  private priceUpdateInterval: NodeJS.Timeout | null = null;
  private idempotencyCleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.orderBook = new OrderBookSimulator();
    this.positionTracker = new PaperPositionTracker();
    this.startOrderMatching();
    this.startPriceUpdates();
    this.startIdempotencyCleanup();
  }

  public stop(): void {
    if (this.orderMatchingInterval) {
      clearInterval(this.orderMatchingInterval);
      this.orderMatchingInterval = null;
    }
    if (this.priceUpdateInterval) {
      clearInterval(this.priceUpdateInterval);
      this.priceUpdateInterval = null;
    }
    if (this.idempotencyCleanupInterval) {
      clearInterval(this.idempotencyCleanupInterval);
      this.idempotencyCleanupInterval = null;
    }
  }

  private startOrderMatching(): void {
    this.orderMatchingInterval = setInterval(() => {
      // Match orders for all symbols
      const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
      
      for (const symbol of symbols) {
        const orderBook = this.orderBook.getOrderBook(symbol);
        if (orderBook) {
          const { filledOrders } = this.orderBook.matchOrders(symbol);
          
          for (const order of filledOrders) {
            this.handleOrderFill(order);
          }
        }
      }
    }, 100); // Match every 100ms
    this.orderMatchingInterval.unref();
  }

  private startPriceUpdates(): void {
    this.priceUpdateInterval = setInterval(() => {
      // Update prices for all symbols
      const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
      
      for (const symbol of symbols) {
        const orderBook = this.orderBook.getOrderBook(symbol);
        if (orderBook) {
          const currentPrice = orderBook.midPrice.toNumber();
          const volatility = 0.02;
          
          this.orderBook.updateOrderBook(symbol, currentPrice, volatility);
          
          // Update position prices
          const newPrice = new Decimal(currentPrice);
          const positionUpdates = this.positionTracker.updatePositionPriceBySymbol(symbol, newPrice, Date.now());
          
          // Check stop loss and take profit
          for (const { position } of positionUpdates) {
            if (this.positionTracker.checkStopLoss(position.id, newPrice)) {
              this.closePosition(position.id, newPrice, Date.now(), 'stop_loss');
            } else if (this.positionTracker.checkTakeProfit(position.id, newPrice)) {
              this.closePosition(position.id, newPrice, Date.now(), 'take_profit');
            }
          }
        }
      }
    }, 100); // Update every 100ms
    this.priceUpdateInterval.unref();
  }

  private startIdempotencyCleanup(): void {
    this.idempotencyCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.idempotencyCache) {
        if (now > record.expiresAt) {
          this.idempotencyCache.delete(key);
        }
      }
    }, 60 * 60 * 1000); // Clean up every hour
    this.idempotencyCleanupInterval.unref();
  }

  private handleOrderFill(order: PaperOrder): void {
    const stateMachine = this.stateMachines.get(order.id);
    if (stateMachine) {
      stateMachine.sendEvent('FILL_ORDER', {
        positionId: order.id,
        price: order.fillPrice?.toNumber(),
        timestamp: Date.now(),
      });
    }

    // Update position tracker
    if (order.fillPrice && order.filledQuantity) {
      const position = this.positionTracker.getPosition(order.id);
      if (position) {
        this.positionTracker.updatePositionPrice(order.id, order.fillPrice);
      }
    }
  }

  public async createPaperTrade(request: PaperTradeRequest): Promise<PaperTradeResponse> {
    // Check idempotency
    if (request.idempotencyKey) {
      const cached = this.checkIdempotency(request.idempotencyKey, request);
      if (cached) {
        return cached;
      }
    }

    const orderId = randomUUID();
    const quantity = new Decimal(request.quantity);
    const price = request.price ? new Decimal(request.price) : undefined;

    // Create state machine
    const stateMachine = new PaperTradingStateMachine({
      positionId: orderId,
      symbol: request.symbol,
      side: request.side,
      amount: request.quantity,
      price: request.price,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      leverage: request.leverage || 1,
      timestamp: Date.now(),
    });

    this.stateMachines.set(orderId, stateMachine);

    // Create paper order
    const paperOrder: PaperOrder = {
      id: orderId, // Use same ID as position
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity,
      price,
      timeInForce: request.timeInForce,
      timestamp: Date.now(),
      status: 'pending',
    };

    this.orderBook.addPaperOrder(paperOrder);

    // Create position (use same ID as order for simplicity)
    const position = this.positionTracker.openPosition({
      symbol: request.symbol,
      side: request.side,
      quantity,
      entryPrice: price || new Decimal(0), // Will be updated on fill
      stopLoss: request.stopLoss ? new Decimal(request.stopLoss) : undefined,
      takeProfit: request.takeProfit ? new Decimal(request.takeProfit) : undefined,
      leverage: request.leverage || 1,
    });

    // Trigger order creation
    stateMachine.sendEvent('CREATE_ORDER');

    const response: PaperTradeResponse = {
      id: position.id, // Use position ID instead of order ID
      status: 'pending',
      symbol: request.symbol,
      side: request.side,
      quantity: quantity.toString(),
      price: price?.toString(),
      timestamp: Date.now(),
    };

    // Cache idempotency
    if (request.idempotencyKey) {
      this.cacheIdempotency(request.idempotencyKey, request, response);
    }

    return response;
  }

  public async cancelPaperTrade(positionId: string, idempotencyKey?: string): Promise<PaperTradeResponse> {
    // Check idempotency
    if (idempotencyKey) {
      const cached = this.checkIdempotency(idempotencyKey, { positionId });
      if (cached) {
        return cached;
      }
    }

    const stateMachine = this.stateMachines.get(positionId);
    const order = this.orderBook.getPaperOrder(positionId);

    if (!stateMachine || !order) {
      throw new Error('Order not found');
    }

    if (stateMachine.getState() !== 'PENDING_ORDER') {
      throw new Error('Order cannot be cancelled in current state');
    }

    stateMachine.sendEvent('CANCEL_ORDER');
    this.orderBook.cancelPaperOrder(positionId);
    // Remove the pending position
    this.positionTracker.closePosition(positionId, new Decimal(0), Date.now());

    const response: PaperTradeResponse = {
      id: positionId,
      status: 'cancelled',
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity.toString(),
      price: order.price?.toString(),
      timestamp: Date.now(),
    };

    if (idempotencyKey) {
      this.cacheIdempotency(idempotencyKey, { positionId }, response);
    }

    return response;
  }

  public async closePosition(positionId: string, currentPrice: Decimal, timestamp: number, reason?: string): Promise<PaperPosition | null> {
    const position = this.positionTracker.closePosition(positionId, currentPrice, timestamp);
    
    if (position) {
      const stateMachine = this.stateMachines.get(positionId);
      if (stateMachine) {
        stateMachine.sendEvent('CLOSE_POSITION', {
          positionId,
          price: currentPrice.toNumber(),
          timestamp,
        });
      }

      const order = this.orderBook.getPaperOrder(positionId);
      if (order) {
        order.status = 'filled';
        order.fillPrice = currentPrice;
        order.fillTimestamp = timestamp;
      }
    }

    return position;
  }

  public async getPosition(positionId: string): Promise<PositionResponse | null> {
    const position = this.positionTracker.getPosition(positionId);
    if (!position) {
      return null;
    }

    const pnl = this.positionTracker.calculatePnl(position, position.currentPrice || position.entryPrice);

    return {
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity.toString(),
      entryPrice: position.entryPrice.toString(),
      currentPrice: position.currentPrice?.toString(),
      stopLoss: position.stopLoss?.toString(),
      takeProfit: position.takeProfit?.toString(),
      leverage: position.leverage,
      status: position.status,
      unrealizedPnl: position.unrealizedPnl?.toString(),
      realizedPnl: position.realizedPnl?.toString(),
      pnlPercentage: pnl.pnlPercentage.toString(),
      roi: pnl.roi.toString(),
      openedAt: position.openedAt,
      closedAt: position.closedAt,
      candlesHeld: position.candlesHeld,
      exitReason: position.exitReason,
    };
  }

  public async getOpenPositions(): Promise<PositionResponse[]> {
    const positions = this.positionTracker.getOpenPositions();
    
    return positions.map(position => {
      const pnl = this.positionTracker.calculatePnl(position, position.currentPrice || position.entryPrice);
      
      return {
        id: position.id,
        symbol: position.symbol,
        side: position.side,
        quantity: position.quantity.toString(),
        entryPrice: position.entryPrice.toString(),
        currentPrice: position.currentPrice?.toString(),
        stopLoss: position.stopLoss?.toString(),
        takeProfit: position.takeProfit?.toString(),
        leverage: position.leverage,
        status: position.status,
        unrealizedPnl: position.unrealizedPnl?.toString(),
        realizedPnl: position.realizedPnl?.toString(),
        pnlPercentage: pnl.pnlPercentage.toString(),
        roi: pnl.roi.toString(),
        openedAt: position.openedAt,
        closedAt: position.closedAt,
        candlesHeld: position.candlesHeld,
        exitReason: position.exitReason,
      };
    });
  }

  public async getSummary(): Promise<PaperTradingSummary> {
    const positions = await this.getOpenPositions();
    
    const summary: PaperTradingSummary = {
      totalUnrealizedPnl: this.positionTracker.getTotalUnrealizedPnl().toString(),
      totalRealizedPnl: this.positionTracker.getTotalRealizedPnl().toString(),
      totalMarginUsed: this.positionTracker.getTotalMarginUsed().toString(),
      positionCount: this.positionTracker.getPositionCount(),
      positions,
    };

    return summary;
  }

  public getOrderBookSnapshot(symbol: string): any {
    return this.orderBook.getOrderBook(symbol);
  }

  private checkIdempotency(key: string, request: any): PaperTradeResponse | null {
    const record = this.idempotencyCache.get(key);
    if (!record) {
      return null;
    }

    const requestHash = this.hashRequest(request);
    if (record.requestHash !== requestHash) {
      throw new Error('Idempotency key conflict: different request');
    }

    if (Date.now() > record.expiresAt) {
      this.idempotencyCache.delete(key);
      return null;
    }

    return record.response as PaperTradeResponse;
  }

  private cacheIdempotency(key: string, request: any, response: PaperTradeResponse): void {
    const requestHash = this.hashRequest(request);
    
    this.idempotencyCache.set(key, {
      key,
      requestHash,
      response,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.IDEMPOTENCY_TTL,
    });
  }

  private hashRequest(request: any): string {
    // Simple hash function for idempotency
    const str = JSON.stringify(request);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }
}
