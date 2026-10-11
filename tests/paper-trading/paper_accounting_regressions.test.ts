import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { PaperPositionTracker } from '../../backend/paper-trading/position-tracker.js';
import { createPaperTradingTestService } from './book-fixture.js';

describe('paper accounting regressions', () => {
  let service: ReturnType<typeof createPaperTradingTestService> | null = null;
  afterEach(() => { service?.stop(); service = null; });

  test('P&L uses full notional price movement while leverage affects margin and ROI', () => {
    const tracker = new PaperPositionTracker();
    const position = tracker.openPosition({
      symbol: 'BTC/USDT', side: 'buy', quantity: new Decimal(1),
      entryPrice: new Decimal(50_000), leverage: 10,
    });
    const result = tracker.calculatePnl(position, new Decimal(51_000));
    assert.equal(result.unrealizedPnl.toNumber(), 1_000);
    assert.equal(result.marginUsed.toNumber(), 5_000);
    assert.equal(result.roi.toNumber(), 20);
  });

  test('profitable positions are not liquidated and liquidation records its loss', () => {
    const tracker = new PaperPositionTracker();
    const position = tracker.openPosition({
      symbol: 'BTC/USDT', side: 'buy', quantity: new Decimal(1),
      entryPrice: new Decimal(50_000), leverage: 10,
    });
    assert.equal(tracker.checkLiquidation(position, new Decimal(51_000)), false);
    const lossPrice = new Decimal(44_000);
    assert.equal(tracker.checkLiquidation(position, lossPrice), true);
    const liquidated = tracker.liquidatePosition(position.id, lossPrice, Date.now());
    assert.ok(liquidated?.realizedPnl?.lt(0));
    assert.equal(liquidated?.exitReason, 'liquidation');
  });

  test('a pending order has no open position until its fill price and quantity arrive', async () => {
    service = createPaperTradingTestService();
    const created = await service.createPaperTrade({
      symbol: 'BTC/USDT', side: 'buy', type: 'market', quantity: 1, timeInForce: 'GTC', leverage: 1,
    });
    assert.equal((await service.getOpenPositions()).length, 0);
    const orderBook = (service as any).orderBook;
    const order = orderBook.getPaperOrder(created.id);
    order.status = 'filled';
    order.filledQuantity = new Decimal('0.4');
    order.fillPrice = new Decimal('50012');
    order.fillTimestamp = 123456;
    (service as any).handleOrderFill(order);

    const positions = await service.getOpenPositions();
    assert.equal(positions.length, 1);
    assert.equal(positions[0].id, created.id);
    assert.equal(positions[0].entryPrice, '50012');
    assert.equal(positions[0].quantity, '0.4');
  });

  test('closing a position preserves the original entry order fill', async () => {
    service = createPaperTradingTestService();
    const created = await service.createPaperTrade({
      symbol: 'BTC/USDT', side: 'buy', type: 'market', quantity: 1, timeInForce: 'GTC', leverage: 1,
    });
    const orderBook = (service as any).orderBook;
    const order = orderBook.getPaperOrder(created.id);
    order.status = 'filled';
    order.filledQuantity = new Decimal(1);
    order.fillPrice = new Decimal(50_010);
    order.fillTimestamp = 123456;
    (service as any).handleOrderFill(order);
    assert.equal((await service.getPosition(created.id))?.status, 'open');
    const closed = await service.closePosition(created.id, new Decimal(50_100), 123500, 'take_profit');
    assert.ok(closed, 'filled paper position should close');
    assert.equal(order.fillPrice.toString(), '50010');
    const position = await service.getPosition(created.id);
    assert.equal(position?.realizedPnl, '90');
    assert.equal(position?.exitReason, 'take_profit');
  });
});
