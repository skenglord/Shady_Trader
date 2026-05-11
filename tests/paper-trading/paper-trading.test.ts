import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { PaperTradingStateMachine, PaperTradingState, PaperTradingEvent } from '../../backend/paper-trading/state-machine';
import { OrderBookSimulator, PaperOrder } from '../../backend/paper-trading/order-book';
import { PaperPositionTracker, PaperPosition } from '../../backend/paper-trading/position-tracker';
import { PaperTradingService, PaperTradeRequest } from '../../backend/paper-trading/paper-trading-service';
import { Decimal } from 'decimal.js';

describe('Paper Trading State Machine', () => {
  let stateMachine: PaperTradingStateMachine;

  beforeEach(() => {
    stateMachine = new PaperTradingStateMachine({
      timestamp: Date.now(),
    });
  });

  it('should start in IDLE state', () => {
    assert.strictEqual(stateMachine.getState(), 'IDLE');
  });

  it('should transition from IDLE to PENDING_ORDER on CREATE_ORDER', () => {
    const result = stateMachine.sendEvent('CREATE_ORDER', {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: 1,
      price: 50000,
      leverage: 1,
    });

    assert.strictEqual(result, true);
    assert.strictEqual(stateMachine.getState(), 'PENDING_ORDER');
  });

  it('should not transition without required context', () => {
    const result = stateMachine.sendEvent('CREATE_ORDER', {});
    assert.strictEqual(result, false);
    assert.strictEqual(stateMachine.getState(), 'IDLE');
  });

  it('should transition from PENDING_ORDER to OPEN_POSITION on FILL_ORDER', () => {
    stateMachine.sendEvent('CREATE_ORDER', {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: 1,
      price: 50000,
      leverage: 1,
    });

    const result = stateMachine.sendEvent('FILL_ORDER', {
      positionId: 'test-id',
      price: 50000,
      timestamp: Date.now(),
    });

    assert.strictEqual(result, true);
    assert.strictEqual(stateMachine.getState(), 'OPEN_POSITION');
  });

  it('should transition from PENDING_ORDER to IDLE on CANCEL_ORDER', () => {
    stateMachine.sendEvent('CREATE_ORDER', {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: 1,
      price: 50000,
      leverage: 1,
    });

    const result = stateMachine.sendEvent('CANCEL_ORDER');
    assert.strictEqual(result, true);
    assert.strictEqual(stateMachine.getState(), 'IDLE');
  });

  it('should transition from OPEN_POSITION to PENDING_CLOSE on CLOSE_POSITION', () => {
    stateMachine.sendEvent('CREATE_ORDER', {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: 1,
      price: 50000,
      leverage: 1,
    });
    stateMachine.sendEvent('FILL_ORDER', {
      positionId: 'test-id',
      price: 50000,
      timestamp: Date.now(),
    });

    const result = stateMachine.sendEvent('CLOSE_POSITION', {
      positionId: 'test-id',
    });

    assert.strictEqual(result, true);
    assert.strictEqual(stateMachine.getState(), 'PENDING_CLOSE');
  });

  it('should transition from PENDING_CLOSE to CLOSED on FILL_ORDER', () => {
    stateMachine.sendEvent('CREATE_ORDER', {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: 1,
      price: 50000,
      leverage: 1,
    });
    stateMachine.sendEvent('FILL_ORDER', {
      positionId: 'test-id',
      price: 50000,
      timestamp: Date.now(),
    });
    stateMachine.sendEvent('CLOSE_POSITION', {
      positionId: 'test-id',
    });

    const result = stateMachine.sendEvent('FILL_ORDER', {
      positionId: 'test-id',
      price: 51000,
      timestamp: Date.now(),
    });

    assert.strictEqual(result, true);
    assert.strictEqual(stateMachine.getState(), 'CLOSED');
  });

  it('should transition from OPEN_POSITION to ERROR on ERROR_OCCURRED', () => {
    stateMachine.sendEvent('CREATE_ORDER', {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: 1,
      price: 50000,
      leverage: 1,
    });
    stateMachine.sendEvent('FILL_ORDER', {
      positionId: 'test-id',
      price: 50000,
      timestamp: Date.now(),
    });

    const result = stateMachine.sendEvent('ERROR_OCCURRED', {
      error: 'Test error',
    });

    assert.strictEqual(result, true);
    assert.strictEqual(stateMachine.getState(), 'ERROR');
  });

  it('should transition from ERROR to IDLE on RESET', () => {
    stateMachine.sendEvent('CREATE_ORDER', {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: 1,
      price: 50000,
      leverage: 1,
    });
    stateMachine.sendEvent('FILL_ORDER', {
      positionId: 'test-id',
      price: 50000,
      timestamp: Date.now(),
    });
    stateMachine.sendEvent('ERROR_OCCURRED', {
      error: 'Test error',
    });

    const result = stateMachine.sendEvent('RESET');
    assert.strictEqual(result, true);
    assert.strictEqual(stateMachine.getState(), 'IDLE');
  });

  it('should update price and calculate unrealized P&L', () => {
    stateMachine.sendEvent('CREATE_ORDER', {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: 1,
      price: 50000,
      leverage: 1,
    });
    stateMachine.sendEvent('FILL_ORDER', {
      positionId: 'test-id',
      price: 50000,
      timestamp: Date.now(),
    });

    stateMachine.sendEvent('UPDATE_PRICE', {
      currentPrice: 51000,
    });

    const context = stateMachine.getContext();
    assert.strictEqual(context.currentPrice, 51000);
    assert(context.unrealizedPnl! > 0);
  });

  it('should maintain state history', () => {
    stateMachine.sendEvent('CREATE_ORDER', {
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      amount: 1,
      price: 50000,
      leverage: 1,
    });

    const history = stateMachine.getStateHistory();
    assert(history.length >= 2); // IDLE and PENDING_ORDER
  });

  it('should check if transition is possible', () => {
    assert.strictEqual(stateMachine.canTransition('CREATE_ORDER'), true);
    assert.strictEqual(stateMachine.canTransition('FILL_ORDER'), false);
  });
});

describe('Order Book Simulator', () => {
  let orderBook: OrderBookSimulator;

  beforeEach(() => {
    orderBook = new OrderBookSimulator();
  });

  it('should initialize with order books for common symbols', () => {
    const snapshot = orderBook.getOrderBook('BTC/USDT');
    assert(snapshot !== null);
    assert(snapshot!.bids.length > 0);
    assert(snapshot!.asks.length > 0);
  });

  it('should return top levels', () => {
    const levels = orderBook.getTopLevels('BTC/USDT', 5);
    assert(levels !== null);
    assert.strictEqual(levels!.bids.length, 5);
    assert.strictEqual(levels!.asks.length, 5);
  });

  it('should update order book with new price', () => {
    const before = orderBook.getOrderBook('BTC/USDT')!.midPrice;
    orderBook.updateOrderBook('BTC/USDT', 55000);
    const after = orderBook.getOrderBook('BTC/USDT')!.midPrice;
    assert(after.toNumber() > 0);
  });

  it('should add and retrieve paper order', () => {
    const order: PaperOrder = {
      id: 'test-order',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      quantity: new Decimal(1),
      timeInForce: 'GTC',
      timestamp: Date.now(),
      status: 'pending',
    };

    const orderId = orderBook.addPaperOrder(order);
    assert.strictEqual(orderId, 'test-order');

    const retrieved = orderBook.getPaperOrder('test-order');
    assert(retrieved !== undefined);
    assert.strictEqual(retrieved!.symbol, 'BTC/USDT');
  });

  it('should cancel paper order', () => {
    const order: PaperOrder = {
      id: 'test-order',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      quantity: new Decimal(1),
      timeInForce: 'GTC',
      timestamp: Date.now(),
      status: 'pending',
    };

    orderBook.addPaperOrder(order);
    const result = orderBook.cancelPaperOrder('test-order');
    assert.strictEqual(result, true);

    const retrieved = orderBook.getPaperOrder('test-order');
    assert.strictEqual(retrieved!.status, 'cancelled');
  });

  it('should match market orders', () => {
    const order: PaperOrder = {
      id: 'test-order',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      quantity: new Decimal(0.1),
      timeInForce: 'GTC',
      timestamp: Date.now(),
      status: 'pending',
    };

    orderBook.addPaperOrder(order);
    const { filledOrders } = orderBook.matchOrders('BTC/USDT');
    
    assert(filledOrders.length > 0);
    assert.strictEqual(filledOrders[0].status, 'filled');
    assert(filledOrders[0].filledQuantity!.gt(0));
  });

  it('should match limit orders when price is right', () => {
    const snapshot = orderBook.getOrderBook('BTC/USDT')!;
    const midPrice = snapshot.midPrice.toNumber();

    const order: PaperOrder = {
      id: 'test-order',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      quantity: new Decimal(0.1),
      price: new Decimal(midPrice * 1.01), // Above market
      timeInForce: 'GTC',
      timestamp: Date.now(),
      status: 'pending',
    };

    orderBook.addPaperOrder(order);
    const { filledOrders } = orderBook.matchOrders('BTC/USDT');
    
    // Should fill because limit price is above asks
    assert(filledOrders.length > 0);
  });
});

describe('Paper Position Tracker', () => {
  let tracker: PaperPositionTracker;

  beforeEach(() => {
    tracker = new PaperPositionTracker();
  });

  it('should open a position', () => {
    const position = tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      leverage: 1,
    });

    assert.strictEqual(position.symbol, 'BTC/USDT');
    assert.strictEqual(position.side, 'buy');
    assert.strictEqual(position.status, 'open');
    assert.strictEqual(position.quantity.toString(), '1');
  });

  it('should close a position', () => {
    const position = tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      leverage: 1,
    });

    const closed = tracker.closePosition(position.id, new Decimal(51000), Date.now());
    assert(closed !== null);
    assert.strictEqual(closed!.status, 'closed');
    assert(closed!.realizedPnl!.gt(0));
  });

  it('should update position price', () => {
    const position = tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      leverage: 1,
    });

    const updated = tracker.updatePositionPrice(position.id, new Decimal(51000));
    assert(updated !== null);
    assert.strictEqual(updated!.currentPrice!.toString(), '51000');
  });

  it('should calculate P&L correctly for long position', () => {
    const position = tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      leverage: 1,
    });

    const pnl = tracker.calculatePnl(position, new Decimal(51000));
    assert(pnl.unrealizedPnl.gt(0));
    assert(pnl.pnlPercentage.gt(0));
  });

  it('should calculate P&L correctly for short position', () => {
    const position = tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'sell',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      leverage: 1,
    });

    const pnl = tracker.calculatePnl(position, new Decimal(49000));
    assert(pnl.unrealizedPnl.gt(0));
  });

  it('should check stop loss', () => {
    const position = tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      stopLoss: new Decimal(49000),
      leverage: 1,
    });

    assert.strictEqual(tracker.checkStopLoss(position.id, new Decimal(48000)), true);
    assert.strictEqual(tracker.checkStopLoss(position.id, new Decimal(49500)), false);
  });

  it('should check take profit', () => {
    const position = tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      takeProfit: new Decimal(51000),
      leverage: 1,
    });

    assert.strictEqual(tracker.checkTakeProfit(position.id, new Decimal(52000)), true);
    assert.strictEqual(tracker.checkTakeProfit(position.id, new Decimal(50500)), false);
  });

  it('should detect liquidation', () => {
    const position = tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      leverage: 10,
    });

    // Large loss should trigger liquidation
    const isLiquidated = tracker.checkLiquidation(position, new Decimal(40000));
    assert.strictEqual(isLiquidated, true);
  });

  it('should increment candles held', () => {
    const position = tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      leverage: 1,
    });

    const updated = tracker.incrementCandlesHeld(position.id);
    assert.strictEqual(updated!.candlesHeld, 1);
  });

  it('should get open positions', () => {
    tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      leverage: 1,
    });

    tracker.openPosition({
      symbol: 'ETH/USDT',
      side: 'sell',
      quantity: new Decimal(10),
      entryPrice: new Decimal(3000),
      leverage: 1,
    });

    const openPositions = tracker.getOpenPositions();
    assert.strictEqual(openPositions.length, 2);
  });

  it('should get total unrealized P&L', () => {
    tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      leverage: 1,
    });

    const totalPnl = tracker.getTotalUnrealizedPnl();
    assert(totalPnl instanceof Decimal);
  });

  it('should get position count', () => {
    tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(50000),
      leverage: 1,
    });

    const count = tracker.getPositionCount();
    assert.strictEqual(count.total, 1);
    assert.strictEqual(count.open, 1);
  });
});

describe('Paper Trading Service', () => {
  let service: PaperTradingService;

  beforeEach(() => {
    service = new PaperTradingService();
  });

  afterEach(() => {
    service.stop();
  });

  it('should create a paper trade', async () => {
    const request: PaperTradeRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      quantity: 1,
      timeInForce: 'GTC',
      leverage: 1,
    };

    const result = await service.createPaperTrade(request);
    
    assert(result.id);
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.symbol, 'BTC/USDT');
    assert.strictEqual(result.side, 'buy');
  });

  it('should create a limit order', async () => {
    const request: PaperTradeRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      quantity: 1,
      price: 45000,
      timeInForce: 'GTC',
      leverage: 1,
    };

    const result = await service.createPaperTrade(request);
    
    assert(result.id);
    assert.strictEqual(result.price, '45000');
  });

  it('should cancel a paper trade', async () => {
    const request: PaperTradeRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      quantity: 1,
      price: 100000, // Very high price that won't match immediately
      timeInForce: 'GTC',
      leverage: 1,
    };

    const created = await service.createPaperTrade(request);
    const cancelled = await service.cancelPaperTrade(created.id);
    
    assert.strictEqual(cancelled.status, 'cancelled');
  });

  it('should get open positions', async () => {
    const request: PaperTradeRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      quantity: 1,
      timeInForce: 'GTC',
      leverage: 1,
    };

    await service.createPaperTrade(request);
    const positions = await service.getOpenPositions();
    
    assert(positions.length > 0);
  });

  it('should get summary', async () => {
    const summary = await service.getSummary();
    
    assert(summary.totalUnrealizedPnl !== undefined);
    assert(summary.totalRealizedPnl !== undefined);
    assert(summary.positionCount !== undefined);
    assert(Array.isArray(summary.positions));
  });

  it('should get order book snapshot', () => {
    const snapshot = service.getOrderBookSnapshot('BTC/USDT');
    
    assert(snapshot !== null);
    assert(snapshot!.bids.length > 0);
    assert(snapshot!.asks.length > 0);
  });

  it('should handle idempotency', async () => {
    const idempotencyKey = 'test-key-123';
    const request: PaperTradeRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      quantity: 1,
      timeInForce: 'GTC',
      leverage: 1,
      idempotencyKey,
    };

    const first = await service.createPaperTrade(request);
    const second = await service.createPaperTrade(request);
    
    assert.strictEqual(first.id, second.id);
  });

  it('should close position', async () => {
    const request: PaperTradeRequest = {
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      quantity: 1,
      timeInForce: 'GTC',
      leverage: 1,
    };

    const created = await service.createPaperTrade(request);
    
    // Wait a bit for order to potentially fill
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const position = await service.getPosition(created.id);
    if (position && position.status === 'open') {
      const closed = await service.closePosition(
        position.id,
        new Decimal(51000),
        Date.now(),
        'manual_close'
      );
      assert(closed !== null);
    }
  });
});
