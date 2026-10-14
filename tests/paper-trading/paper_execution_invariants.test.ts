import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { OrderBookSimulator, PaperOrder } from '../../backend/paper-trading/order-book.js';
import { PaperPositionTracker } from '../../backend/paper-trading/position-tracker.js';

function order(id: string, overrides: Partial<PaperOrder> = {}): PaperOrder {
  return { id, symbol: 'BTC/USDT', side: 'buy', type: 'limit', quantity: new Decimal(2), price: new Decimal(100), timeInForce: 'GTC', timestamp: Date.now(), status: 'pending', ...overrides };
}

function book(): OrderBookSimulator {
  const result = new OrderBookSimulator();
  result.updateOrderBook({ symbol: 'BTC/USDT', timestamp: Date.now(), bids: [[99, 1], [89, 1]], asks: [[100, 1], [110, 1]] });
  return result;
}

describe('paper execution economic invariants', () => {
  test('buy limits consume only asks at or below the limit and retain the remainder', () => {
    const simulator = book();
    simulator.addPaperOrder(order('buy'));
    const { filledOrders } = simulator.matchOrders('BTC/USDT');
    assert.equal(filledOrders[0].fillPrice!.toString(), '100');
    assert.equal(filledOrders[0].filledQuantity!.toString(), '1');
    assert.equal(filledOrders[0].status, 'partially_filled');
    assert.equal(simulator.matchOrders('BTC/USDT').filledOrders.length, 0);
    assert.equal(simulator.cancelPaperOrder('buy'), true);
  });

  test('sell limits never consume bids below their limit', () => {
    const simulator = book();
    simulator.addPaperOrder(order('sell', { side: 'sell', price: new Decimal(99) }));
    const { filledOrders } = simulator.matchOrders('BTC/USDT');
    assert.equal(filledOrders[0].fillPrice!.toString(), '99');
    assert.equal(filledOrders[0].filledQuantity!.toString(), '1');
  });

  test('competing orders share depth and a repeated snapshot cannot replenish consumed liquidity', () => {
    const simulator = new OrderBookSimulator();
    const snapshot = { symbol: 'BTC/USDT', timestamp: Date.now(), bids: [[99, 1]] as [number, number][], asks: [[100, 1]] as [number, number][] };
    simulator.updateOrderBook(snapshot);
    simulator.addPaperOrder(order('first', { quantity: new Decimal(1) }));
    simulator.addPaperOrder(order('second', { quantity: new Decimal(1) }));
    assert.equal(simulator.matchOrders('BTC/USDT').filledOrders.length, 1);
    simulator.updateOrderBook(snapshot);
    assert.equal(simulator.matchOrders('BTC/USDT').filledOrders.length, 0);
    assert.equal(simulator.getPaperOrder('second')!.filledQuantity, undefined);
  });

  test('FOK cancels without consuming any depth when the eligible quantity is insufficient', () => {
    const simulator = book();
    simulator.addPaperOrder(order('fok', { timeInForce: 'FOK' }));
    simulator.addPaperOrder(order('next', { quantity: new Decimal(1) }));
    const result = simulator.matchOrders('BTC/USDT');
    assert.equal(simulator.getPaperOrder('fok')!.status, 'cancelled');
    assert.equal(simulator.getPaperOrder('fok')!.filledQuantity, undefined);
    assert.deepEqual(result.filledOrders.map(o => o.id), ['next']);
  });

  test('IOC keeps the actual partial fill and cancels its unfilled remainder', () => {
    const simulator = book();
    simulator.addPaperOrder(order('ioc', { timeInForce: 'IOC' }));
    simulator.matchOrders('BTC/USDT');
    const result = simulator.getPaperOrder('ioc')!;
    assert.equal(result.filledQuantity!.toString(), '1');
    assert.equal(result.status, 'cancelled');
    assert.equal(simulator.matchOrders('BTC/USDT').filledOrders.length, 0);
  });

  test('a subsequent fresh snapshot fills only the remainder at a cumulative weighted price', () => {
    const simulator = book();
    simulator.addPaperOrder(order('gtc'));
    simulator.matchOrders('BTC/USDT');
    simulator.updateOrderBook({ symbol: 'BTC/USDT', timestamp: Date.now() + 1, bids: [[98, 1]], asks: [[99, 1]] });
    const result = simulator.matchOrders('BTC/USDT').filledOrders[0];
    assert.equal(result.status, 'filled');
    assert.equal(result.filledQuantity!.toString(), '2');
    assert.equal(result.fillPrice!.toString(), '99.5');
  });

  test('stale depth cannot execute orders even when matching is called directly', () => {
    const simulator = new OrderBookSimulator();
    simulator.updateOrderBook({ symbol: 'BTC/USDT', timestamp: Date.now() - 20_000, bids: [[99, 1]], asks: [[100, 1]] });
    simulator.addPaperOrder(order('stale', { quantity: new Decimal(1) }));
    assert.equal(simulator.matchOrders('BTC/USDT').filledOrders.length, 0);
  });

  test('10x liquidation compares remaining equity with maintenance on current notional', () => {
    const tracker = new PaperPositionTracker();
    const long = tracker.openPosition({ symbol: 'BTC/USDT', side: 'buy', quantity: new Decimal(1), entryPrice: new Decimal(100), leverage: 10 });
    assert.equal(tracker.checkLiquidation(long, new Decimal(99)), false);
    assert.equal(tracker.calculatePnl(long, new Decimal(99)).currentMargin.toString(), '9');
    assert.equal(tracker.checkLiquidation(long, new Decimal(91)), false);
    assert.equal(tracker.checkLiquidation(long, new Decimal(90.4)), true);
    const short = tracker.openPosition({ symbol: 'BTC/USDT', side: 'sell', quantity: new Decimal(1), entryPrice: new Decimal(100), leverage: 10 });
    assert.equal(tracker.checkLiquidation(short, new Decimal(101)), false);
    assert.equal(tracker.checkLiquidation(short, new Decimal(109)), false);
    assert.equal(tracker.checkLiquidation(short, new Decimal(109.5)), true);
  });
});
