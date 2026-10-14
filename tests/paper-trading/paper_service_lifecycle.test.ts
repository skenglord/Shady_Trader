import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { PaperTradingService } from '../../backend/paper-trading/paper-trading-service.js';
import { PaperPositionTracker } from '../../backend/paper-trading/position-tracker.js';

const request = { symbol: 'BTC/USDT', side: 'buy' as const, type: 'limit' as const, price: 100, quantity: 2, timeInForce: 'GTC' as const, idempotencyKey: 'entry' };
function fixture() {
  let unavailable = false;
  let snapshot = { symbol: 'BTC/USDT', timestamp: Date.now(), bids: [[99, 5]] as [number, number][], asks: [[100, 1], [110, 5]] as [number, number][] };
  const service = new PaperTradingService(() => ({ async getOrderBook(symbol) {
    if (unavailable) throw new Error('outage');
    return { ...snapshot, symbol };
  } }));
  return { service, offline() { unavailable = true; }, next() { snapshot = { ...snapshot, timestamp: Date.now() + 1, asks: [[100, 1]] }; } };
}
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('paper state did not converge');
}

test('idempotent retry returns the accepted order through a depth outage', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  const first = await f.service.createPaperTrade(request);
  f.offline();
  const replay = await f.service.createPaperTrade(request);
  assert.equal(replay.id, first.id);
});

test('equivalent request property ordering cannot bypass or conflict with idempotency', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  const first = await f.service.createPaperTrade(request);
  const reversed = Object.fromEntries(Object.entries(request).reverse());
  const second = await f.service.createPaperTrade(reversed as typeof request);
  assert.equal(second.id, first.id);
});

test('a partial order produces one growing position and close cancels the resting remainder', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  const entry = await f.service.createPaperTrade(request);
  await waitFor(async () => !!await f.service.getPosition(entry.id));
  assert.equal((await f.service.getPosition(entry.id))!.quantity, '1');
  const closed = await f.service.closePosition(entry.id, new Decimal(101), Date.now());
  assert.equal(closed!.realizedPnl!.toString(), '1');
  const rest = await (f.service as any).getOrder(entry.id);
  assert.equal(rest.status, 'cancelled');
  f.next();
  await f.service.createPaperTrade({ ...request, quantity: 0.1, idempotencyKey: 'another', price: 1 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await f.service.getPosition(entry.id))!.status, 'closed');
  const summary = await f.service.getSummary();
  assert.equal(summary.totalRealizedPnl, '1');
  assert.equal(summary.totalMarginUsed, '0');
});

test('later fills increase the existing position exactly once at the cumulative entry price', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  const entry = await f.service.createPaperTrade(request);
  await waitFor(async () => !!await f.service.getPosition(entry.id));
  f.next();
  await f.service.createPaperTrade({ ...request, quantity: 0.1, idempotencyKey: 'refresh', price: 1 });
  await waitFor(async () => (await f.service.getPosition(entry.id))?.quantity === '2');
  assert.equal((await f.service.getSummary()).positionCount.open, 1);
  assert.equal((await f.service.getSummary()).totalMarginUsed, '200');
});

test('mark updates publish the same unrealized PnL in position details and totals', () => {
  const tracker = new PaperPositionTracker();
  const position = tracker.openPosition({ symbol: 'BTC/USDT', side: 'buy', quantity: new Decimal(1), entryPrice: new Decimal(100), leverage: 10 });
  tracker.updatePositionPriceBySymbol('BTC/USDT', new Decimal(99), Date.now());
  assert.equal(tracker.getPosition(position.id)!.unrealizedPnl?.toString(), '-1');
  assert.equal(tracker.getTotalUnrealizedPnl().toString(), '-1');
});

test('market closure cancels a partially filled entry before sizing the exit', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  const entry = await f.service.createPaperTrade(request);
  await waitFor(async () => !!await f.service.getPosition(entry.id));
  f.next();
  const closed = await f.service.closePaperPosition(entry.id, 'close');
  assert.equal(closed.quantity.toString(), '1');
  assert.equal(closed.realizedPnl?.toString(), '-1');
  const orders = (f.service as any).orderBook.getOrders();
  assert.equal(orders.find((order: any) => order.id === entry.id).status, 'cancelled');
  assert.equal(orders.find((order: any) => order.id !== entry.id).filledQuantity.toString(), '1');
});

test('failed persistence restores consumed liquidity for a same-snapshot retry', async t => {
  const f = fixture(); t.after(() => f.service.stop());
  let fail = false;
  await f.service.initializeState({ load: async () => null, save: async () => { if (fail) throw new Error('disk unavailable'); } });
  fail = true;
  const order = { ...request, quantity: 1, timeInForce: 'FOK' as const };
  await assert.rejects(f.service.createPaperTrade(order), /disk unavailable/);
  fail = false;
  const retry = await f.service.createPaperTrade(order);
  assert.equal(retry.status, 'filled');
  assert.equal(retry.filledQuantity, '1');
});

test('live refresh ignores older or wrong-symbol marks and cancels entry remainder on liquidation', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const timestamp = Date.now();
  let phase = 'initial';
  const service = new PaperTradingService(() => ({ async getOrderBook(symbol) {
    return { symbol: phase === 'wrong-symbol' ? 'ETH/USDT' : symbol,
      timestamp: timestamp + (phase === 'old' ? -1 : phase === 'initial' ? 0 : 1),
      bids: [[phase === 'initial' ? 99 : 89, 5]], asks: [[phase === 'initial' ? 100 : 90, 1], [110, 5]] };
  } }));
  t.after(() => service.stop());
  const entry = await service.createPaperTrade({ ...request, leverage: 10 });
  t.mock.timers.tick(100);
  await waitFor(async () => !!await service.getPosition(entry.id));
  for (const next of ['old', 'wrong-symbol']) {
    phase = next;
    t.mock.timers.tick(5000);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await service.getPosition(entry.id))?.status, 'open');
  }
  phase = 'fresh';
  t.mock.timers.tick(5000);
  await waitFor(async () => (await service.getPosition(entry.id))?.status === 'liquidated');
  assert.equal((await service.getOrder(entry.id))?.status, 'cancelled');
});

test('paper orders, positions and idempotency survive a restart and failed persistence rolls back', async t => {
  let saved: string | null = null;
  let failSave = false;
  const store = { async load() { return saved; }, async save(value: string) { if (failSave) throw new Error('disk unavailable'); saved = value; } };
  const first = fixture(); t.after(() => first.service.stop());
  await (first.service as any).initializeState(store);
  const entry = await first.service.createPaperTrade({ ...request, type: 'market', quantity: 1, timeInForce: 'FOK' });
  first.service.stop();
  const second = fixture(); t.after(() => second.service.stop());
  await (second.service as any).initializeState(store);
  assert.equal((await second.service.getPosition(entry.id))?.quantity, '1');
  second.offline();
  const replay = await second.service.createPaperTrade({ ...request, type: 'market', quantity: 1, timeInForce: 'FOK' });
  assert.equal(replay.id, entry.id);
  failSave = true;
  await assert.rejects(second.service.closePosition(entry.id, new Decimal(101), Date.now()), /disk unavailable/);
  assert.equal((await second.service.getPosition(entry.id))?.status, 'open');
  failSave = false;
  await second.service.closePosition(entry.id, new Decimal(101), Date.now());
  second.service.stop();
  const third = fixture(); t.after(() => third.service.stop());
  await (third.service as any).initializeState(store);
  assert.equal((await third.service.getSummary()).totalRealizedPnl, '1');
  assert.equal((await third.service.getSummary()).positionCount.open, 0);
});
