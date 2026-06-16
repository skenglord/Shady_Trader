import { describe, test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { Decimal } from 'decimal.js';
import { PaperTradingStateMachine } from '../../backend/paper-trading/state-machine.js';
import { PaperPositionTracker } from '../../backend/paper-trading/position-tracker.js';
import { OrderBookSimulator } from '../../backend/paper-trading/order-book.js';
import { PaperTradingWebSocketHandler } from '../../backend/paper-trading/websocket-handler.js';

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  handlers: Record<string, (payload?: any) => void> = {};

  on(event: string, callback: (payload?: any) => void) {
    this.handlers[event] = callback;
    return this;
  }

  send(payload: string) {
    this.sent.push(payload);
  }
}

describe('Paper trading component behavior', () => {
  test('state machine follows order, position, close, and reset lifecycle', () => {
    const machine = new PaperTradingStateMachine({ timestamp: Date.now() });
    assert.strictEqual(machine.getState(), 'IDLE');
    assert.strictEqual(machine.canTransition('CREATE_ORDER'), true);

    assert.strictEqual(machine.sendEvent('CREATE_ORDER', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 100,
      price: 100,
      leverage: 2,
      timestamp: Date.now(),
    }), true);
    assert.strictEqual(machine.getState(), 'PENDING_ORDER');

    assert.strictEqual(machine.sendEvent('FILL_ORDER', { positionId: 'position-1', timestamp: Date.now() }), true);
    assert.strictEqual(machine.getState(), 'OPEN_POSITION');

    assert.strictEqual(machine.sendEvent('UPDATE_PRICE', { currentPrice: 105, timestamp: Date.now() }), true);
    assert.strictEqual(machine.getContext().unrealizedPnl, 500);

    assert.strictEqual(machine.sendEvent('CLOSE_POSITION', { positionId: 'position-1', timestamp: Date.now() }), true);
    assert.strictEqual(machine.getState(), 'PENDING_CLOSE');

    assert.strictEqual(machine.sendEvent('FILL_ORDER', { positionId: 'position-1', timestamp: Date.now() }), true);
    assert.strictEqual(machine.getState(), 'CLOSED');

    assert.strictEqual(machine.sendEvent('RESET', { timestamp: Date.now() }), true);
    assert.strictEqual(machine.getState(), 'IDLE');
    assert.strictEqual(machine.getContext().symbol, undefined);
    assert.ok(machine.getStateHistory().length > 5);
  });

  test('position tracker calculates PnL, stop-loss, take-profit, and liquidation', () => {
    const tracker = new PaperPositionTracker();
    const position = tracker.openPosition({
      symbol: 'BTC/USDT',
      side: 'buy',
      quantity: new Decimal(1),
      entryPrice: new Decimal(100),
      leverage: 2,
      stopLoss: new Decimal(90),
      takeProfit: new Decimal(120),
    });

    assert.strictEqual(position.status, 'open');
    assert.strictEqual(tracker.getOpenPositions().length, 1);

    const updated = tracker.updatePositionPrice(position.id, new Decimal(110));
    assert.strictEqual(updated?.currentPrice?.toNumber(), 110);
    assert.strictEqual(tracker.calculatePnl(updated!).totalPnl.toNumber(), 5);
    assert.strictEqual(tracker.checkStopLoss(position.id, new Decimal(89)), true);
    assert.strictEqual(tracker.checkTakeProfit(position.id, new Decimal(121)), true);
    assert.strictEqual(tracker.incrementCandlesHeld(position.id)?.candlesHeld, 1);

    const liquidated = tracker.liquidatePosition(position.id, new Decimal(50), Date.now());
    assert.strictEqual(liquidated?.status, 'liquidated');
    assert.strictEqual(tracker.getOpenPositions().length, 0);

    const shortPosition = tracker.openPosition({
      symbol: 'ETH/USDT',
      side: 'sell',
      quantity: new Decimal(2),
      entryPrice: new Decimal(100),
      leverage: 5,
    });
    assert.strictEqual(shortPosition.status, 'open');
    assert.strictEqual(tracker.checkLiquidation(shortPosition, new Decimal(120)), true);
    assert.strictEqual(tracker.checkLiquidation(shortPosition, new Decimal(160)), true);
    assert.strictEqual(tracker.calculatePnl(shortPosition, new Decimal(90)).totalPnl.toNumber(), 4);
  });

  test('order book initializes, updates, and matches market orders with slippage', () => {
    const book = new OrderBookSimulator();
    const snapshot = book.getOrderBook('BTC/USDT');
    assert.ok(snapshot);
    assert.strictEqual(snapshot?.symbol, 'BTC/USDT');
    assert.strictEqual(snapshot?.bids.length, 10);
    assert.strictEqual(snapshot?.asks.length, 10);
    assert.ok(snapshot!.spread.gt(0));

    const levels = book.getTopLevels('BTC/USDT', 3);
    assert.ok(levels);
    assert.strictEqual(levels?.bids.length, 3);
    assert.strictEqual(levels?.asks.length, 3);

    book.updateOrderBook('ETH/USDT', 2000);
    assert.ok(book.getOrderBook('ETH/USDT'));
    assert.strictEqual(book.getOrderBook('missing'), null);

    const order = book.addPaperOrder({
      id: '',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      quantity: new Decimal(1),
      timeInForce: 'IOC',
      timestamp: Date.now(),
      status: 'pending',
    });

    const match = book.matchOrders('BTC/USDT', { slippagePercent: 1, volatilityImpact: 0, liquidityImpact: 0 });
    assert.strictEqual(match.filledOrders.length, 1);
    assert.strictEqual(match.remainingOrders.length, 0);
    assert.strictEqual(match.filledOrders[0].status, 'filled');
    assert.ok(match.filledOrders[0].fillPrice!.gt(book.getOrderBook('BTC/USDT')!.asks[0].price));
    assert.strictEqual(book.getPaperOrder(order)?.status, 'filled');
    assert.strictEqual(book.cancelPaperOrder('missing'), false);
  });

  test('paper trading websocket sends initial data, handles subscriptions, and cleans clients', async () => {
    const service = {
      async getOpenPositions() {
        return [{ id: 'position-1', symbol: 'BTC/USDT' }];
      },
      async getSummary() {
        return {
          totalUnrealizedPnl: 12.5,
          totalRealizedPnl: 7.5,
          positionCount: 1,
        };
      },
    };

    const handler = new PaperTradingWebSocketHandler(service as any);
    const ws = new FakeWebSocket();

    handler.handleConnection(ws as any, 'client-1');
    await wait(5);

    assert.strictEqual(handler.getClientCount(), 1);
    assert.ok(ws.sent.some((message) => JSON.parse(message).type === 'paper_position_update'));
    assert.ok(ws.sent.some((message) => JSON.parse(message).type === 'paper_pnl_update'));

    ws.handlers.message(JSON.stringify({ type: 'subscribe_paper_pnl' }));
    assert.ok(ws.sent.some((message) => {
      const parsed = JSON.parse(message);
      return parsed.type === 'paper_pnl_update' && parsed.data?.subscribed === true;
    }));

    ws.handlers.message('not-json');
    assert.ok(ws.sent.some((message) => JSON.parse(message).type === 'paper_error'));

    handler.stopUpdates();
    ws.handlers.close();
    assert.strictEqual(handler.getClientCount(), 0);
  });
});
