import { PaperTradingStateMachine, PaperTradingState, PaperTradingEvent, PaperTradingContext } from './state-machine';
import { OrderBookSimulator, PaperOrder } from './order-book';
import { PaperPositionTracker, PaperPosition, PnlCalculation } from './position-tracker';
import { Decimal } from 'decimal.js';
import { randomUUID, createHash } from 'crypto';
import type { PaperTradingStateStore } from './state-store.js';

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
  status: 'pending' | 'partially_filled' | 'filled' | 'cancelled' | 'expired';
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
  private pendingPositions = new Map<string, Omit<PaperPosition, 'id' | 'status' | 'candlesHeld' | 'openedAt'>>();
  private idempotencyCache: Map<string, IdempotencyRecord> = new Map();
  private operationQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private stateStore?: PaperTradingStateStore;
  private readonly IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private orderMatchingInterval: NodeJS.Timeout | null = null;
  private priceUpdateInterval: NodeJS.Timeout | null = null;
  private idempotencyCleanupInterval: NodeJS.Timeout | null = null;

  constructor(private readonly getExchange?: () => { getOrderBook(symbol: string, limit?: number): Promise<{ symbol: string; timestamp: number; bids: [number, number][]; asks: [number, number][] }> | null }) {
    this.orderBook = new OrderBookSimulator();
    this.positionTracker = new PaperPositionTracker();
    this.startOrderMatching();
    this.startLiveBookUpdates();
    this.startIdempotencyCleanup();
  }

  public stop(): void {
    this.stopped = true;
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

  private runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.operationQueue.then(async () => {
      const before = this.snapshot();
      const booksBefore = this.orderBook.snapshotBooks();
      try {
        const result = await work();
        const after = this.snapshot();
        if (this.stateStore && after !== before) await this.stateStore.save(after);
        return result;
      } catch (error) {
        this.restore(before);
        this.orderBook.restoreBooks(booksBefore);
        throw error;
      }
    });
    this.operationQueue = next.catch(() => undefined);
    return next;
  }

  public async initializeState(store: PaperTradingStateStore): Promise<void> {
    await this.runExclusive(async () => {
      const saved = await store.load();
      if (saved) this.restore(saved);
      this.stateStore = store;
    });
  }

  private snapshot(): string {
    return JSON.stringify({ version: 1, orders: this.orderBook.getOrders(), positions: this.positionTracker.snapshot(),
      pending: [...this.pendingPositions], idempotency: [...this.idempotencyCache] });
  }

  private restore(snapshot: string): void {
    const state = JSON.parse(snapshot);
    if (state.version !== 1 || !['orders', 'positions', 'pending', 'idempotency'].every(key => Array.isArray(state[key]))) {
      throw new Error('Invalid saved paper account');
    }
    const decimals = (row: any, fields: string[]) => {
      const value = { ...row };
      for (const field of fields) if (value[field] != null) {
        value[field] = new Decimal(value[field]);
        if (!value[field].isFinite()) throw new Error('Invalid saved paper amount');
      }
      return value;
    };
    const orders: PaperOrder[] = state.orders.map((row: any) => decimals(row, ['quantity', 'price', 'filledQuantity', 'fillPrice']));
    const positions: PaperPosition[] = state.positions.map((row: any) => decimals(row, ['quantity', 'entryPrice', 'currentPrice', 'stopLoss', 'takeProfit', 'realizedPnl', 'unrealizedPnl']));
    this.orderBook.restoreOrders(orders);
    this.positionTracker.restore(positions);
    this.pendingPositions = new Map(state.pending.map(([id, row]: [string, any]) => [id, decimals(row, ['quantity', 'entryPrice', 'stopLoss', 'takeProfit'])]));
    this.idempotencyCache = new Map(state.idempotency);
    this.stateMachines.clear();
    for (const order of orders) {
      const machine = new PaperTradingStateMachine({ positionId: order.id, symbol: order.symbol, side: order.side,
        amount: order.quantity.toNumber(), price: (order.fillPrice || order.price)?.toNumber(), timestamp: order.timestamp });
      machine.sendEvent('CREATE_ORDER');
      if (order.filledQuantity?.gt(0)) machine.sendEvent('FILL_ORDER', { positionId: order.id, price: order.fillPrice?.toNumber(), timestamp: order.fillTimestamp || order.timestamp });
      else if (order.status === 'cancelled') machine.sendEvent('CANCEL_ORDER');
      this.stateMachines.set(order.id, machine);
    }
  }

  private matchPendingOrders(symbol: string): void {
    const { filledOrders } = this.orderBook.matchOrders(symbol);
    for (const order of filledOrders) this.handleOrderFill(order);
    for (const order of this.orderBook.getOrders()) {
      if (order.symbol === symbol && order.status === 'cancelled') {
        this.pendingPositions.delete(order.id);
        if (!order.filledQuantity?.gt(0)) this.stateMachines.get(order.id)?.sendEvent('CANCEL_ORDER');
      }
    }
  }

  private startOrderMatching(): void {
    this.orderMatchingInterval = setInterval(() => {
      void this.runExclusive(() => {
        if (this.stopped) return;
        for (const symbol of new Set(this.orderBook.getOrders().map(order => order.symbol))) this.matchPendingOrders(symbol);
      }).catch(() => undefined);
    }, 100);
    this.orderMatchingInterval.unref();
  }

  private startLiveBookUpdates(): void {
    const refresh = async () => {
      const exchange = this.getExchange?.();
      if (!exchange) return;
      const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
      for (const symbol of symbols) {
        if (this.stopped) return;
        try {
          const snapshot = await exchange.getOrderBook(symbol, 10);
          if (!snapshot) continue;
          await this.runExclusive(async () => {
          if (this.stopped) return;
          if (snapshot.symbol !== symbol || !this.orderBook.updateOrderBook(snapshot)) return;
          const acceptedBook = this.orderBook.getOrderBook(symbol);
          if (!acceptedBook) return;
          const newPrice = acceptedBook.midPrice;
          const positionUpdates = this.positionTracker.updatePositionPriceBySymbol(symbol, newPrice, Date.now());
          for (const { position, liquidated } of positionUpdates) {
            if (liquidated) {
              this.orderBook.cancelPaperOrder(position.id);
              this.pendingPositions.delete(position.id);
              this.stateMachines.get(position.id)?.sendEvent('LIQUIDATE_POSITION', {
                positionId: position.id, price: newPrice.toNumber(), timestamp: Date.now(),
              });
              continue;
            }
            if (this.positionTracker.checkStopLoss(position.id, newPrice)) {
              await this.closePositionInternal(position.id, newPrice, Date.now(), 'stop_loss');
            } else if (this.positionTracker.checkTakeProfit(position.id, newPrice)) {
              await this.closePositionInternal(position.id, newPrice, Date.now(), 'take_profit');
            }
          }
          });
        } catch { /* Missing live depth pauses matching for this symbol. */ }
        }
    };
    this.priceUpdateInterval = setInterval(() => { void refresh(); }, 5_000);
    this.priceUpdateInterval.unref();
    void refresh();
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

    // A position is created only after a real simulator fill, using the
    // actually filled size and volume-weighted entry price.
    const pending = this.pendingPositions.get(order.id);
    if (pending && order.fillPrice && order.filledQuantity?.gt(0)) {
      const existing = this.positionTracker.getPosition(order.id);
      if (existing) {
        this.positionTracker.updatePositionFill(order.id, order.filledQuantity, order.fillPrice);
      } else this.positionTracker.openPosition({
        ...pending,
        id: order.id,
        quantity: order.filledQuantity,
        entryPrice: order.fillPrice,
        currentPrice: order.fillPrice,
      });
      if (order.status !== 'partially_filled') this.pendingPositions.delete(order.id);
    }
  }

  public createPaperTrade(request: PaperTradeRequest): Promise<PaperTradeResponse> {
    return this.runExclusive(() => this.createPaperTradeInternal(request));
  }

  private async createPaperTradeInternal(request: PaperTradeRequest): Promise<PaperTradeResponse> {
    this.validateRequest(request);
    if (request.idempotencyKey) {
      const cached = this.checkIdempotency(request.idempotencyKey, { operation: 'create', ...request });
      if (cached) return cached;
    }
    await this.refreshBook(request.symbol);

    const orderId = randomUUID();
    const quantity = new Decimal(request.quantity);
    const price = request.price ? new Decimal(request.price) : undefined;

    // Create state machine
    const stateMachine = new PaperTradingStateMachine({
      positionId: orderId,
      symbol: request.symbol,
      side: request.side,
      amount: request.quantity,
      price: request.price || this.orderBook.getOrderBook(request.symbol)!.midPrice.toNumber(),
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

    this.pendingPositions.set(orderId, {
      symbol: request.symbol,
      side: request.side,
      quantity,
      entryPrice: price || new Decimal(0),
      stopLoss: request.stopLoss ? new Decimal(request.stopLoss) : undefined,
      takeProfit: request.takeProfit ? new Decimal(request.takeProfit) : undefined,
      leverage: request.leverage || 1,
    });

    // Trigger order creation
    stateMachine.sendEvent('CREATE_ORDER');

    if (request.timeInForce !== 'GTC') this.matchPendingOrders(request.symbol);
    const response: PaperTradeResponse = {
      id: orderId,
      status: paperOrder.status,
      filledQuantity: paperOrder.filledQuantity?.toString(),
      fillPrice: paperOrder.fillPrice?.toString(),
      symbol: request.symbol,
      side: request.side,
      quantity: quantity.toString(),
      price: price?.toString(),
      timestamp: Date.now(),
    };

    // Cache idempotency
    if (request.idempotencyKey) {
      this.cacheIdempotency(request.idempotencyKey, { operation: 'create', ...request }, response);
    }

    return response;
  }

  public cancelPaperTrade(positionId: string, idempotencyKey?: string): Promise<PaperTradeResponse> {
    return this.runExclusive(() => this.cancelPaperTradeInternal(positionId, idempotencyKey));
  }

  private async cancelPaperTradeInternal(positionId: string, idempotencyKey?: string): Promise<PaperTradeResponse> {
    // Check idempotency
    if (idempotencyKey) {
      const cached = this.checkIdempotency(idempotencyKey, { operation: 'cancel', positionId });
      if (cached) {
        return cached;
      }
    }

    const stateMachine = this.stateMachines.get(positionId);
    const order = this.orderBook.getPaperOrder(positionId);

    if (!stateMachine || !order) {
      throw new Error('Order not found');
    }

    if (!['pending', 'partially_filled'].includes(order.status)) {
      throw new Error('Order cannot be cancelled in current state');
    }

    if (!order.filledQuantity?.gt(0)) stateMachine.sendEvent('CANCEL_ORDER');
    this.orderBook.cancelPaperOrder(positionId);
    this.pendingPositions.delete(positionId);

    const response: PaperTradeResponse = {
      id: positionId,
      status: 'cancelled',
      filledQuantity: order.filledQuantity?.toString(),
      fillPrice: order.fillPrice?.toString(),
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity.toString(),
      price: order.price?.toString(),
      timestamp: Date.now(),
    };

    if (idempotencyKey) {
      this.cacheIdempotency(idempotencyKey, { operation: 'cancel', positionId }, response);
    }

    return response;
  }

  public closePosition(positionId: string, currentPrice: Decimal, timestamp: number, reason?: string): Promise<PaperPosition | null> {
    return this.runExclusive(() => this.closePositionInternal(positionId, currentPrice, timestamp, reason));
  }

  private async closePositionInternal(positionId: string, currentPrice: Decimal, timestamp: number, reason?: string): Promise<PaperPosition | null> {
    if (!currentPrice.isFinite() || currentPrice.lte(0)) throw new Error('Invalid close price');
    this.orderBook.cancelPaperOrder(positionId);
    this.pendingPositions.delete(positionId);
    const position = this.positionTracker.closePosition(positionId, currentPrice, timestamp, reason || 'manual_close');
    
    if (position) {
      const stateMachine = this.stateMachines.get(positionId);
      if (stateMachine) {
        stateMachine.sendEvent('CLOSE_POSITION', {
          positionId,
          price: currentPrice.toNumber(),
          timestamp,
        });
        stateMachine.sendEvent('FILL_ORDER', {
          positionId,
          price: currentPrice.toNumber(),
          timestamp,
        });
      }
    }

    return position;
  }

  public async getPosition(positionId: string): Promise<PositionResponse | null> {
    await this.operationQueue;
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
      unrealizedPnl: pnl.unrealizedPnl.toString(),
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
    await this.operationQueue;
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
        unrealizedPnl: pnl.unrealizedPnl.toString(),
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

    if (Date.now() > record.expiresAt) {
      this.idempotencyCache.delete(key);
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
    const canonical = Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'idempotencyKey').sort(([a], [b]) => a.localeCompare(b)));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  private validateRequest(request: PaperTradeRequest): void {
    if (!request.symbol || !['buy', 'sell'].includes(request.side) || !['market', 'limit'].includes(request.type) || !['GTC', 'IOC', 'FOK'].includes(request.timeInForce)) throw new Error('Invalid paper order');
    for (const value of [request.quantity, request.price, request.stopLoss, request.takeProfit]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('Invalid paper order number');
    }
    if (request.type === 'limit' && request.price === undefined) throw new Error('Limit orders require a price');
    if (request.leverage !== undefined && (!Number.isFinite(request.leverage) || request.leverage < 1 || request.leverage > 100)) throw new Error('Invalid leverage');
  }

  private async refreshBook(symbol: string): Promise<void> {
    const exchange = this.getExchange?.();
    if (!exchange) throw new Error('Live market depth is unavailable; paper order was not accepted');
    const liveBook = await exchange.getOrderBook(symbol, 10);
    if (!liveBook || liveBook.symbol !== symbol || Date.now() - liveBook.timestamp > 15_000) throw new Error('Live market depth is unavailable or stale');
    this.orderBook.updateOrderBook(liveBook);
  }

  public async getOrder(orderId: string): Promise<PaperTradeResponse | null> {
    await this.operationQueue;
    const order = this.orderBook.getPaperOrder(orderId);
    return order ? this.orderResponse(order) : null;
  }

  private orderResponse(order: PaperOrder): PaperTradeResponse {
    return { id: order.id, symbol: order.symbol, side: order.side, status: order.status,
      quantity: order.quantity.toString(), price: order.price?.toString(), filledQuantity: order.filledQuantity?.toString(),
      fillPrice: order.fillPrice?.toString(), timestamp: order.timestamp };
  }

  public closePaperPosition(positionId: string, idempotencyKey?: string): Promise<PaperPosition> {
    return this.runExclusive(async () => {
      const closeRequest = { operation: 'close', positionId };
      if (idempotencyKey) {
        const cached = this.checkIdempotency(idempotencyKey, closeRequest);
        if (cached) return this.positionTracker.getPosition(positionId)!;
      }
      const position = this.positionTracker.getPosition(positionId);
      if (!position) throw new Error('Position not found');
      if (position.status !== 'open') throw new Error('Position is already closed');
      await this.refreshBook(position.symbol);
      this.orderBook.cancelPaperOrder(positionId);
      this.pendingPositions.delete(positionId);
      const closeOrder: PaperOrder = { id: randomUUID(), symbol: position.symbol, side: position.side === 'buy' ? 'sell' : 'buy',
        type: 'market', quantity: position.quantity, timeInForce: 'FOK', timestamp: Date.now(), status: 'pending' };
      this.orderBook.addPaperOrder(closeOrder);
      // Give existing orders priority and settle their fills before the close.
      this.matchPendingOrders(position.symbol);
      if (closeOrder.status !== 'filled' || !closeOrder.fillPrice) throw new Error('Insufficient live depth to close position');
      const result = (await this.closePositionInternal(positionId, closeOrder.fillPrice, Date.now()))!;
      if (idempotencyKey) this.cacheIdempotency(idempotencyKey, closeRequest, this.orderResponse(closeOrder));
      return result;
    });
  }
}
